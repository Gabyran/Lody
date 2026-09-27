# 将 Lody 迁移到 loro-repo 的副本安全 Flock 持久化

Status: proposed
Translation: current

[English](2026-09-27-loro-repo-flock-persistence-migration.md)

## 摘要

loro-repo 0.20.3 改变了元数据和命名 Flock 文档的写入方式：

- 不再把 Flock 版本向量当作"其下所有内容都已保存"的证据，改为持久化精确记录和收到的原始负载；
- 对 IndexedDB，还可以把每个 Streams 游标和它所描述的数据放在同一个事务里保存。

Lody 目前运行 0.20.0，外加一个上游已经吸收的补丁。因此 Lody 仍带着上游复现过的那个持久化空洞，另外还有三条自己的游标与数据不一致的路径：

- CLI 在对应的 SQLite 写入发生之前就保存了游标；
- 一次性 CLI 命令与 daemon 共用游标行；
- Web 标签页共用同一个 repo 库和同一个游标库。

提案是分阶段推进：

1. 先只升级库，不改组合方式；
2. 再把渲染端的 Meta/Flock 游标移进 repo 库；
3. 然后给 CLI 加上真正的"先数据后游标"屏障；
4. 等上游 `SqliteRepoStore` 具备副本能力之后，再以同样方式绑定 CLI 的游标。

不复制任何现有游标。唯一的迁移代价是每个 Meta/Flock 房间 bootstrap 一次，而这也是修复已经损坏的缓存的唯一途径。目前只实现了第 1 步，并做了跨版本存储验证；尚未做任何性能测量。最主要的未验证风险是 IndexedDB strict 持久化在繁忙工作区上的写入开销。

## 上游变化（0.20.0 → 0.20.3，`main` 位于 `5862a2b`）

依据来自 loro-repo 仓库，设计记录见 `docs/flock-persistence.md`（PR #132）。

- **用 journal 取代版本追踪。**
  - `FlockPersistenceJournal` 取代了 `MetaPersister` 和 `FlockDocManager` 里的版本向量记账。
  - 本地修改按 `getEntry` 的精确记录写入。
  - 经 Streams 收到的负载（`applySnapshot`/`applyRemoteUpdates`）原样追加，JSON 或二进制都保留原字节。
  - 负载只有在 `storage.save` 成功之后才会离开队列；同一编码连续失败三次后，改用一个全量文件来兜底。
- **snapshot 保存改为可合并，不再是破坏性覆盖。**
  - 在 IndexedDB、SQLite 和文件系统三种 adapter 中，`meta-snapshot` 和 `flock-doc-snapshot` 保存现在都是可合并的输入。
  - 只有经过校验的压实才会替换 base，并且只删除它捕获到的那些更新。
  - 更新日志里因此可能混有 JSON 记录和二进制 Flock 文件。
  - 0.20.0 的 `hydrateMetaSnapshots` 本来就能合并这两种格式，所以回滚后仍能读取新数据。
- **IndexedDB 结构。**
  - 数据库版本从 3 升到 4，新增 `replica-checkpoints` object store：每个 Meta 或命名 Flock 资源一条 `{ generation, cursors[] }` 记录。
  - `loadMetaReplica` 和 `loadFlockDocReplica` 在同一个事务里捕获 base、日志和 checkpoint；如果还没有 generation，就在 readwrite 捕获中创建一个。
  - Flock 数据写入和 checkpoint 写入都使用 `durability: "strict"`。
  - 0.20.0 打开数据库时先不带版本号，所以旧版本也能打开 v4 库，并且直接忽略新的 store。
- **Streams 持久化工厂。**
  - `createRepoStreamsPersistence(repo, options?)` 返回 `mode: "replica-bound"`。它要求存储提供上面两个副本加载方法，所以目前只适用于 `IndexedDBStorageAdaptor`。
  - replica-bound 模式不能与 `remoteCursorStore` 选项同时使用。
  - LoroDoc 的游标默认只保存在内存里，除非传入 `documentRemoteCursorStore`。
  - 在这个模式下，transport 不再自己删除 Meta/Flock 游标，它们归存储所有。
  - 两参数形式仍然可用但已弃用：它只保证"先数据后游标"的顺序，不提供原子恢复。
- **SQLite。**
  - `SqliteRepoStore` 没有结构变化，也不具备副本能力。
  - 损坏的游标行现在会被丢弃，而不是报错（#102）。
