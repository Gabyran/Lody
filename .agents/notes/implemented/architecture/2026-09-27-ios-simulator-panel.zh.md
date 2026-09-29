# iOS 模拟器右侧面板

Status: implemented
Translation: current

[English](2026-09-27-ios-simulator-panel.md)

## 摘要

为目标机器为 macOS 的会话增加独立 iOS 模拟器侧栏，机器 RPC 负责设备列表和准备，远端媒体复用 Quick Tunnel。同机直连、无分享、每个设备只允许一个会话控制；Lody 自有 viewer 只接收画面和受限输入。首版采用 MJPEG，没有增加前端依赖。真实本机服务冒烟已收到画面并完成清理；完整远端/移动端验收及 H.264 仍不在已验证范围内。

## 已确认需求与待审阅默认值

已确定：入口取决于当前会话的目标机器是否为 macOS；打开后通过 RPC 获取该机器全部 iOS 模拟器；用户可以选择启动；隐藏地址、前进后退和标注；保留连接状态，不提供分享；减少依赖，为后续自定义控制留出边界。

本轮已确认：同机直连；iOS 模拟器不提供分享；每台模拟器只允许一个 Lody 会话控制。远端访问仍由后台 Quick Tunnel 承载，仅供已授权的控制会话使用。

其余推荐默认值仍待审阅：

- 通过右侧面板空态和 `+` 菜单添加 `iOS 模拟器`，位置紧邻 Browser，不自动打开。每个会话最多一个模拟器面板和一个选中设备。
- 看的是目标机器，不是观看者的操作系统。macOS 离线仍保留入口和离线说明；系统信息未就绪时不猜测。协议不支持显示升级提示，不能只判断 CLI 版本。
- 同机 Electron 沿用本地直连，支持离线；仅远端访问创建 Quick Tunnel，地址始终隐藏。没有分享入口、分享 RPC、公开链接或匿名观看模式。
- 会话内浏览器和模拟器可同时运行，互不替换。切换模拟器时释放旧设备的预览和控制权，新连接只绑定新设备。
- 不自动关闭任何模拟器，包括本次启动的设备。首版只管理预览连接，关机放入后续显式设备控制。

## 交互与首版完整控件

列表态：顶部显示目标机器名及在线状态；工具区包含刷新、按名称/系统搜索、系统版本筛选。列表按 runtime 分组，行展示名称、机型、iOS 版本、启动状态、可用性和占用说明；同名设备用短 UDID 区分，完整 UDID 放详情中。不可用 runtime 的设备仍列出并说明原因。已运行设备操作为“预览”，未运行设备为“启动并预览”。列表只读检查不安装 Baguette、不启动设备、不建隧道。

预览态布局：`[设备名称 / iOS 版本 ▾] [连接状态]`，下方为等比例画面。设备选择器重新打开列表。连接状态弹层显示阶段、目标机器、关闭原因、精简错误、重试/恢复和停止预览。常驻工具栏没有地址、后退、前进、网页刷新、标注或开发配置。

| 位置 | 控件/状态 | 行为 |
| --- | --- | --- |
| 面板入口 | iOS 模拟器标签、关闭按钮 | 复用现有标签排序、关闭邻居和本地布局记忆 |
| 列表 | 目标机器标识 | 只读，不在面板内切换机器 |
| 列表 | 刷新、搜索、runtime 筛选 | 搜索筛选本地完成，刷新才重新请求机器 |
| 设备行 | 设备详情、运行/不可用/占用状态 | 不可用或冲突时禁用启动并解释 |
| 设备行 | 启动并预览 / 预览 | 一次点击执行完整工作，不要求输入端口 |
| 准备态 | 分阶段进度、取消 | 检查环境→准备组件→启动设备→建立连接→等待首帧；取消不等于关机 |
| 预览头部 | 设备选择器 | 精确切换 UDID，旧异步响应不得覆盖新选择 |
| 预览头部 | 连接状态按钮 | 区分本地、连接中、已连接、过期、失败、机器离线、设备已关闭 |
| 状态弹层 | 重试/恢复、停止预览、复制诊断 | 诊断不含 token；停止只释放模拟器预览，不影响 Browser 或模拟器进程 |
| 画面 | 自适应 canvas、点击与单指拖动 | 使用设备点坐标，断线禁用输入，失焦/取消释放触摸 |
| 提示区 | 组件下载、Xcode/runtime 缺失、权限不足、协议不支持 | 自动准备固定版本组件；Xcode/runtime 提供修复指引和重新检查，不自动安装 Xcode |
| 提示区 | 空列表、首次加载、查询失败、首帧超时 | 区分“无设备”和“没查询成功”；提供对应重试/刷新 |

