# Agent Roles reach any machine the executing machine's owner may use

Status: implemented
Translation: current

[中文](2026-09-28-mcp-cross-machine-agent-role.zh.md)

## Abstract

An Agent asked to work with a Role bound to another machine was refused with
`AGENT_ROLE_MACHINE_MISMATCH`, then started a Role-less Agent on that machine,
silently dropping the Role's prompt and run config. Three layers enforced a
stale single-machine rule: MCP creation, MCP discovery and the composer's Role
mentions pinned plain chats or Local Projects to their own machine, and the
delegated access check only admitted machines the executing machine's owner
owned. Roles are now dispatchable from every context to any machine that owner
may use: machines they own, or shared machines, and a shared machine's local
project only when it is shared too. A different person driving a shared machine
is additionally checked against their own access, so delegation never widens it.

## Discovery

`resolveMcpSessionCreate` in `apps/cli/src/mcp/lody-mcp-server.ts` rejected a
Role on another machine unless the requester was in a GitHub project, a rule from
the Role V1 design (#135). The [mention Spec](../../../../specs/agent-role-mentions.md)
and [mention availability note](../feature/2026-09-09-agent-role-mention-availability.md)
later widened plain chat to all authorized machines (#548), but the MCP check and
discovery's `roleMachineScope` (`outside_work_context`) were not updated. The
error was non-retryable, so the calling Agent fell back to a manual
`machineId + agentConfigId` create, which carries no Role.

MCP runs as a delegated requester: the daemon's CLI token belongs to the
executing machine's owner, and the driving human comes from the Turn. The
delegated path called the hosted `canUseMachineFromCliToken`, which exists for a
serving daemon to vet a requester on its own machine and so requires the target
to be owned by the token user. A teammate's shared machine was therefore
unreachable even for its intended users.

## Decision

- **Reach.** `readDelegatedMachineAccess` (`apps/cli/src/commands/session.ts`)
  first asks `canRequestMachineFromCliToken` as the token user: owned, or shared
  plus a shared project. When the driving human is that owner, this decides.
  Otherwise the served-requester check must also pass, so a teammate on a shared
  machine cannot reach the owner's private machines. Every delegated surface uses
  this function: create validation, `lody_session_create_options` machines and
  local projects, and resource discovery. No hosted change was needed.
- **Target machine.** The executing daemon still verifies the Turn's human with
  its own `verifyMachineAccess`; this change does not relax it.
- **Role placement.** The MCP machine check and discovery's work-context scope
  are removed. A child Session must share its parent's machine, so a Local
  Project requester defaults to a child only for a same-machine Role; a Role
  elsewhere starts independently on its machine, in the local project passed as
  `workContext` or as a plain chat. An explicit child request for a remote Role
  still fails with the existing parent-machine error.
- **Composer mentions.** Every composer uses the authorized-machines scope; the
  `outside_work_context` reason and the pinning helpers are deleted.

Rejected alternatives: keeping the Local Project restriction (the owner asked
for Roles to be callable everywhere, and an independent Session is the valid
shape there), and checking only the driving human (a daemon could name any
teammate, so the executing owner's access must bound delegation).

## Limits

A teammate driving someone else's shared machine cannot reach a third person's
shared machine through an Agent, although they could reach it directly: the
hosted served-requester query cannot express that combination. Allowing it needs
a hosted query that checks both users without the serving-owner condition.

## Verification

- `apps/cli/src/commands/session.test.ts` models the hosted rules and covers
  owned, shared, unshared, shared-project and teammate cases; reverting to the
  served-requester check or dropping the teammate narrowing each fails a test.
- `apps/cli/src/mcp/lody-mcp-server.test.ts` covers a chat requester resolving a
  remote Role to its own machine and a Local Project requester defaulting to a
  child only for a same-machine Role; reverting the fix fails both.
- CLI typecheck and scoped lint pass.
