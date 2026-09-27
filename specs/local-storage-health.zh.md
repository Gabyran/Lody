# 本地存储健康

Status: draft
Translation: current

[English](local-storage-health.md)

机器上的 Lody 数据目录存放本地 Loro repo、git worktree、附件副本和日志。本地模式下，repo 的
SQLite 文件是用户工作的唯一副本。所在磁盘写满时，Lody 继续运行：未保存的更改留在内存中，
提示用户，拒绝会大量写盘的新工作，并在空间恢复后自动保存全部更改。

## 级别

daemon 用两个信号判断数据目录所在的卷：

- **剩余空间**：健康时每 60 秒、其他时候每 10 秒用 `statfs` 采样一次。即将开始的工作会在
  读数超过 2 秒时重新采样。
- **被拒绝的写入**：本地写入因存储已满失败（`ENOSPC`、`EDQUOT`、`SQLITE_FULL`，或
  loro-repo 的 `RepoStorageError` 且 code 为 `quota`）时立即生效，不等下一次采样。错误按
  code 或 name 分类，从不匹配消息文本。

| 级别       | 条件                                     | 效果           |
| ---------- | ---------------------------------------- | -------------- |
| `ok`       | 剩余空间高于警告阈值，且没有被拒绝的写入 | 无             |
| `warning`  | 剩余空间低于警告阈值                     | 仅提示，可关闭 |
| `critical` | 剩余空间低于严重阈值，或有写入被拒绝     | 降级模式       |

阈值随卷大小变化，并有上下限：

- 严重：卷的 1%，至少 256 MiB，至多 1 GiB；
- 警告：卷的 5%，至少 1 GiB，至多 5 GiB；
- 卷小到放不下这些下限时，严重阈值至多为卷的四分之一，警告阈值至多为一半。

只有剩余空间超过阈值 10% 后才会离开当前级别，所以在阈值附近徘徊的卷不会来回跳。

## 未保存的更改

写入被拒绝意味着部分 repo 更改只存在于内存中。daemon 记录第一次写入失败的时间
（`unsavedSince`）。只有所有已打开的 workspace repo 都成功 flush 后才会清除这个状态；
仅仅剩余空间看起来变多了并不会清除它。

恢复不需要用户操作。离开 `critical`，或在有未保存更改时任何一次本地写入成功，都会触发所有
workspace repo 的 flush，至多每 5 秒一次。有未保存更改时，每次采样也会重试。

停止一个 workspace 并不会让它退出恢复。清理不能因为某个文档因空间不足卸载失败就提前结束：那个
文档留在 repo 中，随后由整个 repo 的最终 flush 决定。只有 flush 成功后 repo 才能关闭。如果这次
flush 因空间不足被拒绝，repo 保持打开并保留注册，由恢复流程在保存之后关闭它。在此之前再次启动
同一个 workspace 会等待，因此两个活着的 repo 永远不会共用同一个数据库。有未保存
更改时以其他方式关闭的 repo，会让这一轮在本进程余下的时间里一直保持未结束：其余 repo 保存成功
并不能证明它的更改已保存。

## 降级模式

处于 `critical` 时，daemon 在开始前拒绝：

- **新的 Agent 回合**，包括新会话的第一个回合。回合以 `storage_critical` 提示失败，而不是
  去创建 worktree、安装依赖或启动 Agent。这覆盖了从界面、CLI 和 MCP 创建会话。
- **预先准备 worktree**。拒绝只意味着第一个回合自己准备 worktree，而那个回合同样受限。
- **复制附件**到本地附件存储（`LODY_STORAGE_CRITICAL`）。

已经在运行的工作继续进行，它的写入可能失败并像其他写入一样留在内存中。回合 diff 不受限：
跳过会永久丢失，而写入失败只是等待空间。

daemon 从不因存储已满而退出。磁盘写满时文件日志不再让进程崩溃，是 issue #1054 单独的
第一层（PR #1056）。

## 用户看到什么

级别不是 `ok` 时，presence 通道上的机器心跳带有可选的 `storage` 字段：级别、原因
（`low-space` 或 `write-failed`）、剩余字节数和 `unsavedSince`。它遵守
[presence 预算](loro-ephemeral-presence-channel.zh.md)。该字段复用心跳自己的 key，只在级别
变化时更新。无法解析该字段的读者只忽略这个字段，不忽略心跳。

桌面端为本机显示一个横幅：

