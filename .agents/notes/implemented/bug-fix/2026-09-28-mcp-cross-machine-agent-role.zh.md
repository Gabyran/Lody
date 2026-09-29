# Agent 角色可到达执行机器所有者可用的任意机器

Status: implemented
Translation: current

[English](2026-09-28-mcp-cross-machine-agent-role.md)

## 摘要

当 Agent 被要求与另一台机器上绑定的角色协作时，会被 `AGENT_ROLE_MACHINE_MISMATCH`
拒绝，随后它在那台机器上启动了一个没有角色的 Agent，角色的提示词与运行配置因此被静默丢弃。
三处都在执行过时的单机规则：MCP 创建、MCP 资源发现，以及输入框的角色提及，都把普通聊天或
本地项目固定在本机；代理访问检查只接受执行机器所有者名下的机器。现在角色可以从任何上下文
派发到该所有者可用的任意机器：其名下的机器，或已共享的机器；共享机器上的本地项目也必须已共享。
当驱动共享机器的是另一个人时，还会按其本人的权限再检查一次，代理调用不会扩大其权限。

## 发现

`apps/cli/src/mcp/lody-mcp-server.ts` 中的 `resolveMcpSessionCreate` 会拒绝其他机器上的角色，
除非发起方位于 GitHub 项目，这是角色 V1 设计（#135）的规则。[提及 Spec](../../../../specs/agent-role-mentions.md)
与[提及可用性说明](../feature/2026-09-09-agent-role-mention-availability.zh.md)后来把普通聊天
扩展到所有有权限的机器（#548），但 MCP 检查和资源发现的 `roleMachineScope`
（`outside_work_context`）没有同步。该错误不可重试，调用方 Agent 于是改用手动
`machineId + agentConfigId` 创建，而这条路径不携带角色。

MCP 以代理请求方身份运行：daemon 的 CLI token 属于执行机器的所有者，驱动这轮对话的人来自
Turn。代理路径调用托管端的 `canUseMachineFromCliToken`，它原本用于执行 daemon 核验本机上的
请求方，因此要求目标机器归 token 用户所有。于是同事已共享的机器，即使对其本应可用的用户，
也无法到达。

## 决策

- **可达范围。** `readDelegatedMachineAccess`（`apps/cli/src/commands/session.ts`）先以 token
  用户身份调用 `canRequestMachineFromCliToken`：名下机器，或已共享机器加已共享项目。驱动者就是
  该所有者时，以此为准；否则还必须通过被服务请求方检查，因此共享机器上的同事无法到达所有者的
  私有机器。所有代理入口都使用该函数：创建校验、`lody_session_create_options` 的机器与本地项目、
  资源发现。无需修改托管端。
- **目标机器。** 执行 daemon 仍用自己的 `verifyMachineAccess` 核验 Turn 的发起人，本次不放宽。
- **角色落点。** 删除 MCP 机器检查和资源发现的工作上下文范围。子会话必须与父会话同机，因此本地
  项目发起方只有在角色同机时才默认创建子会话；其他机器上的角色在自己的机器上独立启动，使用作为
  `workContext` 传入的本地项目，或作为普通聊天。对远端角色显式要求子会话时，仍以现有的父机器
  错误拒绝。
- **输入框提及。** 所有输入框都使用有权限机器范围；删除 `outside_work_context` 原因及固定机器的
  辅助函数。

被否决的方案：保留本地项目限制（负责人要求角色处处可调用，而独立会话是那里的有效形态）；只检查
驱动者（daemon 可以声称任何同事，因此必须用执行机器所有者的权限约束代理）。

## 限制

驱动他人共享机器的同事，无法通过 Agent 到达第三人的共享机器，尽管其本人可以直接到达：托管端的
被服务请求方查询无法表达这种组合。若要允许，需要一个同时检查两位用户、且不带服务所有者条件的
托管端查询。

## 验证

- `apps/cli/src/commands/session.test.ts` 模拟托管端规则，覆盖名下、共享、未共享、共享项目和
  同事场景；回退为被服务请求方检查，或去掉对同事的收窄，都会使测试失败。
- `apps/cli/src/mcp/lody-mcp-server.test.ts` 覆盖聊天发起方将远端角色解析到其自身机器，以及本地
  项目发起方仅对同机角色默认创建子会话；回退修复后两者均失败。
- CLI 类型检查与范围 lint 通过。