首版不增加硬件控制按钮。多指、中文输入、横屏等后续能力需单独验收，不能由基础单指可用推断。

## 后续控件目录（不全部进入首版）

| 分组 | 控件 | 传输及边界 |
| --- | --- | --- |
| 常用 | Home、应用切换器、旋转、摇一摇 | 类型化命令；离散操作可走 RPC |
| 输入 | 键盘/文本输入、粘贴、双指缩放、硬件音量/锁屏 | 高频手势走 WS；剪贴板仅显式动作，不自动同步 |
| 画质 | 帧率、码率、缩放、编码选择、适应/原始尺寸、全屏 | 编码控制走 WS；尺寸/全屏为客户端状态 |
| 捕获 | 截图下载、附到对话、录屏 | 捕获与发送分开；录屏作为独立后续能力 |
| 外观 | 深浅色、动态字体、对比度、状态栏 | RPC 配置后回读实际值，不把发送成功当作生效 |
| 生命周期 | 关机、重启 | 说明影响该机器上的真实设备及其他工具；不是隧道操作 |
| 应用 | 安装、启动/终止、打开深链 | 项目/文件权限需明确，不开放任意宿主命令 |
| 调试 | 可访问性树、控件命中、日志 | 有独立授权和按需订阅，不恢复网页 DOM 标注 |
| 高级模拟 | 位置、网络、摄像头、运动 | 依赖环境与注入限制，单独设计与验证 |

## 架构与依赖

`SessionIosSimulatorPanel` 负责选择与状态；`SimulatorToolbar` 使用现有 React、StyleX 和 `@lody/ui`；连接 controller 处理 RPC/endpoint；一张 Lody 自有轻量 viewer 页面使用 canvas、原生 WebSocket 和浏览器解码能力。无需引入 Baguette 整套 SDK、播放器、WebRTC、状态管理库或 UI 框架。

viewer 使用专用 iframe 展示，通过同源的受限 endpoint 获取流。这样不需要把跨域 Cookie/CORS 处理散入 React，也不必让 CLI 打包第二份 React。自定义工具栏的设备操作走 RPC，播放器本地命令通过严格校验 origin、source、连接代际与 schema 的小型 postMessage 协议送入 viewer。跨源 iframe 内脚本由固定的 Lody 制品提供，不加载用户项目页面；关闭 annotation 注入。媒体帧不经过 postMessage、React state、RPC 或 Loro 文档。

CLI 上由按需启动的 Baguette 进程处理采集和输入；每个预览经 IPC worker 独立拥有一个原生进程，默认 loopback、禁用插件；避免共享进程引用计数带来的跨会话清理耦合。Lody 适配层只开放当前设备必要路由和消息。设备列表可先用 `xcrun simctl list devices --json` 读取，避免查询前就下载 Baguette；启动/采集走固定版本适配器。固定 runtime/hash 与许可声明沿用 managed-runtime 分发方式，不要求用户装 Homebrew。首版明确经过验证的 macOS/架构/Xcode/runtime 组合，unsupported 不静默替代。

## RPC 与权限

`lody_ios_simulator_preview` 独立于网页预览，提供 list/start/status/stop。严格输入不接受
身份选择器；本地专用 `ios-simulator/agent-control` 从活动调用获取用户并复用服务授权。
结果剔除 viewer URL 和预览自由文本诊断。

