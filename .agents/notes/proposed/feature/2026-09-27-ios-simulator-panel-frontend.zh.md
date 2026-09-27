# iOS 模拟器侧边栏：前端

Status: proposed
Translation: current

[English](2026-09-27-ios-simulator-panel-frontend.md)

## 摘要

运行在 Mac 上的会话需要能在 Lody 里查看并操作那台 Mac 的 iOS 模拟器，同时不能让 Browser 标签页堆积模拟器专用开关，也不能把这台 Mac 暴露给其他人。前端新增了一个独立的 iOS 模拟器侧边栏标签页（以及移动端全屏钻取页），只在会话的目标机器是 Mac 时出现。所有对机器的调用都走同一个类型化 Machine RPC `ios-simulator/control`：同机时直连，否则附带签名的预览控制凭证；查看器页面位于独立的源，面板通过精确源握手与它通信。面板、facade 接线和测试已按共享契约实现，契约的类型、本地 schema 和远程客户端由其他部分负责并单独合入；这里还没有在真实模拟器上运行过。

## 决定

- **独立标签页，而不是 Browser 的一种模式。** `ios-simulator` 是与 `browser` 并列、可持久化的侧边栏标签页 id，有自己的状态、自己的 `?simulator=1` 移动端钻取页，以及按会话和机器分键的控制器。它没有地址栏、历史、标注或分享操作：模拟器预览从不共享。
- **按目标机器开放。** 只有当会话所在机器的元数据为 `os === 'darwin'` 时才有这个标签页。不支持 `iosSimulator` 协议的 Mac 仍会显示标签页，但只提示更新，不发起调用；`getIosSimulatorPanelAvailability` 是唯一读取处。
- **一个 RPC，鉴权在界面之下。** `WorkspaceRuntime.requestIosSimulatorControl` 携带一个命令（`list`、`start`、`status`、`stop`）。本地平面直接发给本机守护进程，不带凭证、不经云端；否则先检查协议，再通过现有的预览控制 nonce 与凭证路径对这条确切命令签名。传输失败以 `{ success: false, error: 'failed' }` 返回。`lib/ios-simulator/ios-simulator-model.ts` 是唯一把线上 DTO 映射为视图状态的地方。
- **以操作为单位。** `list` 从不开机。`start` 返回一个操作；在 preparing、booting、connecting 期间每秒轮询其 `status`，最多 180 次，之后显示超时并提供“重试”和“停止”。就绪后不再轮询。“取消”和“停止”都是 `stop{operationId}`；`closed` 之后的“恢复”是一次新的 `start`。
- **查看器握手。** 每次加载后，面板向查看器的精确源发送 `init {operationId, visible}`；只接受来自该 iframe 窗口、该源、该操作的 `state`；面板或文档被隐藏或显示时发送 `visibility`。隐藏时 iframe 保持挂载。它保留自己的源（`allow-scripts allow-same-origin`），以便握手能指名它；这之所以安全，是因为非 http(s) 或与应用同源的 `viewerUrl` 会被拒绝。地址从不显示；复制的诊断信息不含地址，并脱敏 URL、令牌、UUID 和主目录用户名。
- **控制，而非抢占。** 所有设备都会列出（按运行时分组、可搜索、可筛选），并显示状态与占用情况。被其他会话控制的设备不提供任何操作。停止从不关闭设备，凡是出现“停止”或“取消”的地方文案都会说明。
- **本地与远程。** 同机 Electron（`localMachineIdAtom` 等于会话机器）不会因为云端在线状态显示离线而被阻断；状态控件显示“直连”。远程预览显示“远程”，不显示隧道地址。
- **选择顺序。** 用户在面板中选择的设备优先，其次是本会话正在预览的设备，然后是记住的设备（`lody:iosSimulatorSelectedDevice:<workspace>:<machine>:<session>`，属于偏好，清除缓存时保留），最后是本会话占用的、已启动的或空闲的设备。

## 考虑过的替代方案

- 给 `SessionBrowserPanel` 加一个模拟器引擎：需求明确拒绝（“no Browser flag soup”），而且 Browser 的地址、历史、标注和分享在这里都必须不存在。
- 由运行时适配的纯前端客户端端口（本分支最初的草案）：在上游确定单一类型化命令 RPC 后被取代，facade 现在直接调用它。
- 只用 `sandbox="allow-scripts"`：iframe 会成为不透明源，精确源的 `postMessage` 无法指向它。

## 验证与限制

- `tests/ios-simulator-model.test.ts`（运行时解析、状态归一化、分组、状态映射与查看器源拒绝、操作、选择、握手解析、偏好作用域、脱敏），`tests/session-ios-simulator-panel.test.tsx`（更新与离线拦截、同机绕过、启动并有界轮询至就绪、精确源握手与拒绝外来来源、隐藏时的可见性消息、按操作取消、超时、关闭后恢复、占用时不可抢占、诊断信息），以及 `workspace-machine-rpc-facade` 的三个用例（本地路由不带凭证、不经云端；远程对确切命令签名；不支持协议的远程机器在握手前被拒绝）。
- Storybook `Sessions/iOS Simulator/Panel` 覆盖所有状态，并已在 Chromium 中检查。
- 未验证：真实守护进程、查看器页面、隧道，以及屏幕尺寸（契约不含尺寸，按设备类别使用默认比例）。
