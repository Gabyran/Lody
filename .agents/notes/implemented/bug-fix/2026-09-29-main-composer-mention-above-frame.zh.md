# 将主聊天 composer 的 mention 菜单固定在框体上方

Status: implemented
Translation: current

[English](2026-09-29-main-composer-mention-above-frame.md)

## 摘要

桌面端主聊天 composer 继承了光标菜单优先向下展开的默认行为，较长的斜杠命令
面板因此可能横跨 composer 并超出可见区域。主 composer 现在明确使用已有的
框体锚点，并将 mention 菜单固定在框体上方。菜单受到框体宽度和上方可用高度
的限制；对话框 composer 与行内编辑器继续跟随光标。这个 checkout 尚未完成
浏览器验证。

## 决策

`ChatComposer` 在带框体、非对话框的分支传入 `menuAnchor="composer"` 和
`menuSide="top"`。`MentionContent` 已会测量 `[data-mention-frame]`，对该
锚点禁用翻转，并按上方空间限制高度。菜单列表已可在限制后的区域内滚动。
因此无需修改通用组件，也不会改变对话框或行内编辑器。

较早的[光标定位决策](2026-09-29-composer-mention-follows-caret.zh.md)仍说明
光标测量和浮动编辑器的行为；其默认值不再用于主聊天 composer。
[固定向上决策](2026-09-26-mention-menu-pinned-above-input.zh.md)说明了为何
这个框体上的菜单即使列表变长也保持在上方。

## 验证

所属 composer 测试会打开真实的斜杠命令菜单，并检查上方空间的高度限制、
框体宽度变量和向上展开的位置。这个嵌套 checkout 没有依赖，因此这里无法
运行测试或进行浏览器渲染。仓库文档检查没有发现此次修改文件中的错误；
但这个 checkout 中其他文件仍有指向缺失子模块的链接错误。

## 链接

- [定位 Spec](../../../../specs/composer-mention-menu-placement.zh.md)
- [Composer 调用方](../../../../packages/components/src/components/chat/chat-composer.tsx)
- [Composer 测试](../../../../packages/components/tests/chat-composer-focus.test.tsx)
