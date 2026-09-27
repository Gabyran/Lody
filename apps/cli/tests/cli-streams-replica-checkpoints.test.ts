/**
 * The daemon and one-shot CLI commands open the same `repo.sqlite3` with their
 * own in-memory replicas. Meta/Flock Streams progress must therefore belong to
 * the replica that loaded it: a process that hydrated before another process
 * advanced data and cursor has to bootstrap, not resume at that tail.
 *
 * Drives the real CLI composition (`createCliSqliteRepoStore` +
 * `createCliStreamsTransport` + `LoroRepo`) against a scripted Streams server.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Flock } from '@loro-dev/flock-wasm';
import { getLoroMetaStreamId, type WorkspaceId } from '@lody/shared';
import type { LoroStreamsTokenProvider } from '@lody/platform';
import { LoroRepo } from 'loro-repo';
import {
  createCliSqliteRepoStore,
  type CliSqliteRepoStore,
} from '../src/lib/loro/sqlite-repo-store';
import { createCliStreamsTransport } from '../src/lib/loro/streams-transport';
import type { Logger } from '../src/utils/logger';

const workspaceId = 'ws-replica-checkpoints' as WorkspaceId;
const gatewayBaseUrl = 'https://streams.checkpoint.invalid';
const tail100 = '00000000000000000100';
const keyA = ['m', 'doc-a', 'title'];

const silentLogger = new Proxy({}, { get: () => () => {} }) as Logger;

const tokenProvider = {
  getToken: async () => 'streams-jwt',
  getGatewayBaseUrl: () => gatewayBaseUrl,
  getShardHostSuffix: () => undefined,
  invalidate: () => {},
  createAuthCallback: () => async () => 'streams-jwt',
} as unknown as LoroStreamsTokenProvider;

const toArrayBuffer = (value: Uint8Array): ArrayBuffer => value.slice().buffer as ArrayBuffer;

/** Meta stream holding `A` at offset 100; catch-up from 100 has nothing new. */
function createMetaServer() {
  const server = new Flock('server');
  server.put(keyA, 'A');
  const snapshot = server.exportFile();
  const requests: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requests.push(url);
      if (init?.method === 'POST') {
        const headers = new Headers(init.headers);
        return new Response(null, {
          headers: {
            'Producer-Epoch': headers.get('Producer-Epoch') ?? '0',
            'Producer-Seq': headers.get('Producer-Seq') ?? '0',
            'Stream-Next-Offset': tail100,
            'Stream-Up-To-Date': 'true',
          },
        });
      }
      if (url.pathname.endsWith('/bootstrap')) {
        return new Response(
          new Blob([
            '--cp\r\nContent-Type: application/octet-stream\r\n\r\n',
            toArrayBuffer(snapshot),
            '\r\n--cp--\r\n',
          ]),
          {
            headers: {
              'Content-Type': 'multipart/mixed; boundary=cp',
              'Stream-Snapshot-Offset': tail100,
              'Stream-Next-Offset': tail100,
              'Stream-Up-To-Date': 'true',
            },
          }
        );
      }
      return new Response(null, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Stream-Next-Offset': url.searchParams.get('offset') ?? tail100,
          'Stream-Up-To-Date': 'true',
        },
      });
    })
  );
  const bootstraps = () => requests.filter((url) => url.pathname.endsWith('/bootstrap')).length;
  return { bootstraps };
}

type CliProcess = { store: CliSqliteRepoStore; repo: LoroRepo };

let dataDir: string;
const openProcesses = new Set<CliProcess>();
const originalDataDir = process.env.LODY_DATA_DIR;

/** One daemon or one-shot command: its own connection and in-memory replica. */
async function openCliProcess(): Promise<CliProcess> {
  const store = await createCliSqliteRepoStore(workspaceId);
  const repo = await LoroRepo.create({
    storageAdapter: store.storageAdapter,
    metaDebounceCommitMs: 0,
  });
  const cliProcess = { store, repo };
  openProcesses.add(cliProcess);
  return cliProcess;
}

