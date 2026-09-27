# 检测数据盘写满，降级而不是半途失败，并自动恢复

Status: implemented
Translation: current

[English](2026-09-27-local-storage-health.md)

关联：issue #1054（第 2、3 层）。约定：[本地存储健康](../../../../specs/local-storage-health.zh.md)。

## 摘要

存放 Lody 数据的磁盘写满后，repo 写入以 `SQLITE_FULL` 失败，却无人察觉：合并 flush 只打
debug 日志，loro-repo 把后台保存失败打印到控制台，新回合照常去创建 worktree 并半途失败。
现在 daemon 按错误码识别"存储已满"，用 `statfs` 采样剩余空间，并在机器心跳上发布一个很小的
存储字段。存储处于严重状态时，它会在开始前拒绝新回合、预先准备的 worktree 和附件复制，把未
保存的更改留在内存中，空间一恢复就立即 flush。桌面端显示中英双语横幅，并在有未保存更改时退出
前询问。在写满的 256 MiB RAM 盘上，真实 daemon 保持存活，以可读的提示拒绝了回合，并在释放
空间后约三秒内保存了全部内容。它不负责恢复渲染端失效的 IndexedDB 连接（issue #417），也没有
增加压舱文件。

## 问题

issue #1054 表明存储本身能撑过写满：SQLite 拒绝写入但不损坏，之后的一次 flush 会保存全部内容。
缺的是周边的一切：没有东西检测这种情况，没有东西告诉用户工作只在内存中，也没有东西阻止新工作
开始后半途失败。第 1 层修复（磁盘写满时文件日志不再让 daemon 崩溃，PR #1056）是独立的；本改动
既不依赖它，也不与它冲突。

## 决定

**在存储适配器处观察写入。** loro-repo 0.20.3 在后台持久化本地编辑，保存失败交给只会打印的
`logAsyncError`，不提供错误钩子。所有 repo 写入都经过 `StorageAdapter`，所以用 shared 里的
`observeStorageAdapterWrites` 包装它并报告每次结果。包装保持可选方法缺席（loro-repo 会探测
它们），并原样重新抛出错误，这样保存失败的内容仍是脏的，下一次 flush 会重试。CLI 包装 SQLite
适配器，渲染端用同一个工具包装 IndexedDB。

**按错误码分类，从不看消息。** `classifyStorageFullError` 会遍历 `cause` 和
`AggregateError.errors`（loro-repo 就是这样包装快照回退失败的）。它接受 `ENOSPC`、`EDQUOT`、
`SQLITE_FULL`、code 为 `quota` 的 `RepoStorageError` 和 `QuotaExceededError`。它不接受
`unavailable`：那是 #417 的问题，不是剩余空间的问题。

**进程内唯一的监视器。** `StorageHealthMonitor` 放在 `LodyFleet` 中，因为数据目录按进程划分，
而 repo 按 workspace 划分。每个 workspace 的 `LoroDocumentManager` 把自己的 flush 注册为恢复
目标，并在销毁 repo 之前注销。只有所有目标都 flush 成功，未保存状态才会清除。一个代数计数器
防止与新失败竞争的恢复把它清掉。单凭剩余空间永远不会清除它。

停止 workspace（列表协调、撤权、退出）不能丢掉持有未保存更改的 repo。`cleanUp` 显式 flush，
而不是经过会吞掉失败的合并器，并且只在 flush 成功后注销。如果这次 flush 因存储已满被拒绝，
manager 保持 repo 打开并保留注册；监视器的恢复流程先 flush 再销毁它。在这一轮未结束时以
`saved: false` 注销会被标记为丢失，此后本进程内这一轮不会再结束。第一版在最终 flush 之前就注销，
导致写满时被停止的 workspace 丢失更改，而监视器随后在没有任何目标的情况下清除了
`unsavedSince`；评审发现了这个问题。

**阈值结合卷的比例与绝对上下限。** 严重阈值是卷的 1%，限定在 256 MiB 到 1 GiB 之间。256 MiB
够一次 flush、SQLite 日志和一次 checkpoint 使用，但不够创建 worktree 或安装依赖。1 GiB 上限
避免大磁盘在还剩几 GB 时就降级。警告阈值是 5%，限定在 1 到 5 GiB 之间，保证在拒绝工作之前很早
就提示。小卷上两者分别被限制为磁盘的四分之一和一半，这让 256 MiB 测试盘在空闲时保持健康。
离开一个级别需要 10% 的余量。

**发布在机器心跳上。** 其他方案都不合适：

