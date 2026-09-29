# Composer mention 菜单定位

Status: draft
Translation: current

[English](composer-mention-menu-placement.md)

用户在桌面端主聊天 composer 中打开 `@`、`$`、`/` 或 `、` 菜单后，菜单始终
位于整个 composer 框上方；继续输入或切换菜单层级也不会改变方向。菜单宽度
不得超过该框的可用宽度。若上方空间不足以容纳完整菜单，菜单高度受该空间
限制，菜单行仍可通过滚动访问。

编辑并重发的行内菜单和对话框 composer 跟随当前光标，优先显示在光标下方，
空间不足时翻转到上方。自动换行、输入框内部滚动、布局移动和缩放后的编辑
容器不能让这些菜单停留在旧的光标位置。菜单宽度受输入区约束；若两侧都放
不下完整菜单，菜单行仍可在可见视口内滚动访问。

在较窄的移动端视口，主 composer 继续使用靠近键盘停靠的 mention 面板；
行内编辑器继续使用浮动菜单。停靠面板位于包含输入框上方附件和控件的整个
composer 框之上，且不得越过视口顶部留白。

## 证据

- [主 composer](../packages/components/src/components/chat/chat-composer.tsx)
- [菜单调用方](../packages/components/src/components/mentions/mention-two-level-menu.tsx)
- [光标锚点](../packages/components/src/ui/mention/mention-input.tsx)
- [Composer 定位测试](../packages/components/tests/chat-composer-focus.test.tsx)
- [光标锚点测试](../packages/components/tests/mention-ref-stability.test.tsx)
- [移动端定位测试](../packages/components/tests/mention-two-level-menu.test.tsx)
