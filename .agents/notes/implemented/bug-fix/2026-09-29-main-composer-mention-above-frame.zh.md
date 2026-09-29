# 主聊天 composer 的 mention 菜单跟随光标并向上展开

Status: implemented
Translation: current

[English](2026-09-29-main-composer-mention-above-frame.md)

## 摘要

主 composer 的 mention 菜单跟随光标，优先在上方展开。较长的命令描述不再
把菜单撑到整个桌面宽度。

## 决策

主聊天 composer 指定 `menuSide="top"`，但保留光标锚点。固定到
`[data-mention-frame]` 虽然使长菜单位于输入框上方，却让用户打字时补全菜单
留在原处；浏览器测试测得光标已移至 x≈445px，而菜单仍停在框体的 x=336px。
框体锚点仍可供其他调用方显式使用，也仍供移动端停靠面板定位，但桌面端主菜单
不用它。

浮动定位器在光标靠近上边缘时可将菜单翻到下方。它也会按视口宽度写入内联
`max-width`，覆盖菜单按输入区宽度设置的上限：2048px 桌面上，1422px 的
输入区遇到很长的合成命令描述，菜单会被撑到 2048px。现在让输入区宽度上限
优先于定位器的内联宽度，同时保留视口适配。行内编辑器和对话框等默认光标
菜单仍优先向下，并在空间不足时翻转。

## 验证

Playwright 测试在会话 composer 中使用 24 条合成命令。2048×1098 视口下，
长描述在修复前复现横向溢出，修复后菜单保持在 1422px 输入区内。测试还覆盖
光标移动、上边缘回退、滚动与键盘选择、焦点、窗口缩放、编辑器缩放，以及
移动端宽度下的行内编辑器。修复前后截图使用同一宽屏视口。此前 650×250
截图不适合作为桌面窗口证据（桌面窗口最小高度为 600px），现由宽屏证据
替代。尚未验证打包后的 Electron 应用。

## 链接

- [定位 Spec](../../../../specs/composer-mention-menu-placement.zh.md)
- [Composer 调用方](../../../../packages/components/src/components/chat/chat-composer.tsx)
- [定位测试](../../../../packages/components/tests/e2e/composer-mention-placement.spec.ts)
- [PR #1140](https://github.com/LodyAI/Lody/pull/1140)