async function closeCliProcess(cliProcess: CliProcess): Promise<void> {
  openProcesses.delete(cliProcess);
  await cliProcess.repo.destroy();
  cliProcess.store.sqliteStore.close();
}

async function syncMeta(cliProcess: CliProcess) {
  const { adapter } = await createCliStreamsTransport({
    workspaceId,
    tokenProvider,
    repo: cliProcess.repo,
    documentRemoteCursorStore: cliProcess.store.documentRemoteCursorStore,
    logger: silentLogger,
  });
  try {
    return await adapter.syncMeta(cliProcess.repo.getMeta());
  } finally {
    await adapter.close();
  }
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-replica-checkpoints-'));
  process.env.LODY_DATA_DIR = dataDir;
});

afterEach(async () => {
  for (const cliProcess of [...openProcesses]) await closeCliProcess(cliProcess);
  vi.unstubAllGlobals();
  if (originalDataDir === undefined) delete process.env.LODY_DATA_DIR;
  else process.env.LODY_DATA_DIR = originalDataDir;
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('CLI Streams checkpoints are bound to the replica that loaded them', () => {
  it('bootstraps a process that hydrated before another process advanced the shared file', async () => {
    const server = createMetaServer();
    // The one-shot command opens first, while the file is still empty.
    const oneShot = await openCliProcess();
    const daemon = await openCliProcess();

    expect((await syncMeta(daemon)).ok).toBe(true);
    expect(daemon.repo.getMeta().get(keyA)).toBe('A');
    expect(server.bootstraps()).toBe(1);

    // The file now holds A and the daemon's offset-100 checkpoint, but the
    // one-shot replica never loaded A: resuming at 100 would skip it forever.
    expect((await syncMeta(oneShot)).ok).toBe(true);
    expect(oneShot.repo.getMeta().get(keyA)).toBe('A');
    expect(server.bootstraps()).toBe(2);

    // Meta progress lives with the replica checkpoints, not in the shared
    // LoroDoc cursor table.
    const metaStreamSuffix = `/${encodeURIComponent(getLoroMetaStreamId(workspaceId))}`;
    const sharedRows = oneShot.store.sqliteStore.db
      .prepare('SELECT stream_url FROM remote_cursors')
      .all() as Array<{ stream_url: string }>;
    expect(sharedRows.filter((row) => row.stream_url.endsWith(metaStreamSuffix))).toEqual([]);
  });

  it('does not advance the checkpoint past data that failed to persist before a crash', async () => {
    const server = createMetaServer();
    const daemon = await openCliProcess();
    const storage = daemon.store.storageAdapter;
    const save = storage.save.bind(storage);
    storage.save = async (payload) => {
      if (payload.type === 'meta-update') throw new Error('SQLITE_FULL: database or disk is full');
      await save(payload);
    };

    const result = await syncMeta(daemon).catch((error: unknown) => ({ ok: false, error }));
    expect(result.ok).toBe(false);
    expect(daemon.repo.getMeta().get(keyA)).toBe('A');

    // Crash: the process dies without the shutdown flush.
    openProcesses.delete(daemon);
    daemon.store.sqliteStore.close();

    const restarted = await openCliProcess();
    expect(restarted.repo.getMeta().get(keyA)).toBeUndefined();
    expect((await syncMeta(restarted)).ok).toBe(true);
    expect(restarted.repo.getMeta().get(keyA)).toBe('A');
    expect(server.bootstraps()).toBe(2);
  });

  it('resumes from its own durable checkpoint after a restart instead of bootstrapping again', async () => {
    const server = createMetaServer();
    const daemon = await openCliProcess();
    expect((await syncMeta(daemon)).ok).toBe(true);
    await closeCliProcess(daemon);

    const restarted = await openCliProcess();
    expect(restarted.repo.getMeta().get(keyA)).toBe('A');
    expect((await syncMeta(restarted)).ok).toBe(true);
    expect(server.bootstraps()).toBe(1);
  });
});