Agent 在 Mac 执行，用户却可能从远端观看。启动时选择 loopback 会给远端面板不可用地址，
因此准备阶段先占用并启动设备，等待第一个已授权面板的 start/status 选择传输方式。
Agent 查询不接入、不续期；取消和一小时空闲期限释放无人接入的占用，重复启动保留已经
接入的传输方式。不增加依赖或持久元数据。

复审发现 agent 替换操作后，面板恢复会查询旧 operationId。恢复现在读取会话当前状态，
准备轮询和停止仍绑定确切操作。设备选择器的刷新也能发现已经 idle 时的 agent 启动。
没有增加自动打开或持续 idle/ready 轮询。确定性测试覆盖 MCP 输入／输出、活动用户入口、
延迟接入、取消、过期、远端授权和面板恢复；新增入口尚未重复真实 agent 到原生 viewer 验收。

版本 1 能力为 `iosSimulator`。单个 `ios-simulator/control` 接受 `list`、
`start {udid}`、`status {operationId?}` 和 `stop {operationId}`；共享 schema 拒绝额外字段。
Start 立即返回 preparing 操作；status 只观察、不续期。Stop 同时承担取消准备，必须指定
准确 operationId，因此迟到命令不能停止新操作。

后续按能力增加窄类型设备命令，不能提供“执行任意 Baguette CLI 参数”的 RPC。

协商通过 `MachineMeta.protocolCapabilities` 的版本化能力，os 仅控制入口。所有远端 RPC（包括设备枚举）验证调用者访问权；workspace RPC 不能证明自报 userId。沿用短时签名操作证明思路，范围绑定 workspace/machine/session、UDID、动作、operation/endpoint 和 CLI instance nonce。共享传输/本地 facade 维持相同语义，本地不强制调用云端；Cloud 授权扩展通过 platform/cloud-api port。

媒体端逐 HTTP/WS 请求检查 capability、UDID 和当前控制租约，输入消息也校验租约仍有效；只接受所属控制会话的已授权访问。不提供公开分享路由或匿名 viewer grant；没有分享功能不等于可以省略鉴权。明确把凭据送入 WS 建连，不依赖浏览器偶然附带 Referer。

## 所有权、状态与并发

- session + kind（browser / ios-simulator）分别拥有操作队列、取消、local/remote endpoint、状态与配额记录。改所有相关 key，不能只改顶层 Map；session 归档/删除时两类均清理。共享 QuickTunnelSession/cloudflared 的低层实现，不复制完整 PreviewService。
- UI 分开记录设备状态与连接状态：设备启动成功但隧道失败时显示“设备已运行，连接失败”，重试连接不重复启动。隧道连通后继续等首帧，不能先显示画面就绪。
- 已确认机器范围内每台设备只允许一个 Lody 会话控制，跨 workspace 也不能重复占用。CLI 以 UDID 为键，原子获取绑定 workspace/session 与代际的控制租约，再启动设备或建立连接；同一会话重复启动合并，设备变更按 UDID 串行。其他会话列出设备并显示“其他会话正在控制”，禁用预览，不提供抢占。由其他原生工具启动的设备可接入；此约束只协调 Lody 会话，不排斥原生工具。
- 取消或失败的启动、显式停止、切换设备、闲置过期、授权撤销、会话归档/删除和 CLI 退出均释放对应租约；先禁用旧输入并关闭旧 endpoint/socket，再允许新会话获取。租约代际防止旧清理回调释放新控制权。释放控制权不关闭 Simulator 设备；切换失败则显示可重试的空态，不自动恢复旧设备控制权。
- 隐藏、切标签、Zen 和关闭面板停止该 viewer 解码、输入与保活，不自动撤销 endpoint；重新打开先查状态。显式停止、授权撤销、会话归档/删除、CLI 退出释放 endpoint 与所属子进程。Baguette 进程按引用释放；不终止用户自己的其他服务或 Simulator 设备。
- 建议沿用一小时闲置过期，但只以前台 viewer 心跳或有效操作续期；编码器持续发帧、机器状态查询和内部探活都不续期。重连恢复解码器和关键帧；断线期间不排队触摸操作。
- 选择和工具栏偏好按 account/workspace/session/machine 保存在客户端本地；列表、视频、心跳和端点凭据不放 repo meta。CLI 内存拥有活连接，客户端通过 RPC 恢复。若需要跨客户端保存选择，后续放 session doc 小型独立字段，不复用 Browser previewConnection，也不同步 token。

