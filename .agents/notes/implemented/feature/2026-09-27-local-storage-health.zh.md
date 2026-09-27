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

**在存储适配器处观察写入。** loro-repo 在后台持久化本地编辑，保存失败交给只会打印的
`logAsyncError`，不提供错误钩子。所有 repo 写入都经过 `StorageAdapter`，所以用 shared 里的
`observeStorageAdapterWrites` 包装它并报告每次结果。包装保持可选方法缺席（loro-repo 会探测
它们），并原样重新抛出错误，这样保存失败的内容仍是脏的，下一次 flush 会重试。CLI 包装 SQLite
适配器，渲染端用同一个工具包装 IndexedDB。

自 loro-repo 0.21.0（#1066）起，元数据和具名 Flock 负载通过适配器可选的原子 `saveMany` 提交，两个
真实适配器都实现了它。包装会转发它，并把它当作一次写入来观察。漏掉它不会报错，但会悄悄退回为
逐个负载提交，抵消 loro-repo#141 的单个严格事务。被拒绝的 `saveMany` 会回滚全部负载，repo 会全部
重试，所以它和其他写入一样只是一次被分类的失败。

**按错误码分类，从不看消息。** `classifyStorageFullError` 会遍历 `cause` 和
`AggregateError.errors`（loro-repo 就是这样包装快照回退失败的）。它接受 `ENOSPC`、`EDQUOT`、
`SQLITE_FULL`、code 为 `quota` 的 `RepoStorageError` 和 `QuotaExceededError`。它不接受
`unavailable`：那是 #417 的问题，不是剩余空间的问题。

**进程内唯一的监视器。** `StorageHealthMonitor` 放在 `LodyFleet` 中，因为数据目录按进程划分，
而 repo 按 workspace 划分。每个 workspace 的 `LoroDocumentManager` 把自己的 flush 注册为恢复
目标，并在销毁 repo 之前注销。只有所有目标都 flush 成功，未保存状态才会清除。一个代数计数器
防止与新失败竞争的恢复把它清掉。单凭剩余空间永远不会清除它。

停止 workspace（列表协调、撤权、退出）不能丢掉持有未保存更改的 repo。`cleanUp` 显式 flush，
而不是交给 `repo.destroy()`（它失败时会连同更改一起丢掉 repo），并且只在 flush 成功后注销。如果这次 flush 因存储已满被拒绝，
manager 保持 repo 打开并保留注册；监视器的恢复流程先 flush 再销毁它。在这一轮未结束时以
`saved: false` 注销会被标记为丢失，此后本进程内这一轮不会再结束。第一版在最终 flush 之前就注销，
导致写满时被停止的 workspace 丢失更改，而监视器随后在没有任何目标的情况下清除了
`unsavedSince`；评审发现了这个问题。

第一次修复只覆盖了最终 flush。卸载一个打开的会话或机器文档会先持久化它，所以磁盘写满时
`SessionDocument.destroy()` 会在清理到达最终 flush 之前就抛出 `SQLITE_FULL`；fleet 已经丢弃了
runtime，没有任何东西能完成这次停止。评审也发现了这一点。现在每个文档的释放都会捕获存储已满的
失败并继续：文档留在 repo 中且仍是脏的，它的包装对象照常释放；是否关闭 repo 只由最终 flush 决定。
`whenRepoReleased()` 在 repo 真正销毁后才完成；fleet 按 workspace 保存这个 promise，再次启动同一
workspace 时会先等待它，而不是在同一个 SQLite 文件上打开第二个 repo。退出时的警告会列出恢复流程
仍然持有的 workspace。

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

- _回合开始（创建和继续）_ 这一个入口覆盖了从界面、CLI 和 MCP 创建会话，以及之后所有的重活：
  创建 worktree、准备依赖、启动 Agent。它通过内存压力所用的同一个工具，以新的
  `storage_critical` 提示失败，因此指针会前进，回合不会循环。
- _预先准备 worktree_ 被拒绝，因为这时只会由第一个回合来创建 worktree，而那个回合同样受限。
- *复制附件*到本地存储会以 `LODY_STORAGE_CRITICAL` 被拒绝；输入框显示这个原因，而不是回退到
  云端上传。
- _回合 diff 不受限_，因为跳过会永久丢失，而写入失败只是等待空间。
- _图片上传不受限_：它们属于正在运行的回合。

剩余空间读数超过 2 秒时，拦截点会重新 `statfs`，所以 60 秒的轮询不会让拦截变慢。