- `CliRuntimeState` 的 issue 只能到达 Electron 主进程。
- `machine-monitor` 只在有观察者持有租约时运行。
- 持久文档写入需要的恰恰是那块已满的磁盘。

该字段形状固定，复用心跳自己的 key（级别变化会替换尚未发送的心跳），且只在级别变化时改变，
而级别变化受间隔约束。无法解析的字段会被捕获并丢弃；如果拒绝整条记录，更旧或更新的读者就会把
在线的机器读成离线。运行时 issue `local_storage_unsaved` 仍会上报，因为桌面端的退出路径能读到它。

**在工作开始处拦截，与内存压力拒绝放在一起。**

- *回合开始（创建和继续）* 这一个入口覆盖了从界面、CLI 和 MCP 创建会话，以及之后所有的重活：
  创建 worktree、准备依赖、启动 Agent。它通过内存压力所用的同一个工具，以新的
  `storage_critical` 提示失败，因此指针会前进，回合不会循环。
- *预先准备 worktree* 被拒绝，因为这时只会由第一个回合来创建 worktree，而那个回合同样受限。
- *复制附件*到本地存储会以 `LODY_STORAGE_CRITICAL` 被拒绝；输入框显示这个原因，而不是回退到
  云端上传。
- *回合 diff 不受限*，因为跳过会永久丢失，而写入失败只是等待空间。
- *图片上传不受限*：它们属于正在运行的回合。

剩余空间读数超过 2 秒时，拦截点会重新 `statfs`，所以 60 秒的轮询不会让拦截变慢。

**渲染端的 quota 错误显示同一个横幅。** `create-workspace-runtime` 用 shared 的
`StorageFullRecovery` 包装它的 IndexedDB 适配器。`quota` 失败会设置渲染端 atom。之后
的成功写入本身不会清除它：IndexedDB 可能接受一次较小的 doc 写入，而失败的 meta 仍是脏的。成功写入
只会触发一次 `repo.flush()`（至多每 5 秒一次；flush 失败则在 5、15、60 秒后重试）。只有这次 flush
成功、且代数栅栏表明期间没有新的拒绝时，这一轮才结束，与 CLI 监视器的规则相同。本 PR 的第一版在任何
一次成功写入时就清除，评审发现了这个问题。横幅优先显示写入失败而不是空间不足，
优先显示本机而不是同事的机器。这是 #417 危机模式中的"提示"部分。失效连接的断路器、阻塞式恢复
弹窗以及只操作文件系统的"管理存储"面板仍属于 #417。

**退出时警告。** `LodyFleet.shutdown` 在每个 runtime 都尝试过最终 flush 之后记录
`unsavedSince`。Electron 的退出屏障新增了可选的 `confirmQuit` 步骤，它从运行时状态读取
`local_storage_unsaved` 并询问用户。询问失败按"是"处理，以免坏掉的对话框把用户困在应用里。

**合并 flush 的失败**现在以警告记录，并写明这一连串失败从何时开始，至多每 5 分钟一次；
flush 再次成功时记录一条 info。

## 压舱文件（第 4 层）：不实现

预留一个文件（比如 256 MiB），在磁盘写满时删除，可以为一次干净的 flush 和退出腾出空间。
目前它不值这个代价：

- 每次安装都要永久付出这些空间。APFS 上释放的块会回到与其他卷和本地快照共享的容器中。而且
  macOS 没有 `fallocate`，文件必须完整写出。
- 删除后，其他进程可能在 Lody 用上之前就占掉这些空间。重建文件需要一套策略，而这套策略本身
  就可能把磁盘重新推回警告状态。
- daemon 在磁盘写满时已不再崩溃（PR #1056），并把更改留在内存中直到空间恢复。压舱文件额外
  带来的只是磁盘持续写满时的干净退出，而退出警告已经把这个决定交给了用户。

更好的下一步是 #417 的"管理存储"：列出 Lody 自己能回收的空间（worktree、日志、缓存），让用户
快速释放。

## 验证

自动化测试使用注入的时钟、手动定时器和故障注入，不做真实等待：

