# Lody 生命周期 Effect 迁移路线图

Status: proposed
Translation: current

[English](2026-09-27-effect-lifecycle-migration-roadmap.md)

## 摘要

Lody 的生命周期缺陷集中在少数几类手写机制上：定时器驱动的退避与 watchdog、代际计数器、
手写 disposed 标志、按 key 的 promise 链和被吞掉的 `.catch`。仓库已依赖 effect 3.18，
但只以"在类方法里构造 Effect、在边界 `runPromise`"的孤岛方式使用，没有贯穿模块的作用域。
本路线图覆盖 [Turn 执行与 ACP 进程所有权](2026-09-27-effect-turn-execution-and-acp-process-ownership.zh.md)
之外所有待迁移的部分，按缺陷密度与未关 issue 排定优先级，给出每块的目标设计、前置条件和不该
用 Effect 的地方。排序依据是 2026-07 至 2026-09 的 fix 提交与 issue 分类，不是运行时测量；
每一块开工时都需要自己的详细计划与 note。

## 排序依据

- 近三个月 511 个 fix 提交中约 116 个属于竞态、卡死、泄漏、取消、重连类；按文件统计，
  `apps/cli/src/lib/message-handler.ts`（61 个 fix 提交中 43 个与生命周期相关）与
  `session-execution-service.ts`（43 个中 34 个）最高。
- 非测试代码中手写机制的粗略计数（定时器 / 被吞的 catch / disposed 类标志）：
  `apps/cli/src/lib` 91 / 70 / 38，`packages/components/src/providers` 51 / 27 / 27，
  `apps/electron/src/main` 32 / 10 / 8；renderer 有 83 个文件手写 `let cancelled/disposed = false`。
- 现有 Effect 立足点：`apps/cli/src/lib/loro/connection-recovery.ts`（Queue + Fiber 串行事件循环）、
  `packages/components/src/providers/local-reconnect-loop.ts`（`Clock` + `Fiber`，可注入 TestClock）、
  `apps/cli/src/session/session-access-retry.ts`（`Schedule`）、`apps/cli/src/lib/pr-poller`（`Layer`）、
  `packages/components/src/lib/code-collab-file-index-cache.ts`（`ScopedCache`）。

## 共享基础（由 Turn 提案的阶段 0/1 交付，后续各块复用）

- 守护进程级 `ManagedRuntime` 与根作用域；测试用 `TestContext` 运行时。
- 进程树原语：`spawnScoped` / `terminateTree` / `awaitExit`（同时看 `signalCode`、进程组、
  有上限的升级、Windows 退出码检查）。
- 边界规则：不在 Effect 内调用 `run*`；可拒绝的 promise 用带 signal 的 `tryPromise`；
  中断必须被某个作用域持有或被等待；超时放在等待者上；finalizer 内的等待必须有上限；
  `FiberMap` 替换不等待旧 fiber。
- 这些规则落在 `.agents/docs/cli-effect-ts.md`（Turn 提案阶段 0 负责恢复该文档）。

## 按优先级排列的迁移单元

### 1. Dispatch watcher 与 MessageHandler 事件收尾

- 位置：`apps/cli/src/session/session-dispatch-watcher.ts`（2874 行）、`session-dispatch-logic.ts`、
  `apps/cli/src/lib/message-handler.ts`（9762 行）。
- 证据：#676（未合并的检查让 daemon 100% CPU 42 秒）、#166（过期 `latestUserMsgId` 误报投递失败）、
  #1043/#1050（重复 turn 修复递归，开放 #1040 OOM）、#595、fe26b552（teardown 重复收尾覆盖 `endedAt`）；
  开放 #939（用量 flush 被跳过且不重试）、#553（历史同步重叠报错）。
- 现状机制：`enqueueSessionCheck` 约 110 行手写按 key 串行队列（探测记录、代际栅栏、合并搜索、
  `setImmediate` 让步）；`finalizeACPState` 从约 8 处调用；`sessionManager.on(...)` 处理器是互相
  竞争的 `void (async () => ...)()`。
- 目标：每会话一个 worker fiber（`FiberMap` + sliding `Queue` 或"脏标记 + `Semaphore(1)`"），
  合并、顺序与停止时中断由结构保证；会话事件改为实例作用域上的订阅，收尾只在无拥有者 turn 时发生
  （Turn 提案阶段 2 先完成 turn 那一半）；用量 flush 用 `Schedule` 持久重试。
- 前置：Turn 提案阶段 2–4。CRDT 指针与重复行仍需数据模型层面修复，不能靠 Effect。
- 可能关闭：#939、#553（single-flight 改为加入进行中的那次）；#1040 仅进程内一半。

### 2. 连接恢复、presence 与机器存活（CLI）

- 位置：`apps/cli/src/lib/loro/connection-recovery.ts`（1087 行）、`presence.ts`、`machine-monitor.ts`、
  `session-active-presence.ts`。
- 证据：#12（重连扇出风暴，约 30 次/分钟全量重扫，事件循环延迟 6.4 秒）、#673（token 刷新信号丢失）；
  开放 #399（watchdog 拆掉 transport 已连接、仅 meta room 仍在 join 的连接）、#484（unknown 当作离线）、
  #1028（机器访问注册失败后不重试）。