**渲染端的 quota 错误显示同一个横幅。** `create-workspace-runtime` 用 shared 的
`StorageFullRecovery` 包装它的 IndexedDB 适配器。`quota` 失败会设置渲染端 atom。之后
的成功写入本身不会清除它：IndexedDB 可能接受一次较小的 doc 写入，而失败的 meta 仍是脏的。成功写入
只会触发一次 `repo.flush()`（至多每 5 秒一次；flush 失败则在 5、15、60 秒后重试）。只有这次 flush
成功、且代数栅栏表明期间没有新的拒绝时，这一轮才结束，与 CLI 监视器的规则相同。本 PR 的第一版在任何
一次成功写入时就清除，评审发现了这个问题。横幅优先显示写入失败而不是空间不足，
优先显示本机而不是同事的机器。这是 #417 危机模式中的"提示"部分。失效连接的断路器、阻塞式恢复
弹窗以及只操作文件系统的"管理存储"面板仍属于 #417。

**有未保存更改时，渲染端 repo 比它的 runtime 活得更久。** shared 的 `RepoStorageGuard` 负责
渲染端 repo 的存储生命周期。销毁 workspace runtime（切换或离开 workspace）时先做一次最终
flush，只有没有未保存更改时才销毁 repo；否则 repo 保持打开，恢复流程继续重试，保存后再销毁。
一个窗口级的登记表（`renderer-storage-episodes`）保存所有这样的一轮，包括 runtime 已经不在的，
所以 provider 卸载时横幅不再被清掉。第一版在销毁时清掉横幅，并连同未保存的更改一起销毁了
repo；评审发现了这个问题。

**退出时警告。** `LodyFleet.shutdown` 在每个 runtime 都尝试过最终 flush 之后记录
`unsavedSince`。Electron 的退出屏障新增了可选的 `confirmQuit` 步骤。当本地 Agent 上报
`local_storage_unsaved`，*或*任何窗口通过 `storage.rendererUnsaved` 上报了渲染端未保存的更改
时，它都会询问。Agent 的磁盘和窗口的 IndexedDB 是不同的存储，Agent 健康不能说明窗口的情况。

询问之前，主进程向每个这样的窗口推送 `storage.quitCheck`。窗口 flush 所有被保留的 repo，并回复
仍未保存的部分。3 秒内没有回复的窗口保留上一次的上报。询问失败按"是"处理，以免坏掉的对话框把
用户困在应用里。第一版只检查 Agent，评审也发现了这一点。

**关闭或重新加载单个窗口同样受保护。** 下一版仍会在窗口的 `webContents` 被销毁时丢掉它的上报，
而关闭窗口（Linux、没有托盘的 Windows、任何辅助会话窗口）或按 Cmd/Ctrl+R 会在不做检查的情况下
销毁渲染端内存中的 repo。评审发现了这一点，该版本自己的"局限"一节也写到了它。

现在，只要渲染端登记表中还有 repo 持有未保存更改，它就会取消 `beforeunload`。这覆盖了关闭、重新
加载、强制重新加载、导航和 `location.reload()`。Electron 把每次取消报告为 `will-prevent-unload`，由
主进程的 `WindowStorageBarrier` 接手：

- 它请该窗口 flush（`storage.quitCheck`）；回复已保存时，重做原来的操作。
- 仍未保存时，显示退出对话框的单窗口版本（"仍然关闭/重新加载"）；取消则保留窗口、repo 和上报。
- 一次批准只放行一次卸载：它绑定到当时看到的未保存代数，只能使用一次，10 秒后失效。

主进程发起的操作会记录要重做什么：窗口关闭、Cmd/Ctrl+R 快捷键、"视图"菜单的重新加载 / 强制重新
加载（现在是点击项，因为内置 role 会直接重新加载），以及恢复时的重新加载。渲染端自己发起的导航没有
可重做的内容，由用户在批准有效期内再试一次，否则会再次被询问。获批的退出期间，窗口可以自由卸载。上报
只在文档消失时才会丢掉，而不是在批准时，所以其间发生的退出仍能看到它；崩溃或未获批的销毁会被记录为
丢失，无法询问窗口时保留它的上报。

这个屏障的第一版会把批准一直保留到文档被替换：页面自己发起的导航在"仍然重新加载"之后没有任何东西
可重做，用户继续编辑，之后下一次关闭就会不经询问地丢掉新的更改。评审发现了这一点。现在：

