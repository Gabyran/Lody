import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { LoroRepo } from 'loro-repo';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isStorageCriticalError,
  getSessionRoomId,
  observeStorageAdapterWrites,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { LoroDocumentManager } from './loro/doc';
import {
  StorageHealthMonitor,
  computeStorageThresholds,
  type StorageHealthSnapshot,
  type StorageSpace,
} from './storage-health';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const TOTAL = 100 * GIB; // critical 1 GiB, warning 5 GiB

/** Timers run only when the test fires them; the clock moves only when the test moves it. */
class ManualScheduler {
  nowMs = 1_000_000;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  setTimer = (callback: () => void, delayMs: number): unknown => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + delayMs, callback });
    return id;
  };

  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  /** Moves the clock and fires every timer that came due, in order. */
  advance(ms: number): void {
    const until = this.nowMs + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (!due) break;
      const [id, timer] = due;
      this.timers.delete(id);
      this.nowMs = timer.at;
      timer.callback();
    }
    this.nowMs = until;
  }
}

const silentLogger = { warn: () => {}, info: () => {}, debug: () => {} };

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

const createMonitor = (space: { current: StorageSpace }) => {
  const scheduler = new ManualScheduler();
  const warnings: string[] = [];
  const monitor = new StorageHealthMonitor({
    dataDir: '/lody-data',
    logger: { ...silentLogger, warn: (message: string) => warnings.push(message) },
    now: () => scheduler.nowMs,
    readSpace: async () => space.current,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });
  const transitions: StorageHealthSnapshot[] = [];
  monitor.subscribe((snapshot) => transitions.push(snapshot));
  return { monitor, scheduler, transitions, warnings };
};

const sqliteFull = (): Error =>
  Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });

const createdDirs: string[] = [];
afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true })));
});

describe('computeStorageThresholds', () => {
  it('combines a share of the volume with absolute floors and caps', () => {
    expect(computeStorageThresholds(1024 * GIB)).toEqual({
      criticalBytes: GIB,
      warningBytes: 5 * GIB,
    });
    expect(computeStorageThresholds(50 * GIB)).toEqual({
      criticalBytes: 512 * MIB,
      warningBytes: 2.5 * GIB,
    });
    expect(computeStorageThresholds(10 * GIB)).toEqual({
      criticalBytes: 256 * MIB,
      warningBytes: GIB,
    });
    // A volume smaller than the floors is never critical while mostly empty.
    expect(computeStorageThresholds(256 * MIB)).toEqual({
      criticalBytes: 64 * MIB,
      warningBytes: 128 * MIB,
    });
  });
});

