# iOS 模拟器侧边栏：前端

Status: proposed
Translation: current

[English](2026-09-27-ios-simulator-panel-frontend.md)

## 摘要

运行在 Mac 上的会话需要能在 Lody 里查看并操作那台 Mac 的 iOS 模拟器，同时不能让 Browser 标签页堆积模拟器专用开关，也不能把这台 Mac 暴露给其他人。前端新增了一个独立的 iOS 模拟器侧边栏标签页（以及移动端的全屏钻取页），只在会话的目标机器是 Mac 时出现。它通过一个注入的 `IosSimulatorClient` 端口与机器通信，因此所有 Machine RPC 和鉴权都留在实现该端口的运行时里。面板、各状态和测试已经实现；类型化 RPC 契约、查看器页面和运行时实现由其他部分负责且尚未接入，所以这里还没有在真实模拟器上运行过。

## 决定

- **独立标签页，而不是 Browser 的一种模式。** `ios-simulator` 是与 `browser` 并列、可持久化的侧边栏标签页 id，有自己的状态、自己的 `?simulator=1` 移动端钻取页，以及按会话和机器分键的控制器。它没有地址栏、历史、标注或分享操作：模拟器预览从不共享。
- **按目标机器开放。** 只有当会话所在机器的元数据为 `os === 'darwin'` 时才有这个标签页。Lody 版本过旧、尚不支持该协议的 Mac 仍会显示标签页，但只提示更新，不发起任何调用；`getIosSimulatorPanelAvailability` 是唯一读取能力位的地方（目前是占位键 `iosSimulator` v1，等待共享契约）。
- **一个端口，界面不碰鉴权。** `lib/ios-simulator/ios-simulator-types.ts` 定义视图类型和 `IosSimulatorClient`（`list`、`startPreview`、`status`、`cancelStart`、`stopPreview`），以可选的 `WorkspaceRuntime.iosSimulator` 注入。传输失败会 reject；业务失败以返回值表示。界面接触到的唯一能力凭据是不透明的 `viewerUrl`，它被加载到 `no-referrer` 的 iframe 中且从不显示；复制的诊断信息不包含它，并会脱敏 URL、令牌、UUID 和主目录用户名。
- **控制，而非抢占。** 所有设备都会列出（按运行时分组、可搜索、可筛选），并显示状态与占用情况。被其他会话控制的设备，在请求者有权看到该会话时显示占用者，且不提供任何操作。停止预览从不关闭设备，凡是出现“停止”或“取消”的地方文案都会说明这一点。
- **直连与远程。** 同机 Electron（`localMachineIdAtom` 等于会话机器）不会因为云端在线状态显示机器离线而被阻断；状态控件显示“直连”。远程预览显示“远程”，且不显示隧道地址。
- **可见性决定开销。** 轮询（准备中 1.5 秒、就绪后 15 秒）和查看器 iframe 只在面板可见时存在；隐藏或折叠的面板不保持任何串流。卸载面板从不停止预览（面板挂载不等于预览所有权）。
- **选择顺序。** 用户在面板中选择的设备优先，其次是本会话正在预览的设备，然后是记住的设备（`lody:iosSimulatorSelectedDevice:<workspace>:<machine>:<session>`，属于偏好，清除缓存时保留），最后是本会话占用的、已启动的或空闲的设备。

## 考虑过的替代方案

- 给 `SessionBrowserPanel` 加一个模拟器引擎：需求明确拒绝（“no Browser flag soup”），而且 Browser 的地址、历史、标注和分享在这里都必须不存在。
- 调用形如 Browser 的 `runtime.requestIosSimulator*` 方法：为了不让前端自行发明带鉴权的线上契约而放弃；改由运行时把它的 DTO 适配到这个端口。

## 验证与限制

- `tests/ios-simulator-model.test.ts`（分组、操作、选择、轮询、偏好作用域、脱敏）和 `tests/session-ios-simulator-panel.test.tsx`（更新与离线拦截、同机绕过、启动/开机、取消与迟到的启动结果竞争、停止、占用时不可抢占、按可见性轮询与挂载查看器、诊断信息）用假客户端验证面板。
- Storybook `Sessions/iOS Simulator/Panel` 覆盖所有状态的浅色、深色、英文和中文版本，并已在 Chromium 中检查。
- 未验证：真实 RPC 契约、查看器握手、远程隧道，以及在第二台设备上 `startPreview` 是否会原子地释放第一台（界面假设会，并在文案中说明）。