- 主进程在每次未保存上报时递增该窗口的代数，批准只对它看到的那一代有效。
- 每次有新的写入被拒绝，渲染端都会重新上报，即使在最早 `since` 不变的一轮之内也是如此。保护器上报每一
  次拒绝（`onWriteRefused`），登记表至多每 500 毫秒发送一次修订号。
- 批准同样只能使用一次，并且很快过期。

**退出登录和清除缓存会强制销毁其他窗口，所以先要获批。** 它们调用 `destroy()`，不会运行
`beforeunload`，卸载保护因此完全看不到它们；评审同样发现了这一点。现在两者都经过 `tearDownWindows`，
它在销毁前调用 `WindowStorageBarrier.approveTeardown`：

- 每个列出的、持有未保存更改的窗口先 flush；
- 仍未保存的部分统一确认一次（"仍然退出登录" / "仍然清除"）；
- 取消则什么都不销毁，上报和 repo 保持原样。

退出登录会在共享的退出流程清除任何本地认证状态或跳转之前，先通过 `auth.prepareSignOut` 询问；
取消会返回 `sign_out_cancelled_unsaved_storage`，会话、CLI 和所有窗口都保持不变。`signOut` 本身会
再批准一次，以防其间有窗口出现了新的未保存更改。被拒绝的缓存清除会保持待执行状态，留到下一次加载。

更正：这一点对应用内标志成立，因为它留在 localStorage 中；但对 `lody app reset-cache` 布置的清除
不成立。main 把它交给第一个启动的窗口后就忘掉了，而磁盘上的请求早已删除，于是一次"取消"就让它永久
丢失，用户也无从得知命令被吞掉了。评审发现了这一点。现在 main 以认领的方式交出清除
（`app.claimPendingLocalClear`），同一时间只给一个窗口，只有当该窗口报告清除已执行
（`app.settlePendingLocalClear('cleared')`）才忘掉它。收到 `declined` 时，main 保持它待执行、留给
下一次加载，并以原始时间把请求写回磁盘，所以用户直接退出而不是重新加载，下次启动时仍会执行，且仍受
同一个一天期限约束。中途消失的窗口会释放认领。磁盘请求仍在执行前删除，使一次卡住渲染进程的清除不会
循环；只有明确的拒绝才会写回。因此没有采用"先读取磁盘请求、完成后再删除"的方案。测试让渲染进程的
启动清除经过真实的交接逻辑，覆盖多次重新加载和一次模拟重启，并针对文件测试交接本身；去掉拒绝或完成
上报、认领时即消费、跳过磁盘重新布置或其撤销、去掉释放、或以新时间重新布置，都会让其中某个测试失败。

更正：第二次批准本身也可能被取消，但它发生在共享退出流程已经清除 token、认证引导快照、最后路由和
首选 workspace 之后（这次清除必须先于网络退出，以隔离 token 请求）。因此如果两次检查之间有窗口变为
未保存、用户又选择取消，当前窗口会处于半退出状态，而 CLI 和会话仍然保留。评审发现了这一点。现在
`auth.prepareSignOut` 是唯一可以取消的步骤，而且是最终的：它运行 `tearDownWindows`，在返回之前让
其他窗口 flush、按轮次询问并销毁，之后不再有可能变为未保存的窗口。`auth.signOut` 不再取消；它只
销毁其间新打开且没有未保存内容的窗口，渲染端适配器在它之后总会停止 CLI。一个测试让
`signOutWithoutRedirect` 经过真实屏障和真实 `LoroRepo`：A 正在 flush 时 B 的写入被拒绝，用户取消。
token、引导快照、路由、workspace 和意图隔离都保持不变，服务端退出没有被调用，B 被保留，之后 B 的
repo 能保存这次更改。先清除再过屏障、或跳过屏障，都会让它失败。

`approveTeardown` 原先只对进入时拍下的快照做 flush 和询问：在另一个窗口 flush 期间、或用户看着询问
时才变为未保存的窗口，会在没有 flush、也没有被询问的情况下被销毁。评审发现了这个 TOCTOU 问题。现在
它对完整列表按轮次进行：

- flush 期间才变为未保存的窗口，会在询问任何人之前先得到自己的 flush；
- 询问打开期间任何代数发生变化，都会开始新的一轮；
- 批准只授予用户被询问时看到的那些代数；
- `tearDownWindows` 在 `destroy()` 之前还会对每个窗口再检查一次（`mayTearDown`）。