- 现状机制：三个手写 `setTimeout`、`setInterval` watchdog、手写指数退避与 jitter、
  `streamsRecoveryGeneration`；presence 十个定时器与 `stopped` 标志；machine-monitor 每秒轮询。
- 目标：退避用 `Schedule.exponential` + `jittered` + `resetAfter`（flap 窗口）；watchdog 与
  heartbeat 用 `Effect.repeat(Schedule.spaced)`；节流用 `sleep` + 中断；lease 用 `RcRef`；
  presence 三态 `unknown|online|offline` 用 `SubscriptionRef` 显式建模；机器访问注册为带
  `Schedule` 的后台 fiber。
- 约束：必须先读 [`.agents/docs/cli-lib-loro-presence.md`](../../../docs/cli-lib-loro-presence.md) 与
  [`cli-lib-local-loro-data-plane.md`](../../../docs/cli-lib-local-loro-data-plane.md)，并先调用
  `lody-loro-sync-stack` skill；保留 `onStreamsOnline` 与 `onMetaRoomSynced` 的刻意拆分，
  被节流的 emit 只能延后不能丢弃。
- 前置：共享基础。与 Turn 提案耦合小，可作为验证模式的第一块。

### 3. Renderer workspace runtime

- 位置：`packages/components/src/providers/create-workspace-runtime.ts`（4731 行，单文件最大热点）、
  `workspace-machine-rpc-facade.ts`、`atoms/runtime.ts`、`hooks/use-machine-flock-rows.ts`、
  `hooks/use-session-doc.ts`、`atoms/doc-meta.ts`、`providers/prompt-shortcut-provider.tsx`。
- 证据：#449（meta 重连恢复无上限）、#898（Flock 首次同步失败被 `.catch(() => undefined)` 吞掉）、
  #989（已 dispose 的 runtime 被复用）；开放 #480（有上限的重连仍发布空 presence 使本机显示离线）。
- 现状机制：`disposePromise`、`cloudTransportAttachPromise`、`metaRoomJoinPromise` 充当状态闩；
  多处闭包 `let disposed = false`；`await new Promise(r => setTimeout(r, 1000 * attempt))` 重试；
  presence 在六处被 stop；session store 手写 acquire/release 引用计数且写了两遍。
- 目标：按 transport（cloud、local、presence、monitor、rpc）拆成 `Layer.scoped`；attach 用
  `acquireRelease`；子任务 `forkScoped`；presence 只在作用域真正关闭时清空；按 key 的资源用
  `RcMap`（覆盖 #989 的复用问题）；重试用 `FiberMap` + `Schedule`。React 接缝保持 jotai，
  组件通过 `useSyncExternalStore` 或 `atomEffect` 订阅 Effect 管理的 store；不引入 `@effect/atom`。
- 约束：先读 `packages/components/src/providers/AGENTS.md`；该文件与多数 components 下的
  `AGENTS.md` 已接近 8 KiB 上限，新增规则需要先转移内容。
- 不适用 Effect 的部分（估计约占 renderer 生命周期缺陷的六成）：URL 与状态双向同步（#193，
  以单一数据源修复）、派生状态冲突（#613、#496）、虚拟列表测量时序（#695、#896、#674）、
  第三方库行为（#722）。这些继续用 React 规范与状态下沉解决。

### 4. 本地 Loro 数据面 join/unload

- 位置：`packages/shared/src/local-loro-data-plane-server.ts`、`packages/shared/src/local-loro-transport.ts`、
  `apps/cli/src/lib/local-loro-data-plane-server.ts`、`apps/cli/src/lib/loro/doc.ts`（3143 行）。
- 证据：#4（unload 后 room 仍持有旧文档，同步被静默切断）、`0ec3656a`（Electron 重连崩溃）、`c1a502f7`（bootstrap
  扇出无上限）、#774（join 永久停在 connecting）；开放 #485、#398（Flock 新鲜度同步硬失败）。
- 目标：每次 join 一个 fiber，`Effect.timeout` 取代三重 requestId/generation 守卫，被取代时直接中断；
  room 用 `RcMap`/`ScopedCache`，最后一个引用释放时执行 invalidate；Flock 新鲜度同步用
  `timeout` + `orElse` 回落本地副本。
- 约束：**必须保持"先 unload 再 invalidate"的顺序**（#4），否则重新引入静默断同步；
  loro-repo 的 `reconnect`/`joinDocRoom`/`unloadDoc` 内部状态机不归我们管，Effect 只能包在外层。
- 近期已有多轮修复，优先级低于 1–3。

### 5. 托管 runtime 下载与 ACP 登录

- 位置：`apps/cli/src/agent/managed-agent-runtime.ts`（1588 行）、`acp-authentication.ts`（1168 行）、
  `acp-binary-manager.ts`、`npx-cache.ts`、`abortable-zip.ts`。
