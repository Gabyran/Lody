# Migrating Lody to loro-repo's replica-safe Flock persistence

Status: proposed
Translation: current

[中文](2026-09-27-loro-repo-flock-persistence-migration.zh.md)

## Abstract

loro-repo 0.20.3 changes how metadata and named Flock documents are written.
It stops treating the Flock version vector as proof that everything below it has been saved.
It now persists the exact records and received payloads.
For IndexedDB it can also store each Streams cursor with the data it describes, in one transaction.
Lody runs 0.20.0 (plus a patch that upstream has since absorbed).
Lody therefore still has the persistence hole upstream reproduced.
It also has three cursor/data mismatch paths of its own:

- the CLI saves cursors before the matching SQLite write happens;
- one-shot CLI commands share the daemon's cursor rows;
- web tabs share one repo database and one cursor database.

The proposal is a staged rollout:

1. Upgrade the library without changing composition.
2. Move the renderer's Meta/Flock cursors into the repo database.
3. Give the CLI real data-before-cursor barriers.
4. Only after an upstream `SqliteRepoStore` replica capability exists, bind the CLI's cursors the same way.

No existing cursor is copied. The only migration cost is one bootstrap per Meta/Flock room, which is also the only way to repair an already-damaged cache. Only step 1 is implemented, with a cross-version storage check; nothing has been measured. The main unverified risk is the write cost of IndexedDB's strict durability on busy workspaces.

## Upstream change (0.20.0 → 0.20.3, `main` at `5862a2b`)