**退出批准只有一个所有者。** 更新器在退出屏障询问任何东西之前就设置了全局"应用正在退出"标志。它必须
这样做，因为 Electron 的更新器会在 `before-quit` 之前关闭窗口。被取消的退出从不清除这个标志，而窗口
屏障信任它，所以一次更新被取消后，之后每次关闭或重新加载窗口都会跳过 flush 和询问。评审也发现了这一点。

现在由 `createQuitCoordinator` 批准每一次退出：菜单、最后一个窗口，以及更新器的全部三条路径。

- 它 flush Agent 和各个窗口，并确认仍未保存的部分。
- 取消、安装失败或停止失败都会中止：批准和退出标志一起清除。停止失败时的回滚原先只存在于应用的失败
  回调里，而普通退出在停止可能失败之前就设置了标志；评审要求由一处统一负责。现在
  `createDesktopQuitBarrier` 需要一个必填的 `abort`，停止失败时一定调用它；普通退出只在 Agent 已停止、
  即将 `app.quit()` 时才设置标志。一个测试在退出获批后让 Agent 停止失败：批准和标志都被清除，之后上报
  写入被拒绝的窗口在关闭时会被 flush 并询问；去掉 `abort` 调用会让它失败。在 Agent 之前停止的服务
  （托盘、中继、更新器）会保持停止，直到下一次退出尝试，与失败对话框的说明一致。
- 窗口屏障只信任协调器的批准，从不信任全局标志。
- 更新器在标记任何东西或开始安装之前先询问；在 Linux 上，这发生在密码提示和 `app.relaunch()` 之前。
- 被取消的安装返回 `cancelled: true`，渲染端不把它当作错误。

屏障代码移到了自包含的 `@lody/shared/renderer-storage-barrier`，这样 Electron 的 `node --test` 套件
和渲染端的真实 `LoroRepo` 测试运行的是同一份代码。

**系统关机也是一次退出。** 在 Windows 上，应用因关机、重启或注销而关闭时，Electron 不发
`before-quit`，于是上述流程都不会运行，只存在于内存中的更改会随进程丢失。评审发现了这一点。现在
每个窗口都处理 `query-session-end`，`powerMonitor` 的 `shutdown` 覆盖 Linux 和 macOS。操作系统要求
同步回答，所以 `createSessionEndGuard` 只依据主进程已知的信息做决定：Agent 的未保存问题和各窗口的
上报。没有未保存更改、或退出已获批时，会话结束立即继续，健康的应用绝不拖住关机；否则它挡住会话
结束并调用 `app.quit()`，进入同一个退出屏障：最后一次 flush、询问、停止 Agent。应用退出后会话结束
得以继续；取消则应用保持打开，会话结束继续被挡住。一个测试让不带 `before-quit` 的会话结束经过真实的
协调器和屏障；从不阻挡、健康时也阻挡、不启动退出、或获批后仍阻挡，都会让它失败。未在真实的 Windows
关机上验证：系统的"应用正在阻止关机"界面可能盖住询问，而 Electron 没有提供设置阻止原因的方法。

**远端同步持久化的失败**与其他写入一样上报。第一版还把 Streams 持久化合并器的失败从 debug 提升
为限频警告；#1066 移除了这个合并器，每次游标保存现在都等待真实的逐资源屏障，其写入经过被观察的
适配器，由监视器自己的警告覆盖（每轮一次，此后至多每 5 分钟一次，并写明开始时间）。

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
  - 首个失败发生在打开的 `SessionDocument` 卸载时的清理（真实 manager、真实受限 SQLite）：清理
    正常返回，恢复流程持有该 workspace；空间恢复后 repo 被保存并销毁，恢复流程不再持有它，第二个
    连接能读到会话文档。重新抛出卸载失败会重现所报告的提前退出（`database or disk is full`）；
    跳过注销会让 workspace 一直被持有；两者都会让测试失败。
  - 通过 `saveMany` 被拒绝的元数据（用 `max_page_count` 限制的真实 `SqliteRepoStore`，只写元数据）：
    被拒绝的提交到达适配器的 `saveMany`，观察者将其转为严重状态，恢复流程保存它，第二个连接能读到
    全部五十条。没有转发时包装上不存在 `saveMany`，测试失败。shared 与渲染端测试里的内存假实现像
    真实适配器一样在 `save` 和 `saveMany` 两个入口都注入故障。
  - `tests/lody-fleet-local-catalog.test.ts`：被停止的 repo 仍被保留时，重新启动该 workspace 不会
    在 repo 释放之前调用 `Lody.create`；去掉等待会让它失败。
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
  退出则正常停止。Agent 健康时，存储拒绝过写入的窗口会被要求 flush：它仍回复未保存，于是用户
  收到警告并取消；释放空间后它回复已保存，退出继续。沉默或无法联系的窗口保留上一次的上报。忽略
  渲染端状态会让第一个用例失败。`WindowStorageBarrier`：
  - flush 仍被拒绝的关闭会询问"仍然关闭"，取消则保留窗口和上报；
  - 释放空间后，同一次关闭不再询问就被放行，并清除上报；
  - 选择丢弃的重新加载会被重做并放行；
  - 退出期间放行所有窗口；
  - 崩溃会被报告为丢失。

  让屏障不询问就批准会让两个屏障用例都失败。
  批准有效期：没有意图的批准在出现更新的上报、重新上报同一 `since`、使用一次或 10 秒后都会失效；获批
  的卸载不会被报告为丢失，而未经批准出现的数据会。分别去掉代数检查、单次使用或过期都会让它失败。