- 证据：#878（取消信号没传进下载）、#829（cancel 排在 start 后面，等 285 秒）、#881（缓存维护失败
  中止启动）；开放 #828（登录取消与报错）、#505（登录卡住）。
- 目标：中断自动向下传播，删除逐层 AbortSignal 传递；共享安装用 `RcMap` 或 `Deferred` +
  消费者租约（最后一个释放时中断）；断点续传用 `Schedule`；scratch 与 partial 文件用 `acquireRelease`；
  认证状态机的 `cancelled`/`timedOut`/`terminating` 标志改为单一原因值。
- 约束：`apps/cli/src/agent/AGENTS.md` 的安装取消规则（独立消费者租约、等待被中止代际的清理、
  ZIP 取消围绕 reader 真实 close 事件）必须逐条保留。
- 前置：进程树原语（认证探测进程）。

### 6. Worktree、setup runner 与文件锁

- 位置：`apps/cli/src/session/worktree/worktree-manager.ts`（1830 行）、`speculative-worktree.ts`、
  `worktree-setup-runner.ts`、`worktree-gc.ts`、`packages/shared/src/node/file-lock.ts`。
- 证据：#76（被取代的准备迟到 dispose 删掉替代者的 worktree）、#6（同进程等待者争抢文件锁）；
  开放 #296（可能已被 #620 修复，需核实）。setup 脚本超时只 SIGTERM shell，子孙（如 `pnpm install`）泄漏。
- 目标：按 key 的 `Semaphore` 取代 `withSessionMarkerLock` promise 链；文件锁作为
  `acquireRelease` 资源并用 `Schedule` 轮询；setup 脚本作为进程树原语管理的 scoped 进程；
  GC 用挂在守护进程作用域上的 `Effect.repeat(Schedule.spaced)`。

### 7. 编排投递

- 位置：`apps/cli/src/orchestration/operation-coordinator.ts`（1560 行）、`operation-store.ts`（1595 行）。
- 证据：#322（重放已完成投递）、#461（进度反馈循环）、#200（store 路径错误吞掉完成通知）；
  开放 #675（Stop 后子任务结果仍唤醒会话并触发 Codex 自动压缩）。
- 目标：按 operation 的 `FiberMap`；重试与期限用 `Schedule`；每个请求方会话一个作用域，
  使 Stop 能取消挂起投递（依赖 Turn 提案的停止原因）。
- 约束：SQLite store 的代际栅栏与插入触发器、跨进程 MCP host 不在 Effect 控制范围内。

### 8. Electron main 与内嵌 CLI、cli-supervisor

- 位置：`apps/electron/src/main/services/cli-service.ts`、`loro-data-plane-relay.ts`、
  `packages/cli-supervisor/src/supervisor.ts`。
- 证据：#849、#742；开放 #448（relay 在 dispose 竞态中同步抛错导致 main 退出）、#938（代理设置在
  启动时冻结进 CLI 环境）、#1054（日志 transport ENOSPC 触发 uncaught 退出）。
- 目标：CLI 子进程用进程树原语；每个 sender 一个作用域，`destroyed` 时关闭，send 包进 `Effect.try`；
  代理设置放进 `SubscriptionRef`，变化时按明确语义重启 CLI；supervisor 的代际计数器与
  `lifecycleQueue` 改为单个 supervisor fiber + `Schedule`，kill 实现迁到共享进程树原语
  （需要把原语移到 `packages/shared/src/node` 之类可被 supervisor 依赖的位置）。
- 约束：先读 `apps/electron/AGENTS.md`（已在 8 KiB 上限边缘）；electron main 测试用 `node --test`，
  共享代码的 extensionless 导入会失败，可测逻辑放进 `packages/shared`。

### 9. 低优先级

preview 代理（#156 已修）、`packages/loro-streams-rpc`（近期无 fix）、PR poller（#758 根因是配额策略）、
Electron updater（#278 的根因是第三方事件式 API）。只在触及时顺带样板化。

## 不需要等 Effect 的独立修复

- #1054：给 `DailyRotateFile` 挂 `error` 监听，ENOSPC 时降级到 stderr 而不是 uncaught 退出。
- #448：relay 的 `send` 包 try，并在 `destroyed` 后停止回调。
- #553：历史同步 single-flight 改为加入进行中的那一次，而不是抛出 "already running"。
- 核实后关闭：#296（可能已被 #620 修复）、#828 的下载部分（已被 #878 修复）。

## 建议顺序

1. Turn 提案阶段 0–1（共享基础 + 进程树，修 #429）。
2. 连接恢复与 presence（单元 2）：开放 issue 最多、已有样板、耦合小，用来验证模式。
3. Turn 提案阶段 2–4。
4. Dispatch watcher 与 MessageHandler（单元 1）。
5. Renderer workspace runtime（单元 3），按 transport 逐个拆。
6. 单元 5、6、7、4、8，按开工时的缺陷与 issue 状态重新排序。

## 验证边界

排序与机制计数来自 git 历史、issue 与代码 grep，不是运行时测量；"可能关闭"的 issue 是推断，
需要各单元在实施时复现与验证。未评估迁移的工作量与对发布节奏的影响。
