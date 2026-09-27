import type { StorageAdapter } from 'loro-repo';

export type StorageWriteObserver = {
  onWriteFailed: (error: unknown, operation: string) => void;
  onWriteSucceeded: () => void;
};

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
  const observe = async <T>(operation: string, run: () => Promise<T>): Promise<T> => {
    let result: T;
    try {
      result = await run();
    } catch (error) {
      observer.onWriteFailed(error, operation);
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
    save: (payload) => observe('save', () => inner.save(payload)),
    // loro-repo commits metadata and named Flock payloads through `saveMany`
    // when the adapter has it; dropping it would fall back to one commit per
    // payload. It is atomic, so a failure is one refused write that the repo
    // retries in full.
    ...(saveMany
      ? {
          saveMany: (payloads: Parameters<typeof saveMany>[0]) =>
            observe('saveMany', () => saveMany.call(inner, payloads)),
        }
      : {}),
    ...(compactMeta
      ? { compactMeta: () => observe('compactMeta', () => compactMeta.call(inner)) }
      : {}),
    ...(compactFlockDoc
      ? {
          compactFlockDoc: (id: string) =>
            observe('compactFlockDoc', () => compactFlockDoc.call(inner, id)),
        }
      : {}),
    loadDoc: (docId) => inner.loadDoc(docId),
    ...(loadFlockDoc ? { loadFlockDoc: (id: string) => loadFlockDoc.call(inner, id) } : {}),
    ...(deleteDoc
      ? { deleteDoc: (id: string) => observe('deleteDoc', () => deleteDoc.call(inner, id)) }
      : {}),
    ...(deleteFlockDoc
      ? {
          deleteFlockDoc: (id: string) =>
            observe('deleteFlockDoc', () => deleteFlockDoc.call(inner, id)),
        }
      : {}),
    loadMeta: () => inner.loadMeta(),
  };
};