- `renderer-storage-episodes.test.ts`（拒绝修订号，真实 `LoroRepo`）：已开始的一轮中第二次被拒绝的
  meta 写入会以相同的 `since` 和更高的修订号重新上报。去掉保护器的拒绝回调会让它失败。
- `desktop-exclusion.test.mjs`（销毁轮次）：对窗口 1 的询问保持打开时，窗口 2 第一次有写入被拒绝；
  旧的回答不覆盖窗口 2，它会被 flush 并重新询问。取消时什么都不销毁，窗口 2 的上报保留；如果窗口 2 的
  flush 成功，它会被销毁且不算丢失。在另一个窗口 flush 期间变为未保存的窗口会在询问之前先被 flush。批准
  之后立即到达的上报会让 `tearDownWindows` 再走一轮。分别去掉代数栅栏、新窗口 flush 或最后的
  `mayTearDown` 检查，都会让某个用例失败。
- `desktop-exclusion.test.mjs`（退出协调器）：像更新器那样预先设置退出标志后，被取消的退出会清除它，
  之后关闭窗口会再次 flush 并询问；获批的退出放行窗口，被中止的退出（安装失败）会重新保护它。中止时
  不清除标志会让它失败。
- `packages/components/tests/renderer-storage-episodes.test.ts`（跨窗口退出登录，真实 `LoroRepo`）：
  窗口 B 的 meta 被拒绝，窗口 A 退出登录。
  - 取消时什么都不销毁，B 的上报和 repo 都保留；
  - 释放空间后，下一次退出登录会 flush B、保存 meta，不再询问就销毁 B；
  - 明确选择丢弃会销毁 B，而这次销毁不会被报告为丢失。

  让 `tearDownWindows` 不经批准就销毁会让这两个用例都失败。

- `packages/components/tests/renderer-storage-episodes.test.ts`（卸载保护，真实 `LoroRepo`）：
  quota 拒绝之后，窗口的 `beforeunload` 被取消；flush 仍被拒绝时保持取消；空间恢复后 flush 保存
  meta，卸载被放行。让保护变成空操作会让它失败。
- `packages/shared/tests/storage-health.test.ts`（`RepoStorageGuard`）：在真实 `LoroRepo` 上，
  doc 被 `QuotaExceededError` 拒绝后 `close()` 会保留 repo。写满时退出前的 flush 仍报告未保存；
  存储重新接受写入后，它保存 doc 和 meta，然后才销毁 repo。
- `packages/components/tests/renderer-storage-episodes.test.ts`：写满时切换 workspace，旧
  runtime 的这一轮仍与新 runtime 一起登记；`flushForQuit` 在空间恢复前保持未保存，之后保存并
  释放它。让 `close()` 总是销毁会让这两个用例都失败。

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
- 被停止的 repo 仍在等待空间时，重新启动同一 workspace 也会等待，直到释放空间或进程退出。
- 卡死或崩溃的渲染端无法运行卸载保护或 flush；崩溃会丢失其内存中的更改，只会被记录。卡死监视器
  的"重新加载"是用户在该对话框中的明确选择。
- `unsavedSince` 只覆盖 repo 写入。其他存储（schedules、operation store、diff store）各自失败，
  未被跟踪。
- 退出对话框读取 Electron 最近一次轮询到的运行时状态，最后几秒内发生的失败可能不会显示。
- 应用级横幅不显示同事的机器；字段已在他们的心跳上，留给以后按机器展示的界面。