- **其他影响 Lody 的变化。**
  - `ready()` 会启动元数据 live monitor（#126，0.20.1），因此 `patches/loro-repo.patch` 已经多余。
  - 关闭时 transport 先于资源管理器关闭。
  - IndexedDB 失败会包装成带 `code` 的 `RepoStorageError`（#129）。
  - 尚未发布的 0.20.4（#134）去掉了 Streams 导入时多余的版本向量读取。
  - 新代码需要的 Flock API（`recoverFromFile`、`inclusiveVersion`、`getEntry`）在 Lody 已锁定的 `@loro-dev/flock-wasm` 0.4.3 中都已具备。

## Lody 现状

**渲染端**

- repo 存在 IndexedDB 库 `lody-loro-repo-db-<ns>` 中（`packages/components/src/providers/create-workspace-runtime.ts:431`）。
- 游标存在另一个库 `lody-loro-stream-cursors-<ns>` 中，外面包了一层容错封装：2 秒超时后回退到内存（`:457`，`resilient-remote-cursor-store.ts`）。
- Streams adapter 把这个 store 作为 `remoteCursorStore` 传入，并在每个 `onPersist*` 回调里等待一次完整的 `repo.flush()`（`:2817-2846`）。
- Meta 游标恢复时，会从这个 store 里删除 Meta 的 URL（`:712-747`）；同时写一个 `localStorage` 标记，下次启动时跳过它的加载（`:443-456`）。
- 命名空间为 `<workspaceId>`；Electron 辅助窗口为 `<workspaceId>:<windowId>`（`:159-173`）。
- Electron 主窗口和所有 Web 标签页都使用不带窗口后缀的工作区命名空间。

**CLI**

- 每个工作区一个 `SqliteRepoStore`，位于 `<dataDir>/loro-repo/<ws>/repo.sqlite3`。它既提供 repo 存储，也通过 `AliasedRemoteCursorStore` 提供游标存储（`apps/cli/src/lib/loro/sqlite-repo-store.ts:64-83`）。
- Streams adapter 使用旧的 `remoteCursorStore` + `onPersist*` 选项（`apps/cli/src/lib/loro/streams-transport.ts:39-61`）。
- 这些回调只是安排一次合并 flush（防抖 200 ms），然后立刻返回（`apps/cli/src/lib/loro/doc.ts:614-622,756-783`）。

**屏障的执行时机。** 在 streams-crdt 0.15.1 中，`persistRemoteCursor` 会先等待屏障，然后在读取路径里（`finalizeCursor`）保存游标。屏障慢只会推迟该房间的下一批数据，不会丢数据。

## 发现的不一致

1. **CLI 游标领先于数据（从代码确认，未复现）。**
   - 保存游标时，它所覆盖的状态可能还只在内存里。
   - 如果 daemon 在"防抖 + flush"这段时间内崩溃或被杀，`remote_cursors` 就会领先于 SQLite 中的数据。
   - 重启后会越过缺失的条目继续读，这个空洞一直保留，直到有什么触发了 bootstrap。
2. **CLI 多个进程共用游标行（可能存在，未复现）。**
   - 一次性命令会打开 daemon 的同一个 SQLite 文件，并在创建时就接上 Streams（`apps/cli/src/lib/command-runtime.ts:246`）。
   - 每个进程各自在内存里 hydrate 自己的副本，但加入房间时读取的是共用的 `remote_cursors` 行。
   - 如果一个进程在 daemon 推进数据和游标之前就完成了 hydrate，它会从 daemon 的尾部继续读。这正是上游说的"旧副本 + 共享游标"情形。
   - 自动快照上传是开着的（`canUpload: true`，防抖 5 秒）。上游已经证明：如果进程存活超过这个防抖时间，这种情形可能发布一个缺失远端条目的快照。
3. **Web 标签页共用同一个 repo 库和游标库。** 这正是上游那个确定性的共享 IndexedDB 复现场景。Electron 主窗口通常只有一个实例，但 Web 端没有任何机制保证这一点。
4. **0.20.0 的持久化空洞影响 Lody 的每一个副本。** 上游已在 #132 修复。

**相关但不在本范围内。** 本地数据平面用 `exportJson(from: version())` 发送 Flock 增量（`packages/shared/src/local-loro-transport.ts:578-580`、`local-loro-data-plane-server.ts`）。它依赖同样的"版本向量相等就代表完整"的假设，因此无法修复渲染端与 CLI 副本之间"版本相同但缺数据"的空洞，需要单独决策。

## 提案

### 阶段 0：只升级库

