# 主聊天 composer 的 mention 菜单跟随光标并向上展开

Status: implemented
Translation: current

[English](2026-09-29-main-composer-mention-above-frame.md)

## 摘要

主 composer 的 mention 菜单跟随光标并向上展开。只有窗口上边缘放不下一项时
才退到下方，不再固定于框体或被压成零高度。

## 决策

主聊天 composer 指定 `menuSide="top"`，但保留光标锚点。固定到
`[data-mention-frame]` 虽然使长菜单位于输入框上方，却让用户打字时补全菜单
留在原处；浏览器测试测得光标已移至 x≈445px，而菜单仍停在框体的 x=336px。
框体锚点仍可供其他调用方显式使用，也仍供移动端停靠面板定位，但桌面端主菜单
不用它。

浮动定位器通常会把放不下的向上菜单翻到光标下方。显式指定向上的光标菜单
现在只要能放下一行就保持该方向，并将高度限制在光标上方的可见空间内；
若贴近上边缘连一行也放不下，就退到下方，避免出现零高度菜单。列表在限高空间内滚动。
短视口中如果只有一个结果分组，就隐藏重复的分组标题，让第一项可见；多个
分组的标题和类别的返回控件仍保留。行内编辑器、对话框等默认光标菜单仍优先
向下，并在空间不足时翻转。

## 验证

Playwright 测试在真实会话 composer 中使用 24 条合成命令，验证打字时菜单
随光标水平移动、650×250 视口下仍位于光标上方且首行可见、贴近上边缘时
退到下方并在布局移开后回到上方、Enter 选中筛选
后的命令，以及输入框焦点保持不变。同一光标位置有修复前后截图；修复前的
跟随断言在 x=336px 失败。浏览器场景还检查了移动端宽度、调整窗口大小和
编辑器缩放。尚未验证打包后的 Electron 应用。

## 链接

- [定位 Spec](../../../../specs/composer-mention-menu-placement.zh.md)
- [Composer 调用方](../../../../packages/components/src/components/chat/chat-composer.tsx)
- [定位测试](../../../../packages/components/tests/e2e/composer-mention-placement.spec.ts)
- [PR #1140](https://github.com/LodyAI/Lody/pull/1140)