- `apps/cli/src/lib/storage-health.test.ts`：
  - 阈值；
  - 滞回；
  - 拦截点；
  - 每次级别变化只通知一次；
  - 可分类的失败立即变为严重，只有完整的 flush 能清除，且恢复有频率限制；
  - 用 `PRAGMA max_page_count` 限制真实的 `SqliteRepoStore`，产生真正的 `SQLITE_FULL`。
    写满时写入的二十个文档，在销毁第一个 repo 之前通过第二个连接读回。
  - 写满时的清理：在真实的受限 SQLite repo 上调用 `LoroDocumentManager.cleanUp()` 会让它保持
    打开，空间恢复后由恢复流程保存，第二个连接能读到全部十个文档。使用旧顺序（先注销、flush
    失败被吞掉、再销毁）时，清理以 `database or disk is full` 失败。未保存就注销的目标会让这一轮
    保持未结束；去掉这道栅栏会让对应测试失败。
  - 消融：去掉恢复 flush 后，两个行为测试都会失败。SQLite 测试的第一个版本在消融时仍然通过，
    因为 `repo.destroy()` 自己会 flush；改为通过第二个连接读取后修正了这一点。
- `apps/cli/src/lib/loro/presence.test.ts`：级别变化会立即写出心跳，且字段能经受真实的
  `EphemeralStore` 往返。
- `packages/shared/tests/presence.test.ts`：未知的存储值不会让心跳丢失；消融 `.catch` 会让它
  失败。
- `packages/shared/tests/storage-health.test.ts`：分类，以及包装保持可选方法缺席；在真实
  `LoroRepo` 上，meta 以 `QuotaExceededError` 被拒绝后，另一个 doc 写入成功不会结束这一轮，恢复
  flush 在 meta 仍被拒绝时保持降级并按退避重试，空间恢复后 meta 落盘才结束；另有一个用例验证与新
  失败竞争的 flush 不会结束这一轮。消融"任意成功即清除"会让前两个用例失败，消融代数栅栏会让竞争
  用例失败。
- `apps/cli/tests/session-execution-service.test.ts`：内存压力拒绝的用例对存储参数化，覆盖创建
  和继续两种情况。
- `packages/components/tests/local-storage-banner.test.tsx`：横幅状态、在 presence 刷新时保持
  值的同一性，以及用 daemon 实际发布的负载分别以中英文渲染真实的容器组件。
- `apps/electron/src/main/services/desktop-exclusion.test.mjs`：取消的退出保持应用打开，下一次
  退出则正常停止。

真实运行：在 256 MiB RAM 盘上，以干净环境和 `LODY_DATA_DIR=/Volumes/lodysh/lody` 运行一次性的
`lody start`。运行的是本分支在本地合并 PR #1056 后的版本，因为没有 #1056 时 daemon 会在第一次
日志 `ENOSPC` 时退出。这个合并从未推送。

1. 用 `dd` 写满磁盘直到 `ENOSPC`，并关闭其文件描述符。4 秒内日志出现
   `Free space critical … 0 MiB available; disk-heavy work is paused`。
2. 随后出现 `Local write failed (SQLITE_FULL) in loro-repo compactMeta`。
3. 一个探针以渲染端的方式读取本地数据平面，看到心跳变为
   `{"level":"critical","reason":"write-failed","availableBytes":0,"unsavedSince":…}`。
4. 通过本地控制 socket 发送的 `session/create` 被确认；daemon 记录 `Lody paused new agent turns…`，
   没有启动任何 Agent。
5. 删除填充文件后约 3 秒内，日志出现 `Free space recovered (250 MiB)` 和
   `Saved changes pending since 11:49:05.421Z`，心跳去掉了该字段。
6. 第二个 SQLite 连接在磁盘上找到了写满时写入的 `storage_critical` 提示。
7. 再次写满并引发一次写入失败后，SIGINT 打印 `Stopping with local changes unsaved since …`，
   并以 code 0 退出。

四种横幅状态的中英文 Storybook 截图经过人工检查，由此发现中文句子之间多了一个空格，现已改为
可本地化的拼接 key。

## 局限

- 桌面横幅、退出对话框和渲染端 quota 路径由 DOM 测试和 Storybook 验证，没有在写满磁盘上的
  打包桌面应用中验证。
- loro-repo 仍会带堆栈打印每一次后台保存失败；schema 升级后的第一次打开仍需写盘
  （loro-dev/loro-repo#139）。
- 若被清理的 repo 仍在等待空间时同一 workspace 又被启动，会在同一个 SQLite 文件上打开第二个
  repo；两者都追加 CRDT 更新，加载时合并。
- `unsavedSince` 只覆盖 repo 写入。其他存储（schedules、operation store、diff store）各自失败，
  未被跟踪。
- 退出对话框读取 Electron 最近一次轮询到的运行时状态，最后几秒内发生的失败可能不会显示。
- 应用级横幅不显示同事的机器；字段已在他们的心跳上，留给以后按机器展示的界面。
