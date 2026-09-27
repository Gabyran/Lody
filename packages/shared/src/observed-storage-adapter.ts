import type { StorageAdapter, StorageSavePayload } from 'loro-repo';

/**
 * One refused write, described so a caller can tell new data from a retry.
 *
 * `exact` payloads carry precisely the pending changes (a doc update, JSON Flock
 * records, a delete): loro-repo retries them byte for byte, so a new `key` means
 * new data. `whole` payloads re-encode state under their target: a snapshot, or a
 * binary Flock file (loro-repo's fallback after repeated failures, or records
 * received from sync). Only their target is informative.
 */
export type RefusedStorageWrite = { target: string; key: string; shape: 'exact' | 'whole' };

export type StorageWriteObserver = {
  /** `writes` describes what was refused; computed only on failure. */
  onWriteFailed: (
    error: unknown,
    operation: string,
    writes: readonly RefusedStorageWrite[]
  ) => void;
  onWriteSucceeded: () => void;
};

/** Two independent 32-bit hashes (FNV-1a and djb2) with the length: collisions are negligible. */
const hashBytes = (bytes: Uint8Array): string => {
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (const byte of bytes) {
    fnv = Math.imul(fnv ^ byte, 0x01000193);
    djb = (Math.imul(djb, 33) + byte) | 0;
  }
  return `${bytes.length}:${(fnv >>> 0).toString(16)}:${(djb >>> 0).toString(16)}`;
};

/** A binary Flock file starts with `FLK`; exact local records are JSON. */
const isFlockFile = (bytes: Uint8Array): boolean =>
  bytes[0] === 0x46 && bytes[1] === 0x4c && bytes[2] === 0x4b;

export const describeStorageWrite = (payload: StorageSavePayload): RefusedStorageWrite => {
  switch (payload.type) {
    case 'doc-update':
      return { target: `doc:${payload.docId}`, key: hashBytes(payload.update), shape: 'exact' };
    case 'doc-snapshot':
      return { target: `doc:${payload.docId}`, key: hashBytes(payload.snapshot), shape: 'whole' };
    case 'flock-doc-update':
      return {
        target: `flock:${payload.flockDocId}`,
        key: hashBytes(payload.update),
        shape: isFlockFile(payload.update) ? 'whole' : 'exact',
      };
    case 'flock-doc-snapshot':
      return {
        target: `flock:${payload.flockDocId}`,
        key: hashBytes(payload.snapshot),
        shape: 'whole',
      };
    case 'meta-update':
      return {
        target: 'meta',
        key: hashBytes(payload.update),
        shape: isFlockFile(payload.update) ? 'whole' : 'exact',
      };
    case 'meta-snapshot':
      return { target: 'meta', key: hashBytes(payload.snapshot), shape: 'whole' };
  }
  // A payload kind this version does not know: new, since nothing tells otherwise.
  return {
    target: `unknown:${String((payload as { type?: unknown }).type)}`,
    key: '',
    shape: 'exact',
  };
};

const operationWrite = (target: string): RefusedStorageWrite => ({
  target,
  key: target,
  shape: 'exact',
});

/**
 * Wraps a loro-repo storage adapter so every write reports its outcome.
 *
 * loro-repo persists local edits in the background and only logs a failed
 * background save to the console, so wrapping the adapter is the one boundary
 * every repo write passes through. Reads and optional capabilities are passed
 * through unchanged: an optional method the inner adapter lacks stays absent,
 * because loro-repo feature-detects them. Errors are rethrown as is, so the
 * repo keeps the change dirty and retries it on the next flush.
 */
export const observeStorageAdapterWrites = (
  inner: StorageAdapter,
  observer: StorageWriteObserver
): StorageAdapter => {
  const observe = async <T>(
    operation: string,
    writes: () => readonly RefusedStorageWrite[],
    run: () => Promise<T>
  ): Promise<T> => {
    let result: T;
    try {
      result = await run();
    } catch (error) {
      // Describing the write must never replace the error the repo has to see.
      let described: readonly RefusedStorageWrite[] = [];
      try {
        described = writes();
      } catch {
        described = [];
      }
      observer.onWriteFailed(error, operation, described);
      throw error;
    }
    observer.onWriteSucceeded();
    return result;
  };
  const { loadMetaReplica, loadFlockDocReplica, init, close, compactMeta, compactFlockDoc } = inner;
  const { saveMany } = inner;
  const { loadFlockDoc, deleteDoc, deleteFlockDoc } = inner;
  return {
    ...(loadMetaReplica ? { loadMetaReplica: () => loadMetaReplica.call(inner) } : {}),
    ...(loadFlockDocReplica
      ? { loadFlockDocReplica: (id: string) => loadFlockDocReplica.call(inner, id) }
      : {}),
    ...(init ? { init: () => init.call(inner) } : {}),
    ...(close ? { close: () => close.call(inner) } : {}),
    save: (payload) =>
      observe(
        'save',
        () => [describeStorageWrite(payload)],
        () => inner.save(payload)
      ),
    // loro-repo commits metadata and named Flock payloads through `saveMany`
    // when the adapter has it; dropping it would fall back to one commit per
    // payload. It is atomic, so a failure is one refused write that the repo
    // retries in full.
    ...(saveMany
      ? {
          saveMany: (payloads: Parameters<typeof saveMany>[0]) =>
            observe(
              'saveMany',
              () => payloads.map(describeStorageWrite),
              () => saveMany.call(inner, payloads)
            ),
        }
      : {}),
    ...(compactMeta
      ? {
          compactMeta: () =>
            observe(
              'compactMeta',
              () => [operationWrite('compact:meta')],
              () => compactMeta.call(inner)
            ),
        }
      : {}),
    ...(compactFlockDoc
      ? {
          compactFlockDoc: (id: string) =>
            observe(
              'compactFlockDoc',
              () => [operationWrite(`compact:flock:${id}`)],
              () => compactFlockDoc.call(inner, id)
            ),
        }
      : {}),
    loadDoc: (docId) => inner.loadDoc(docId),
    ...(loadFlockDoc ? { loadFlockDoc: (id: string) => loadFlockDoc.call(inner, id) } : {}),
    ...(deleteDoc
      ? {
          deleteDoc: (id: string) =>
            observe(
              'deleteDoc',
              () => [operationWrite(`delete:doc:${id}`)],
              () => deleteDoc.call(inner, id)
            ),
        }
      : {}),
    ...(deleteFlockDoc
      ? {
          deleteFlockDoc: (id: string) =>
            observe(
              'deleteFlockDoc',
              () => [operationWrite(`delete:flock:${id}`)],
              () => deleteFlockDoc.call(inner, id)
            ),
        }
      : {}),
    loadMeta: () => inner.loadMeta(),
  };
};
