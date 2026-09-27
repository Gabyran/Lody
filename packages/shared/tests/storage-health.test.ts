import type { StorageAdapter } from 'loro-repo';
import { describe, expect, it } from 'vitest';
import { classifyStorageFullError, observeStorageAdapterWrites } from '../src';

const withCode = (code: string) => Object.assign(new Error(code), { code });

describe('classifyStorageFullError', () => {
  it('classifies out-of-space errors by code or name, wherever they are wrapped', () => {
    expect(classifyStorageFullError(withCode('ENOSPC'))).toBe('ENOSPC');
    expect(classifyStorageFullError(withCode('EDQUOT'))).toBe('EDQUOT');
    expect(
      classifyStorageFullError(
        new AggregateError([new Error('snapshot'), withCode('SQLITE_FULL')], 'fallback failed')
      )
    ).toBe('SQLITE_FULL');
    const repoQuota = Object.assign(new Error('write refused'), {
      name: 'RepoStorageError',
      code: 'quota',
    });
    expect(classifyStorageFullError(new Error('flush', { cause: repoQuota }))).toBe(
      'RepoStorageError:quota'
    );
    expect(classifyStorageFullError(new DOMException('full', 'QuotaExceededError'))).toBe(
      'QuotaExceededError'
    );
  });

  it('rejects other failures, including a message that merely mentions a full disk', () => {
    expect(classifyStorageFullError(new Error('database or disk is full'))).toBeNull();
    expect(
      classifyStorageFullError(
        Object.assign(new Error('closing'), { name: 'RepoStorageError', code: 'unavailable' })
      )
    ).toBeNull();
    expect(classifyStorageFullError(withCode('EACCES'))).toBeNull();
    const cyclic: { cause?: unknown } = new Error('cycle');
    cyclic.cause = cyclic;
    expect(classifyStorageFullError(cyclic)).toBeNull();
  });
});

describe('observeStorageAdapterWrites', () => {
  it('reports write outcomes, rethrows failures and keeps missing capabilities absent', async () => {
    let failNext = false;
    const saved: unknown[] = [];
    const inner: StorageAdapter = {
      save: async (payload) => {
        if (failNext) throw withCode('SQLITE_FULL');
        saved.push(payload);
      },
      loadDoc: async () => undefined,
      loadMeta: async () => undefined,
    };
    const outcomes: string[] = [];
    const adapter = observeStorageAdapterWrites(inner, {
      onWriteFailed: (error, operation) =>
        outcomes.push(`failed:${operation}:${classifyStorageFullError(error)}`),
      onWriteSucceeded: () => outcomes.push('ok'),
    });

    const payload = { type: 'meta', update: new Uint8Array([1]) } as never;
    await adapter.save(payload);
    failNext = true;
    await expect(adapter.save(payload)).rejects.toMatchObject({ code: 'SQLITE_FULL' });
    await adapter.loadDoc('doc-1');

    expect(saved).toEqual([payload]);
    expect(outcomes).toEqual(['ok', 'failed:save:SQLITE_FULL']);
    // loro-repo feature-detects optional methods, so the wrapper must not invent them.
    expect('deleteDoc' in adapter).toBe(false);
    expect('loadMetaReplica' in adapter).toBe(false);
  });
});