Evidence is from the loro-repo repository. Its design record is `docs/flock-persistence.md` (PR #132).

- **Journal replaces version tracking.**
  - `FlockPersistenceJournal` replaces the version-vector bookkeeping in `MetaPersister` and `FlockDocManager`.
  - Local changes are written as exact `getEntry` records.
  - Payloads received through Streams (`applySnapshot`/`applyRemoteUpdates`) are appended verbatim, JSON or binary.
  - A payload leaves the queue only after `storage.save` resolves. After three failures of the same encoding it is replaced by a full-file fallback.
- **Snapshot saves are mergeable, not destructive.**
  - `meta-snapshot` and `flock-doc-snapshot` saves are now mergeable inputs in the IndexedDB, SQLite and filesystem adapters.
  - Only checked compaction replaces a base, and it removes only the updates it captured.
  - Update logs may now mix JSON records and binary Flock files.
  - 0.20.0's `hydrateMetaSnapshots` already merges both formats, so a rollback can still read the new data.
- **IndexedDB schema.**
  - The schema moves from version 3 to 4 and adds a `replica-checkpoints` object store: one `{ generation, cursors[] }` record per Meta or named Flock resource.
  - `loadMetaReplica` and `loadFlockDocReplica` capture base, log and checkpoint in one transaction. If no generation exists, they create one inside a readwrite capture.
  - Flock data and checkpoint writes use `durability: "strict"`.
  - 0.20.0 opens a database without a version first, so an old build can open a v4 database and simply ignores the new store.
- **Streams persistence factory.**
  - `createRepoStreamsPersistence(repo, options?)` returns `mode: "replica-bound"`. It requires the two replica loaders, so today it works only with `IndexedDBStorageAdaptor`.
  - Replica-bound mode cannot be combined with the `remoteCursorStore` option.
  - LoroDoc cursors are memory-only unless `documentRemoteCursorStore` is supplied.
  - In this mode the transport no longer deletes Meta/Flock cursors itself; they belong to the storage.
  - The two-argument form still works but is deprecated. It keeps data-before-cursor ordering, not atomic recovery.
- **SQLite.**
  - `SqliteRepoStore` has no schema change and no replica capability.
  - Corrupt cursor rows are dropped instead of failing (#102).
- **Other changes that affect Lody.**
  - `ready()` starts the metadata live monitor (#126, 0.20.1). That makes `patches/loro-repo.patch` redundant.
  - Transports now close before resource managers.
  - IndexedDB failures become `RepoStorageError` with a `code` (#129).
  - The unreleased 0.20.4 (#134) removes redundant version-vector reads on Streams imports.
  - All required Flock APIs (`recoverFromFile`, `inclusiveVersion`, `getEntry`) exist in `@loro-dev/flock-wasm` 0.4.3, which Lody already pins.

## Lody's current composition

**Renderer**

- The repo lives in IndexedDB database `lody-loro-repo-db-<ns>` (`packages/components/src/providers/create-workspace-runtime.ts:431`).
- Cursors live in a separate database, `lody-loro-stream-cursors-<ns>`, behind a resilient wrapper that falls back to memory after a 2-second timeout (`:457`, `resilient-remote-cursor-store.ts`).
- The Streams adapter passes that store as `remoteCursorStore` and awaits a full `repo.flush()` in every `onPersist*` callback (`:2817-2846`).
- Meta-cursor recovery deletes the Meta URL from that store (`:712-747`). A `localStorage` marker bypasses its load on the next start (`:443-456`).
- The namespace is `<workspaceId>`, or `<workspaceId>:<windowId>` for auxiliary Electron windows (`:159-173`).
- The primary Electron window and every web tab use the bare workspace namespace.

**CLI**

- One `SqliteRepoStore` per workspace at `<dataDir>/loro-repo/<ws>/repo.sqlite3`. It supplies both the repo storage and, through `AliasedRemoteCursorStore`, the cursor store (`apps/cli/src/lib/loro/sqlite-repo-store.ts:64-83`).
- The Streams adapter uses the legacy `remoteCursorStore` + `onPersist*` options (`apps/cli/src/lib/loro/streams-transport.ts:39-61`).
- Those callbacks only schedule a coalesced flush (200 ms debounce) and resolve at once (`apps/cli/src/lib/loro/doc.ts:614-622,756-783`).

**Barrier timing.** In streams-crdt 0.15.1, `persistRemoteCursor` awaits the barrier and then saves the cursor inside the read path (`finalizeCursor`). A slow barrier therefore delays that room's next batch but never drops it.

## Mismatches found

1. **CLI cursor ahead of data (confirmed from code, not reproduced).**
   - The cursor save runs while the covered state may be only in memory.
   - If the daemon crashes or is killed inside the debounce-plus-flush window, `remote_cursors` is left ahead of the SQLite data.
   - The restart resumes past the missing entries and keeps that hole until something forces a bootstrap.
2. **CLI processes share cursor rows (plausible, not reproduced).**
   - One-shot commands open the daemon's SQLite file and attach Streams on creation (`apps/cli/src/lib/command-runtime.ts:246`).
   - Each process hydrates its own in-memory replica but reads the shared `remote_cursors` row when it joins a room.
   - A process that hydrated before the daemon advanced data and cursor would resume at the daemon's tail. That is the upstream "stale replica, shared cursor" case.
   - Automatic snapshot upload is enabled (`canUpload: true`, 5 s debounce). Upstream showed that this case can publish a snapshot missing remote entries if the process lives past the debounce.
3. **Web tabs share one repo database and one cursor database.** This is exactly upstream's deterministic shared-IndexedDB reproduction. The Electron primary window normally has a single instance, but nothing enforces that on the web.
4. **The persistence hole in 0.20.0 affects every Lody replica.** Upstream fixed it in #132.

**Adjacent, out of scope.** The local data plane sends Flock deltas as `exportJson(from: version())` (`packages/shared/src/local-loro-transport.ts:578-580`, `local-loro-data-plane-server.ts`). It relies on the same "equal version vector means complete" assumption, so it cannot repair a same-version hole between the renderer and CLI replicas. It needs its own decision.

## Proposal

### Phase 0: library upgrade only

- Bump `loro-repo` to 0.20.3, or 0.20.4 once it is released, and delete `patches/loro-repo.patch`.
- Keep every composition unchanged: the renderer keeps its separate cursor database, the CLI its legacy options.
- What changes:
  - the journal replaces version-based skipping;
  - IndexedDB upgrades to v4;
  - SQLite needs no migration.
- **Rollback:** reverting the package is safe. 0.20.0 can open v4 and read mixed logs, and cursors are untouched.
- **Checks:**
  - `doc-meta-subscription.test.ts` still passes without the patch;
  - nothing in Lody matches IndexedDB error text;
  - `RepoStorageError` is logged usefully;
  - the storage-growth and compaction behavior of appended bootstrap files is observed on a large workspace.

**Phase 0 as implemented ([LodyAI/Lody#1049](https://github.com/LodyAI/Lody/pull/1049)).**

- The catalog now pins exactly `loro-repo: 0.20.3`, and the patch is deleted.
- `main` had meanwhile moved to streams-crdt 0.16.0 ([streams-crdt 0.16 upgrade](../../implemented/bug-fix/2026-09-27-streams-crdt-0.16-upgrade.md)). Its package-specific peer exception therefore moves from `loro-repo@0.20.0` to `loro-repo@0.20.3`.
  - 0.20.3 wraps two streams-crdt pieces: `createFlockAdapter`, and `persistRemoteCursor` with its `finalizeCursor` caller.
  - The emitted code of both is identical in the 0.15.1 and 0.16.0 tarballs.
  - The pin is exact so that a later patch release cannot fall outside that exception unnoticed.
- The installed 0.20.3 `ready()` awaits `ensureMetaLiveMonitor()` before starting the persister, which is exactly what the patch did.
- **Cross-version check** (throwaway script, not committed):
  - Both published 0.20.0 and 0.20.3 ran against one fake-indexeddb database and one `SqliteRepoStore` file, alternating old → new → old → new → new.
  - At every step each version saw every document metadata entry and named-Flock key written by the other.
  - The IndexedDB database ended at version 4 with `replica-checkpoints`.
  - This supports the rollback claim above for data written without cursors. It does not cover mixed-version concurrent writers.
- The large-workspace storage-growth observation is still open.

### Phase 1: renderer replica-bound checkpoints

- Replace `remoteCursorStore` + `onPersist*` with:

  ```ts
  persistence: createRepoStreamsPersistence(repo, {
    documentRemoteCursorStore: remoteCursorStore,
  });
  ```

  - LoroDoc cursors keep their current store and alias handling.
  - Meta and named Flock cursors move into the repo database, so the web-tab and window cases become safe by construction.

- Replace the barriers: per-resource `persist*Now` calls replace the full `repo.flush()` that currently runs on every sync event.
- Rewire Meta recovery to delete through `repo.getReplicaCheckpointStore({ kind: "meta", flock: repo.getMeta() })`.
  - Deleting the old cursor-database entry would have no effect.
  - The startup `localStorage` bypass becomes a delete of the Meta checkpoint before the cloud transport attaches, because the checkpoint is captured when the repo is created, not loaded lazily.
- **Do not copy existing Meta/Flock cursors into checkpoints.** A copied cursor has exactly the property the change removes: progress not captured with the data.
  - The empty generation makes each room bootstrap once and merge. That repairs historical holes whenever the remote snapshot is complete.
  - Old cursor-database entries are left alone. A rollback build would resume from those older offsets, which only causes a harmless replay.
- **Cost gates before shipping:**
  - bootstrap count and bytes when a large workspace opens for the first time;
  - strict-durability transaction rate and main-thread and disk time under a busy Meta stream on macOS Chromium.
  - If strict writes are too expensive, fall back to Phase 0 behavior. Do not relax the ordering.
- **Checkpoint key (limit):** it is the opaque stream URL, so a gateway-origin change forces bootstraps where `getLoroStreamsRemoteCursorUrlAliases` used to avoid them. Keying checkpoints by `(bucketId, streamId)` would need an upstream change.

### Phase 2: real CLI barriers (independent of upstream)

- Replace the schedule-only callbacks with awaited per-resource barriers, via the deprecated `createRepoStreamsPersistence(repo, aliasedCursorStore)` or an equivalent bundle:
  - `persistMetaNow`
  - `persistFlockDocNow(id, flock)`
  - `persistDocNow(id, doc)`
- These write only the pending journal entries or document delta, not the whole repository. That was what made the 3.6 flushes/s × 61 ms `repo.flush()` too costly and led to the coalescer.
- Keep the coalescer for non-barrier persistence.
- **Measure** barrier latency per batch and catch-up throughput on a long session before merging.
- **This fixes mismatch 1 only.** Mismatch 2 remains, because the cursor rows are still shared.

### Phase 3: CLI SQLite replica-bound checkpoints (upstream prerequisite)

- **Upstream work in `SqliteRepoStore`:**
  - Implement `loadMetaReplica` and `loadFlockDocReplica` with a `replica_checkpoints(resource_key PRIMARY KEY, generation, cursors_json)` table.
  - Capture snapshot + updates + checkpoint in one better-sqlite3 transaction.
  - Check the generation in each cursor write.
  - Delete the checkpoint row in the same transaction as `deleteFlockDoc`, which covers retention expiry of `fi`/`fis`.
- **Lody then switches** to `createRepoStreamsPersistence(repo, { documentRemoteCursorStore: aliasedCursorStore })`. Each process, daemon or one-shot, gets its own captured cursor, which closes mismatch 2.
- **Migration:** `CREATE TABLE IF NOT EXISTS`, no copying of `remote_cursors`, and one bootstrap per Meta/Flock room.
- **Rollback:** an older build ignores the new table and resumes from stale `remote_cursors` rows (replay only). A checkpoint that is behind the data is always safe.
- **One unsafe rollback sequence:**
  1. An older build deletes a named Flock, which leaves its checkpoint row behind.
  2. The newer build reopens the empty document with the stale cursor.
  3. The earlier stream history is then skipped.

  The upstream design must close this. For example, each checkpoint could record a fingerprint of the base/log it was captured with, so a mismatch discards the checkpoint. The same gap exists for IndexedDB, but no renderer code deletes named Flocks.

- **Upstream status:** [loro-dev/loro-repo#137](https://github.com/loro-dev/loro-repo/pull/137) implements this capability. It is open and not yet reviewed here.
  - It closes the rollback gap with delete triggers stored in the database schema rather than fingerprints. Deleting a base row, or deleting update rows while no base row exists, drops the checkpoint.
  - This works because every SQLite writer since #99 removes Flock data only through `deleteFlockDoc` or through compaction, and compaction writes the base before deleting updates. The triggers therefore also fire for older binaries without mistaking compaction for deletion.
  - Base rows switch from `INSERT OR REPLACE` to UPSERT, so `recursive_triggers` cannot misfire either.
- **IndexedDB:** the equivalent gap is tracked in [loro-dev/loro-repo#136](https://github.com/loro-dev/loro-repo/issues/136). It also covers concurrent tabs from different releases, and it gates Phase 1 on the web.

## Alternatives

- **Upgrade and switch composition in one release.**
  - Rejected: a regression could not be attributed to either change.
  - Phase 0 gives a rollback point that touches no cursors.
- **Seed checkpoints from existing cursors to avoid bootstraps.**
  - Rejected: it moves possibly-unbound progress into a store that claims to be bound, making the new guarantee false for exactly the caches that need repair.
- **Keep the two-argument factory in the renderer.**
  - Rejected as the end state: it keeps ordering but not atomic recovery, so shared-database tabs remain unsafe.
- **Enforce single-writer access in the CLI with a file lock** instead of Phase 3.
  - A smaller option for mismatch 2 if the upstream work is delayed.
  - It blocks one-shot commands while the daemon runs, or forces them to route through the daemon. That is a product decision that has not been made.

## Verification limits

This is desk analysis of upstream code at `5862a2b`, streams-crdt 0.15.1 and Lody at `d0f2d9b7`.

- No mismatch above has been reproduced in Lody.
- No migration has run.
- No performance number has been measured.
- Upstream tests use fake-indexeddb, which proves transaction ordering, not power-loss durability.