describe('StorageHealthMonitor', () => {
  it('tracks free space with hysteresis and gates disk-heavy work only while critical', async () => {
    const space = { current: { availableBytes: 50 * GIB, totalBytes: TOTAL } };
    const { monitor, scheduler, transitions } = createMonitor(space);
    await monitor.start();
    expect(monitor.getSnapshot().level).toBe('ok');
    expect(monitor.getPresenceField()).toBeUndefined();

    space.current = { availableBytes: 3 * GIB, totalBytes: TOTAL };
    scheduler.advance(60_000);
    await monitor.settled();
    expect(monitor.getSnapshot()).toMatchObject({ level: 'warning', reason: 'low-space' });
    await expect(monitor.assertCanStartDiskHeavyWork('new agent turns')).resolves.toBeUndefined();

    space.current = { availableBytes: 900 * MIB, totalBytes: TOTAL };
    // Polling is faster while degraded, and the gate re-samples a stale reading itself.
    scheduler.advance(10_000);
    await monitor.settled();
    expect(monitor.getPresenceField()).toEqual({
      level: 'critical',
      reason: 'low-space',
      availableBytes: 900 * MIB,
    });
    const refusal = await monitor
      .assertCanStartDiskHeavyWork('new agent turns')
      .catch((error: unknown) => error);
    expect(isStorageCriticalError(refusal)).toBe(true);
    expect(String(refusal)).toContain('new agent turns');

    // Just above the threshold is not enough to leave critical.
    space.current = { availableBytes: 1.05 * GIB, totalBytes: TOTAL };
    scheduler.advance(10_000);
    await monitor.settled();
    expect(monitor.getSnapshot().level).toBe('critical');

    space.current = { availableBytes: 20 * GIB, totalBytes: TOTAL };
    scheduler.advance(10_000);
    await monitor.settled();
    expect(monitor.getSnapshot().level).toBe('ok');
    // One notification per level change; byte changes inside a level publish nothing.
    expect(transitions.map((snapshot) => snapshot.level)).toEqual(['warning', 'critical', 'ok']);
    monitor.stop();
  });

  it('reads a classified write failure as critical at once, and only a full flush clears it', async () => {
    const space = { current: { availableBytes: 50 * GIB, totalBytes: TOTAL } };
    const { monitor, scheduler, transitions, warnings } = createMonitor(space);
    await monitor.start();
    let flushFails = true;
    let flushes = 0;
    monitor.registerFlushTarget('workspace-1', async () => {
      flushes += 1;
      if (flushFails) throw sqliteFull();
    });

    expect(monitor.reportWriteFailure(new Error('unrelated'), 'test')).toBe(false);
    expect(monitor.getSnapshot().level).toBe('ok');

    const failedAt = scheduler.nowMs;
    const wrapped = new AggregateError([sqliteFull()], 'Failed to persist a Flock update');
    expect(monitor.reportWriteFailure(wrapped, 'loro-repo save')).toBe(true);
    expect(monitor.getPresenceField()).toMatchObject({
      level: 'critical',
      reason: 'write-failed',
      unsavedSince: failedAt,
    });
    expect(monitor.hasUnsavedChanges()).toBe(true);
    // Repeated failures inside the warn interval stay out of the log.
    monitor.reportWriteFailure(sqliteFull(), 'loro-repo save');
    expect(warnings).toHaveLength(1);

    // A successful write proves space exists, but the recovery flush fails again.
    monitor.reportWriteSuccess();
    await monitor.settled();
    expect(flushes).toBe(1);
    expect(monitor.hasUnsavedChanges()).toBe(true);

    // Further attempts wait out the recovery interval instead of spinning.
    monitor.reportWriteSuccess();
    await monitor.settled();
    expect(flushes).toBe(1);

    flushFails = false;
    scheduler.advance(10_000);
    await monitor.settled();
    expect(flushes).toBe(2);
    expect(monitor.getSnapshot()).toMatchObject({ level: 'ok', unsavedSince: null });
    expect(transitions.map((snapshot) => [snapshot.level, snapshot.reason])).toEqual([
      ['critical', 'write-failed'],
      ['ok', null],
    ]);
    monitor.stop();
  });

  it('keeps a real SQLite repo in memory while full and saves every change once space returns', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-storage-health-'));
    createdDirs.push(dir);
    const dbPath = path.join(dir, 'repo.sqlite3');
    const database = new Database(dbPath);
    const sqliteStore = new SqliteRepoStore({ database });

    const space = { current: { availableBytes: 50 * GIB, totalBytes: TOTAL } };
    const { monitor, scheduler } = createMonitor(space);
    await monitor.start();
    const repo = await LoroRepo.create({
      storageAdapter: observeStorageAdapterWrites(sqliteStore.storage, {
        onWriteFailed: (error, operation) => monitor.reportWriteFailure(error, operation),
        onWriteSucceeded: () => monitor.reportWriteSuccess(),
      }),
      metaDebounceCommitMs: 0,
    });
    monitor.registerFlushTarget('workspace-1', () => repo.flush());

    const writeDoc = async (docId: string) => {
      const handle = await repo.openPersistedDoc(docId);
      handle.doc.getText('body').insert(0, `${docId} `.repeat(2_000));
      handle.doc.commit();
      await repo.upsertDocMeta(docId, { title: docId });
    };
    await writeDoc('before-full');
    await repo.flush();

    // The disk fills up: SQLite itself refuses to grow the file.
    const pages = database.pragma('page_count', { simple: true }) as number;
    database.pragma(`max_page_count = ${pages}`);
    space.current = { availableBytes: 0, totalBytes: TOTAL };
    for (let i = 0; i < 20; i += 1) {
      await writeDoc(`while-full-${i}`);
    }
    await expect(repo.flush()).rejects.toThrow();
    expect(monitor.getSnapshot()).toMatchObject({ level: 'critical', reason: 'write-failed' });
    await expect(monitor.assertCanStartDiskHeavyWork('new agent turns')).rejects.toSatisfy(
      isStorageCriticalError
    );

    // Space is freed; the next poll flushes without anyone writing again.
    database.pragma('max_page_count = 1073741823');
    space.current = { availableBytes: 20 * GIB, totalBytes: TOTAL };
    scheduler.advance(10_000);
    await monitor.settled();
    expect(monitor.getSnapshot()).toMatchObject({ level: 'ok', unsavedSince: null });

    // Read through a second connection while the first repo is still open:
    // destroying it would flush on its own and hide a missing recovery flush.
    const reopenedStore = new SqliteRepoStore({ path: dbPath });
    const reopened = await LoroRepo.create({ storageAdapter: reopenedStore.storage });
    for (const docId of [
      'before-full',
      ...Array.from({ length: 20 }, (_, i) => `while-full-${i}`),
    ]) {
      expect((await reopened.getDocMeta(docId))?.meta).toMatchObject({ title: docId });
      const doc = await reopened.openDetachedDoc(docId);
      expect(doc.getText('body').toString()).toContain(docId);
    }
    await reopened.destroy();
    reopenedStore.close();
    monitor.stop();
    await repo.destroy();
    database.close();
  });

  it('never clears unsaved changes whose target left without saving them', async () => {
    const space = { current: { availableBytes: 0, totalBytes: TOTAL } };
    const { monitor, scheduler } = createMonitor(space);
    await monitor.start();
    const unregister = monitor.registerFlushTarget('workspace-1', async () => {});
    monitor.reportWriteFailure(sqliteFull(), 'loro-repo save');
    unregister({ saved: false });

    // Space returns and every remaining target (none) flushes fine.
    space.current = { availableBytes: 20 * GIB, totalBytes: TOTAL };
    scheduler.advance(10_000);
    await monitor.settled();
    expect(monitor.hasUnsavedChanges()).toBe(true);
    expect(monitor.getSnapshot()).toMatchObject({ level: 'critical', reason: 'write-failed' });
    monitor.stop();
  });

  it('keeps a workspace torn down on a full disk alive until its changes are saved', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-storage-teardown-'));
    createdDirs.push(dir);
    const dbPath = path.join(dir, 'repo.sqlite3');
    const database = new Database(dbPath);
    const sqliteStore = new SqliteRepoStore({ database });
    const space = { current: { availableBytes: 50 * GIB, totalBytes: TOTAL } };
    const { monitor, scheduler } = createMonitor(space);
    await monitor.start();
    const repo = await LoroRepo.create({
      storageAdapter: observeStorageAdapterWrites(sqliteStore.storage, {
        onWriteFailed: (error, operation) => monitor.reportWriteFailure(error, operation),
        onWriteSucceeded: () => monitor.reportWriteSuccess(),
      }),
      metaDebounceCommitMs: 0,
    });
    const manager = new LoroDocumentManager({
      repo,
      workspaceId: 'workspace-teardown' as WorkspaceId,
      userId: 'user-1',
      metaSub: null,
      logger: createSilentLogger(),
      initialTransportStatus: 'connected',
      initialMetaSyncPromise: Promise.resolve(false),
      initialMetaSyncCompleted: false,
      storageHealth: monitor,
    });

    const docIds = Array.from({ length: 10 }, (_, i) => `written-while-full-${i}`);
    const pages = database.pragma('page_count', { simple: true }) as number;
    database.pragma(`max_page_count = ${pages}`);
    space.current = { availableBytes: 0, totalBytes: TOTAL };
    for (const docId of docIds) {
      const handle = await repo.openPersistedDoc(docId);
      handle.doc.getText('body').insert(0, `${docId} `.repeat(2_000));
      handle.doc.commit();
      await repo.upsertDocMeta(docId, { title: docId });
    }
    await expect(repo.flush()).rejects.toThrow();
    expect(monitor.hasUnsavedChanges()).toBe(true);

    // The workspace is stopped (list reconcile, revocation) while the disk is still full.
    await manager.cleanUp();
    expect(monitor.hasUnsavedChanges()).toBe(true);

    // Space returns: recovery still owns the torn-down repo, saves it, then closes it.
    database.pragma('max_page_count = 1073741823');
    space.current = { availableBytes: 20 * GIB, totalBytes: TOTAL };
    scheduler.advance(10_000);
    await monitor.settled();
    expect(monitor.getSnapshot()).toMatchObject({ level: 'ok', unsavedSince: null });

    const reopenedStore = new SqliteRepoStore({ path: dbPath });
    const reopened = await LoroRepo.create({ storageAdapter: reopenedStore.storage });
    for (const docId of docIds) {
      expect((await reopened.getDocMeta(docId))?.meta).toMatchObject({ title: docId });
      expect((await reopened.openDetachedDoc(docId)).getText('body').toString()).toContain(docId);
    }
    await reopened.destroy();
    reopenedStore.close();
    monitor.stop();
    database.close();
  });

  it('finishes a teardown whose first storage failure is an open session doc unload', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-storage-session-teardown-'));
    createdDirs.push(dir);
    const dbPath = path.join(dir, 'repo.sqlite3');
    const database = new Database(dbPath);
    const sqliteStore = new SqliteRepoStore({ database });
    const space = { current: { availableBytes: 50 * GIB, totalBytes: TOTAL } };
    const { monitor, scheduler } = createMonitor(space);
    await monitor.start();
    const repo = await LoroRepo.create({
      storageAdapter: observeStorageAdapterWrites(sqliteStore.storage, {
        onWriteFailed: (error, operation) => monitor.reportWriteFailure(error, operation),
        onWriteSucceeded: () => monitor.reportWriteSuccess(),
      }),
      metaDebounceCommitMs: 0,
    });
    const manager = new LoroDocumentManager({
      repo,
      workspaceId: 'workspace-session-teardown' as WorkspaceId,
      userId: 'user-1',
      metaSub: null,
      logger: createSilentLogger(),
      initialTransportStatus: 'connected',
      initialMetaSyncPromise: Promise.resolve(false),
      initialMetaSyncCompleted: false,
      storageHealth: monitor,
    });
    const sessionId = 'session-open-while-full' as SessionId;
    await manager.getOrCreateSessionDoc(sessionId);

    // The disk fills; the session's doc (still open in the manager) becomes dirty.
    const pages = database.pragma('page_count', { simple: true }) as number;
    database.pragma(`max_page_count = ${pages}`);
    space.current = { availableBytes: 0, totalBytes: TOTAL };
    const handle = await repo.openPersistedDoc(getSessionRoomId(sessionId));
    handle.doc.getText('probe').insert(0, 'typed while the disk was full '.repeat(500));
    handle.doc.commit();
    await expect(repo.flush()).rejects.toThrow();

    // Stopping the workspace: the session doc's unload is the first write to fail.
    await manager.cleanUp();
    expect(monitor.flushTargetNames()).toEqual(['workspace-session-teardown']);
    let released = false;
    const releasedSignal = manager.whenRepoReleased().then(() => {
      released = true;
    });
    expect(monitor.hasUnsavedChanges()).toBe(true);
    expect(released).toBe(false);

    database.pragma('max_page_count = 1073741823');
    space.current = { availableBytes: 20 * GIB, totalBytes: TOTAL };
    scheduler.advance(10_000);
    await monitor.settled();
    await releasedSignal;
    expect(monitor.hasUnsavedChanges()).toBe(false);
    // Saved, destroyed, and no longer owned by recovery.
    expect(monitor.flushTargetNames()).toEqual([]);

    const reopenedStore = new SqliteRepoStore({ path: dbPath });
    const reopened = await LoroRepo.create({ storageAdapter: reopenedStore.storage });
    const saved = await reopened.openDetachedDoc(getSessionRoomId(sessionId));
    expect(saved.getText('probe').toString()).toContain('typed while the disk was full');
    await reopened.destroy();
    reopenedStore.close();
    monitor.stop();
    database.close();
  });
});