- 把 `loro-repo` 升到 0.20.3（0.20.4 发布后可升到 0.20.4），并删除 `patches/loro-repo.patch`。
- 所有组合方式保持不变：渲染端继续用独立游标库，CLI 继续用旧选项。
- 实际变化：
  - 由 journal 取代基于版本的跳过写入；
  - IndexedDB 升级到 v4；
  - SQLite 不需要迁移。
- **回滚：** 回退依赖是安全的。0.20.0 能打开 v4 库、能读混合日志，游标也没有被动过。
- **需要确认：**
  - 去掉补丁后 `doc-meta-subscription.test.ts` 仍然通过；
  - Lody 中没有匹配 IndexedDB 错误文本的代码；
  - `RepoStorageError` 的日志足够有用；
  - 在大工作区上观察追加 bootstrap 文件带来的存储增长和压实行为。

**阶段 0 的实际实现（[LodyAI/Lody#1049](https://github.com/LodyAI/Lody/pull/1049)）。**

- catalog 现在精确锁定 `loro-repo: 0.20.3`，补丁已删除。
- 这期间 `main` 已升级到 streams-crdt 0.16.0（见 [streams-crdt 0.16 升级](../../implemented/bug-fix/2026-09-27-streams-crdt-0.16-upgrade.zh.md)），所以按包设置的 peer 例外从 `loro-repo@0.20.0` 改为 `loro-repo@0.20.3`。
  - 0.20.3 包装了 streams-crdt 的两处代码：`createFlockAdapter`，以及 `persistRemoteCursor` 和调用它的 `finalizeCursor`。
  - 这两处在 0.15.1 与 0.16.0 发布包中的产物代码完全一致。
  - 采用精确锁定，是为了避免之后的补丁版本不声不响地落到这个例外之外。
- 安装后的 0.20.3 中，`ready()` 会先等待 `ensureMetaLiveMonitor()` 再启动 persister，与原补丁的效果完全一致。
- **跨版本验证**（一次性脚本，未提交）：
  - 已发布的 0.20.0 和 0.20.3 在同一个 fake-indexeddb 数据库和同一个 `SqliteRepoStore` 文件上按 旧 → 新 → 旧 → 新 → 新 交替运行。
  - 每一步中，两个版本都能读到对方写入的全部文档元数据和命名 Flock 键。
  - IndexedDB 最终为 v4，并带有 `replica-checkpoints`。
  - 这支持上面"不涉及游标的数据可以安全回滚"的判断，但不覆盖新旧版本同时写入的情况。
- 大工作区的存储增长观察仍未完成。
- **更正：strict 持久化在阶段 0 就已生效。**
  - 0.20.3 的 `IndexedDBStorageAdaptor.openTransaction` 对所有涉及 meta 或命名 Flock 存储的 readwrite 事务都使用 `durability: "strict"`，与游标是否 replica-bound 无关。
  - 因此从阶段 0 起，渲染端 `onPersist*` → `repo.flush()` 的屏障在每次 cloud 同步事件上都要付出一次 strict 提交。
  - 阶段 1 下列出的 strict 事务成本关，必须在阶段 0 大范围发布之前测量，而不是之后。
- **存储持续失败时 journal 的内存：** 当 `storage.save` 一直失败（例如超出配额）时，journal 会保留每一份收到的负载副本。如果全量文件兜底也写不进去，三次重试后的兜底并不能限制这部分增长。以前只保留一个版本向量。

**阶段 0 风险模拟（2026-09-27）。** 全部使用已发布的 0.20.0（需要时加上 Lody 补丁）和 0.20.3。IndexedDB 场景在真实 Chromium 中运行：macOS arm64 上开启 Node 集成的 Electron 39.5.1 渲染进程。

| 风险                                                              | 结果                                                                                                                                              | 结论                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| strict 持久化，单个屏障（meta + 1 个 Flock，5k 文档，300 个事件） | `repo.flush()` p50 从 0.6 ms 升到 8.1–8.6 ms；去掉 strict 后为 0.4 ms。主线程卡顿 ≤ 3.3 ms，所有写入均已持久化。                                  | 只在 cloud 和 dual 模式下有实际成本，不影响正确性                                   |
| strict 持久化，11 个房间同时 flush                                | p50 从 2.0 ms 升到 44 ms，p95 约 60 ms。让并发屏障共用一次 flush 也没用，因为一次 flush 按每个脏资源约 3.7 ms 计费。                              | 需要上游合并事务：[loro-repo#140](https://github.com/loro-dev/loro-repo/issues/140) |
| 纯本地桌面（11 个 Flock，数据平面每秒 220 次更新，无屏障）        | 两个版本在突发后都没有积压，主线程卡顿 ≤ 4.5 ms，所有房间都已持久化。约 1100 个事务现在全部是 strict。                                            | 不影响延迟，只是磁盘同步次数变多                                                    |
| 0.20.0 连接未关闭时 IndexedDB 从 v3 升到 v4                       | 升级用时 11.8 ms，没有 `blocked`。旧连接下次写入时会以 v4 重新打开，之后两个版本都能读到全部写入。                                                | 已排除                                                                              |
| `doc-metadata` 监听事件变多                                       | 0.20.0 + 补丁与 0.20.3 在远端导入（有无紧接的读取）、本地写入、无变化回声和 50 个文档的批量导入下，事件数完全相同。                               | 已排除                                                                              |
| bootstrap 带来的存储增长（SQLite）                                | 0.20.3 会原样追加收到的快照（37 KB，而 0.20.0 只写 0.8 KB 的变更），且只追加一次。重复相同的 bootstrap 不再追加，压实后回到与 0.20.0 相同的大小。 | 有上限：压实前最多多出一份快照                                                      |
| 存储持续失败时 journal 的内存                                     | 积压字节等于真正新到的数据量（收到 1,465 KB，排队 1,465 KB）。正常情况下只剩尚未 flush 的尾部（14 KB）。                                          | 受中断期间的真实流量限制                                                            |
| 磁盘满时打开工作区                                                | 已升级到 v4 的库仍能只读打开。升级后第一次打开会失败，但 0.20.0 在有待压实数据时同样打不开。                                                      | 不算退化，记录在 [loro-repo#139](https://github.com/loro-dev/loro-repo/issues/139)  |

另外，真实磁盘写满时，两个版本的 CLI daemon 都会因日志写入的 `ENOSPC` 未被捕获而退出，见 [#1054](https://github.com/LodyAI/Lody/issues/1054)。

### 阶段 1：渲染端使用 replica-bound checkpoint

- 用下面的配置替换 `remoteCursorStore` + `onPersist*`：

  ```ts
  persistence: createRepoStreamsPersistence(repo, {
    documentRemoteCursorStore: remoteCursorStore,
  });
  ```

  - LoroDoc 游标继续用现有 store，URL 别名处理也保持不变。
  - Meta 和命名 Flock 的游标移进 repo 库，Web 标签页和多窗口的情形因此在构造上就是安全的。

- 屏障也随之替换：每次同步事件不再执行整库 `repo.flush()`，而是按资源调用 `persist*Now`。
- Meta 恢复改为通过 `repo.getReplicaCheckpointStore({ kind: "meta", flock: repo.getMeta() })` 删除。
  - 继续删除旧游标库里的条目将不再有任何作用。
  - 启动时的 `localStorage` 跳过标记，要改成在 cloud transport 接入之前删除 Meta checkpoint。原因是 checkpoint 在 repo 创建时就已捕获，不再是按需加载。
- **不要把现有的 Meta/Flock 游标复制进 checkpoint。** 复制过来的游标恰好具有这次改动要消除的性质：进度不是和数据一起捕获的。
  - 空的 generation 会让每个房间 bootstrap 一次并合并；只要远端快照是完整的，历史空洞就能借此修复。
  - 旧游标库里的条目保持不动。回滚后的旧版本会从这些更早的 offset 继续读，只会产生无害的重放。
- **上线前必须过的成本关：**
  - 大工作区首次打开时的 bootstrap 次数和字节量；
  - 在繁忙 Meta 流下，macOS Chromium 上 strict 事务的频率，以及它占用的主线程和磁盘时间。
  - 如果 strict 写入太贵，退回阶段 0 的行为，而不是放宽写入顺序。
- **checkpoint 的 key（已知限制）：** key 是不透明的 stream URL。因此网关 origin 变化时会触发 bootstrap，而过去 `getLoroStreamsRemoteCursorUrlAliases` 可以避免这种情况。改为按 `(bucketId, streamId)` 作 key 需要上游修改。

### 阶段 2：CLI 使用真正的屏障（不依赖上游）

- 把"只安排、不等待"的回调，换成真正等待的按资源屏障。可以用已弃用的 `createRepoStreamsPersistence(repo, aliasedCursorStore)`，也可以自己组装等价的 bundle：
  - `persistMetaNow`
  - `persistFlockDocNow(id, flock)`
  - `persistDocNow(id, doc)`
- 这些屏障只写待处理的 journal 条目或文档增量，而不是整个仓库。当初正是整库 `repo.flush()` 的"每秒 3.6 次 × 61 ms"成本，才引入了合并器。
- 非屏障类的持久化继续走合并器。
- **合并前测量：** 在长会话上测每批数据的屏障延迟和 catch-up 吞吐。
- **这只修复不一致 1。** 不一致 2 仍然存在，因为游标行依旧是共用的。

### 阶段 3：CLI SQLite 使用 replica-bound checkpoint（依赖上游）

- **上游需要在 `SqliteRepoStore` 中完成：**
  - 用 `replica_checkpoints(resource_key PRIMARY KEY, generation, cursors_json)` 表实现 `loadMetaReplica` 和 `loadFlockDocReplica`；
  - 在同一个 better-sqlite3 事务里捕获 snapshot、更新和 checkpoint；
  - 每次写游标时校验 generation；
  - 在 `deleteFlockDoc` 的同一个事务里删除 checkpoint 行，这也覆盖了 `fi`/`fis` 的保留期过期删除。
- **之后 Lody 切换为** `createRepoStreamsPersistence(repo, { documentRemoteCursorStore: aliasedCursorStore })`。每个进程（daemon 或一次性命令）都拿到自己捕获的游标，不一致 2 因此消除。
- **迁移：** `CREATE TABLE IF NOT EXISTS`，不复制 `remote_cursors`，每个 Meta/Flock 房间 bootstrap 一次。
- **回滚：** 旧版本会忽略新表，并从过期的 `remote_cursors` 行继续读，只产生重放。checkpoint 落后于数据的情况总是安全的。
- **唯一不安全的回滚序列：**
  1. 旧版本删除了一个命名 Flock，但留下了它的 checkpoint 行；
  2. 新版本用这个过期游标重新打开这份空文档；
  3. 于是更早的流历史被跳过。

  上游设计必须堵住这一点。例如让 checkpoint 记录捕获时 base/日志的指纹，指纹不匹配就丢弃 checkpoint。IndexedDB 也有同样的缺口，但渲染端目前没有删除命名 Flock 的代码。

- **上游进展：** [loro-dev/loro-repo#137](https://github.com/loro-dev/loro-repo/pull/137) 实现了这项能力，尚未合并，本文也还未评审。
  - 它没有用指纹，而是用写在数据库 schema 里的删除触发器来堵回滚缺口：删除 base 行，或在没有 base 行时删除 update 行，都会一并删掉 checkpoint。
  - 这之所以成立，是因为自 #99 以来所有 SQLite 版本删除 Flock 数据只有两条路径：`deleteFlockDoc`，以及先写 base 再删 update 的压实。所以旧版本执行删除时触发器同样生效，也不会把压实误判为删除。
  - base 行写入从 `INSERT OR REPLACE` 改为 UPSERT，开启 `recursive_triggers` 时也不会误触发。
- **IndexedDB：** 同类问题记录在 [loro-dev/loro-repo#136](https://github.com/loro-dev/loro-repo/issues/136)，也涵盖不同版本的标签页同时打开的情况，它是 Web 端推进阶段 1 的前置条件。

## 备选方案

- **在同一个版本里既升级又切换组合方式。**
  - 否决：一旦出现回归，无法判断是哪项改动引起的。
  - 阶段 0 提供了一个完全不涉及游标的回滚点。
- **用现有游标预填 checkpoint，以免 bootstrap。**
  - 否决：这会把可能并未与数据绑定的进度放进一个声称已绑定的 store，恰恰让最需要修复的那些缓存上的新保证失效。
- **渲染端继续用两参数工厂。**
  - 否决作为最终形态：它保留了写入顺序，但没有原子恢复，共享数据库的标签页仍不安全。
- **CLI 用文件锁强制单写者**，以代替阶段 3。
  - 如果上游工作延迟，这是解决不一致 2 的一个更小的方案。
  - 但它要么在 daemon 运行时阻塞一次性命令，要么强制一次性命令都经 daemon 转发。这是一个尚未做出的产品决策。

## 验证限制

本文是对上游 `5862a2b`、streams-crdt 0.15.1 和 Lody `d0f2d9b7` 代码的桌面分析。

- 上述不一致均未在 Lody 中复现。
- 没有运行过任何迁移。
- 没有测量过任何性能数字。
- 上游测试使用 fake-indexeddb，只能证明事务顺序，不能证明断电情况下的持久性。
