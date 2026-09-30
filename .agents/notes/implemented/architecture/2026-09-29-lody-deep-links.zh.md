# 统一 Lody 会话深链接

Status: implemented
Translation: current

[English](2026-09-29-lody-deep-links.md)

## 摘要

会话 mention 使用的通用 session 协议离开 Lody 后可能打开其他应用。新 mention 和会话复制入口现统一使用 lody 资源协议，Stable、Nightly 与 OSS 共用格式，并在解析和导航中保留工作区身份。应用内引用留在来源安装，应用外点击遵循用户默认选择，启动不争抢默认项。登录回调继续按安装区分并新增 Stable 专属回调别名；真实安装包分发和托管回调页面部署仍需发布验证。

## 决策与职责

[深链接 Spec](../../../../specs/deep-links.zh.md) 描述契约和发布顺序。本决策部分替代 [session mention URI 决策](../../implemented/feature/2026-09-18-session-mention-uri-and-paste.md) 的新输出格式，保留旧链接读取、纯文本粘贴和历史内容。最初提案按版本生成不同资源协议；最终采用统一资源协议，仅在需要时显式交给另一安装。

共享包拥有纯 builder/parser 和 MCP workspace 边界助手。UI 负责 mention 生成、复制、粘贴与工作区解析，现有 Session 导航处理精确子会话和标签恢复。Electron 负责资源入口与产品窗口转发，关于设置提供显式默认程序选择。公共嵌入浏览器和匿名分享不获得工作区访问权。

原主进程入口没有 session 资源路由。仅替换前缀不够：产品导航/外链 IPC 仅允许 HTTP(S)，Markdown 则有单独的旧格式按钮渲染器。上述入口现统一识别资源链接。preload 已在 router 订阅前缓存事件，renderer 状态额外等待 workspace 就绪。显式 tab 编码避免路由恢复上次标签而偏离目标。

Stable 原登录回调也使用 lody；当 OSS 或 Nightly 成为默认程序，新 Stable 登录若沿用该地址会发到错误安装。因此新 Stable 请求显式带 stable 浏览器 channel，返回 ai.lody.stable；不带 channel 的旧浏览器调用仍用 lody。打包钩子为解析后的版本配置补上公共和回调协议。浏览器回调页面及覆盖此钩子的打包流程需协调发布。

不采用注册通用 session 系统协议，因为会争抢其他应用的协议名。纯 HTTPS 无法把本地会话变成公共页面。按版本拆分资源协议会让普通链接绑定安装；统一协议接受应用外点击遵循系统默认的取舍。显式 workspace 不匹配时不能悄悄搜索其他数据空间。

## 验证与限制

行为覆盖包括 parser 往返与恶意输入、MCP 跨 workspace 拒绝、mention 输出、新旧 Markdown 点击与匿名不可点击、粘贴/工作区解析、版本回调解析、打包协议声明，以及 AppImage 启动保留默认程序和显式选择改变默认程序。桌面协议测试执行真实模块并注入 OS 适配器，检查注册后的状态与生成的 desktop 文件，不断言源代码文本。

导出转换依据 Markdown 语法位置保护代码（包括嵌套围栏）、HTML 和图片，只替换可识别的正文 URI，不重新序列化整篇文档。导出用的解析器依赖与 Electron 入口使用的轻量资源解析器分离。测试覆盖来源历史不变、显式外部 workspace 保留和两个导出 builder。

公开源码没有私有版本构建入口。复用共享 beforePack 的配置会获得新协议声明，独立版本钩子需采用相同契约。未运行安装器、真实 OS 处理器、生产浏览器授权或远程部署。历史存储和编辑重发保持不变；消息复制及 UI/CLI Markdown 导出转换正文链接，来源已知时补齐 workspace ID，不改变工具数据或猜测匿名分享的来源。workspace ID 是标识，可修改或为空的短名仅用于显示。MCP 的 root+tab 链接需要改用直接子 ID。OS 窗口选择沿用主窗口。没有创建 PR 或声明 Spec 人工批准；命令执行结果在任务交付中报告。