## 代码证据与落点

核对 OSS `b83e2fdec0f7bc871243c138486c6fb1ce5c1007`：

- `packages/components/src/components/sessions/session-side-panel-tab-bar.tsx` 的固定 kind/option，以及 `session-detail.tsx` 的固定面板、唯一 sidePanelTabs 顺序，需要加入 ios-simulator；面板持久化和移动端 drill 入口同步扩展。
- `session-browser-panel.tsx` 同时拥有导航、地址和标注流程；`managed-preview-surface.tsx` 依赖标注与 Browser postMessage，因此不直接用作模拟器播放器。`preview-connection-status.tsx` 可提取通用展示，但文案需去除地址语义。
- `apps/cli/src/preview/preview-service.ts` 的 activeTunnels、operations、取消和状态写入按 SessionId；当前同会话只有一个 remote owner。
- `local-preview-proxy.ts` 当前两向 WS 数据消息均调用 `onActivity(true)`；视频必需有明确的续期策略，不能原样套用。
- 相关决策：[Quick Tunnel](../../proposed/architecture/2026-09-21-quick-tunnel-preview.md)、[可选标注](../../implemented/bug-fix/2026-09-15-preview-optional-annotation.md)。这里只扩展模拟器产品边界，不撤回既有代理安全约束。

## 验收与限制

先做列表→启动→首帧→交互→停止/恢复/切换的纵向实现，再补错误/恢复和跨端验收。确定性测试覆盖 OS/协议门控、目标机器路由、取消与旧响应、双面板互不替换、跨会话/跨 workspace 并发抢占只成功一次、租约释放与旧回调隔离、无分享路由、未授权访问拒绝、UDID 越权、撤销关闭 WS、后台视频不续期及 CLI 崩溃清理；新控件用 Storybook 覆盖中英文、窄屏和所有关键状态。

实际验收覆盖同机离线、已授权会话的远端 Quick Tunnel、iPhone Safari/Capacitor、慢网/断线、帧率与资源占用。H.264 的浏览器解码、背压与关键帧恢复单独验收；MJPEG 成功不代表 H.264 或公网低延迟通过。

现已实现共享协议与能力、本地/远端 RPC、精确动作签名、机器范围控制租约、可取消原生 worker、受限媒体网关、独立本地/隧道 owner，以及 UI Designer 的侧栏。Viewer 握手校验 origin、source 和 operation，回报真实帧尺寸。

验证包含独占/取消/空闲到期、网关、RPC/签名、前端模型/控制器/路由测试及类型检查。本机真实冒烟枚举 86 台设备，通过平台路由的本地镜像安装固定制品，收到 205,691 字节 JPEG；停止预览完成清理且不关闭模拟器。UI Designer 检查了中英文、明暗主题 Storybook。完整侧栏尚未在实际 Electron 构建内端到端操作，远端和移动端 E2E 尚未完成。

分发已准备但未部署：私有镜像脚本新增 `--runtime baguette`，发布前须镜像固定版本制品。原生支持当前为 Apple Silicon/macOS 15+，需要 Xcode 与 iOS runtime；不支持 Intel。没有增加 npm 依赖，不承诺 MJPEG 的带宽和延迟表现。

## PR 安全复审

工作区 Streams 可被其他工作区成员读取。因此远端 viewer URL 仅通过 P-256/AES-GCM 加密发给每次请求的临时接收者，公钥绑定在签名动作中；同机直连 DTO 不变。撤销覆盖签名校验与启动过程，并保持禁用直至明确重新启用；owner/machine 变更关闭现有凭证。测试拒绝接收者/上下文替换、线路明文 URL，以及撤销后恢复执行的启动请求。

前端来自独立设计分支，Storybook 覆盖明暗主题、中英文、设备选择和中断/准备状态。线路到视图映射仍集中于模型模块；整合补充真实帧尺寸、首帧超时、账号范围选择记忆与界面错误脱敏。
