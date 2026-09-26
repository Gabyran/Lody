# 在 Markdown 文件预览中显示工作区相对图片

Status: implemented
Translation: current

## 摘要

会话文件查看器中的渲染 Markdown 现在会通过所属文件数据源显示工作区相对图片，
同时保持复制和导出的 Markdown 为轻量、依赖文件的格式。

## 问题

会话文件查看器的渲染 Markdown 模式以前把图片引用直接交给浏览器。这样，
`../assets/diagram.png` 会相对于 Lody 页面 URL 解析，而不是相对于所属工作区，
所以 agent 生成的 Markdown 能显示文字，却显示不出本地图片。

## 决策

查看器现在以 Markdown 文件路径为基准解析相对图片，通过当前文件 provider 读取；本地 Electron
栅格图片使用 `file/resolve-local` 提供的资源 URL。本地 SVG 作为有上限的文本读取，再转换为 Blob。
桌面会话查看器和移动端项目文件浏览器共用
同一套解析能力。绝对 URL、data URL、绝对路径以及逃出工作区的引用保持原有行为或显示不可用。
图片或预览卸载时会释放临时 Blob URL；使用有上限传输时，二进制图片沿用现有的 5 MiB 预览上限。

这有意只是一项查看器能力。Copy as Markdown 仍不携带图片字节，CLI `transcript.md` 仍只有在保留同级
`artifacts` 目录时才是可移植的。没有把所有图片转成 base64，是因为这会增大文档、增加剪贴板和 token
成本，也会扩大无意复制敏感内容的范围。

## 证据与限制

`markdown-image-path.test.ts` 覆盖相对路径解析、路径拒绝和 provider 快照转换；
`session-file-content-view.test.tsx` 覆盖 provider 图片渲染，并确保越界引用不会被打开。
Oxfmt 已通过，两个针对性测试套件通过（39 项）；构建工作区所需的隔离 ACP 子模块后，components
包级类型检查也已通过。

- Pull request: [#1033](https://github.com/LodyAI/Lody/pull/1033)。