- `write-failed`：磁盘已满，更改暂存在内存中、释放空间后会自动保存，新工作已暂停，并说明
  自何时起有未保存的更改；
- `critical` 空间不足：剩余多少，以及新工作已暂停；
- `warning`：剩余多少，可关闭，直到级别变化。

渲染端自己的 IndexedDB repo 在写入以 `quota` 失败时显示同一个横幅。之后另一个资源写入成功
并不会清除它，只会触发一次整个 repo 的 flush（至多每 5 秒一次），flush 失败则按有界退避重试。
只有这样的 flush 成功、且期间没有新的拒绝时，横幅才会清除。离开 workspace 也不会结束这一轮：带着未保存更改被销毁的
runtime 会保持它的 repo 打开，并继续计入横幅，直到恢复流程保存并关闭它。
渲染端连接停止工作（`unavailable`）时的危机处理另见 issue #417。

## 退出

有未保存更改时停止 daemon 会记录一条警告，写明 `unsavedSince`。

只要退出会丢失更改，桌面端就会先询问：无论是本地 Agent 的，还是任何一个窗口自己的 repo 的。
每个窗口把自己最早的未保存更改上报给主进程。退出时，主进程请每个持有未保存更改的窗口再 flush
一次并回复。3 秒内没有回复的窗口保留它上一次的上报：沉默不能证明已经保存。询问中写明最早的
未保存更改时间。此时退出会丢失尚未同步到其他地方的更改。

系统结束会话（关机、重启或注销）时也一样；在 Windows 上，这会在不经过普通退出流程的情况下关闭应用。
已知有未保存更改时，桌面端会挡住会话结束，改为执行同一个退出流程：最后一次 flush、询问、停止本地
Agent。退出获批后应用退出，会话结束得以继续；取消则应用保持打开，会话结束继续被挡住。没有未保存
更改时，它从不拖延关机。

关闭或重新加载单个窗口遵守同样的规则，因为这些更改就存在该窗口的内存里。只要它自己的 repo 持有
未保存更改，窗口就拒绝卸载；桌面端请它 flush，全部保存后才放行关闭或重新加载，否则会询问，取消则
保留窗口。一次批准只覆盖一次关闭或重新加载，并且只针对它所询问的那些更改；之后再被拒绝的写入会重新
询问。未经这一确认就关闭或崩溃的窗口会被记录为丢失，而不会被当作已保存。

退出登录和清除本地缓存会在不给其他窗口卸载机会的情况下关闭它们，所以两者都会先询问：每个持有
未保存更改的窗口先 flush，仍未保存的部分统一确认一次。其间才变为未保存的窗口会被 flush 并纳入新的
询问；一次回答只覆盖它所询问的内容。取消会中止退出登录或清除，不会关闭或改变任何东西。

安装更新也是一次退出，会在任何东西开始退出之前询问同样的问题；取消会让应用继续运行，之后的每次关闭
或重新加载都会再次受到保护。

## 待定问题

- loro-repo 仍会把后台保存失败打印到控制台，且 schema 升级后的第一次打开需要写盘
  （loro-dev/loro-repo#139）。
- 压舱文件是否值得，记录在实现说明中；本 Spec 不要求它。

## 证据

- 监视器、阈值和恢复：`apps/cli/src/lib/storage-health.ts`，由
  `apps/cli/src/lib/lody-fleet.ts` 持有。
- 分类与存储适配器包装：`packages/shared/src/storage-health.ts`、
  `packages/shared/src/observed-storage-adapter.ts`；接入点在
  `apps/cli/src/lib/loro/doc.ts` 和
  `packages/components/src/providers/create-workspace-runtime.ts`。
- 拦截点：`apps/cli/src/session/session-execution-service.ts`（回合开始）和
  `apps/cli/src/lib/message-handler.ts`（预先准备、附件复制）。
- presence 字段：`packages/shared/src/presence.ts`、`apps/cli/src/lib/loro/presence.ts`。
- 界面：`packages/components/src/components/local-storage-banner.tsx`、
  `packages/components/src/atoms/local-storage-health.ts`；桌面端退出、窗口关闭与重新加载、退出登录
  和清除缓存：`apps/electron/src/main/application.ts`、
  `packages/shared/src/renderer-storage-barrier.ts`、
  `packages/components/src/lib/renderer-storage-episodes.ts`。
- 已执行的验证：在写满的 256 MiB RAM 盘上运行 daemon，记录在
  [实现说明](../.agents/notes/implemented/feature/2026-09-27-local-storage-health.zh.md)中。
