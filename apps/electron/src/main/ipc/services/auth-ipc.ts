import { tearDownWindows } from '@lody/shared/renderer-storage-barrier'
import { destroyProductWindow, liveProductWindowIds } from '../../window-state'
import { getIpcContext, IpcMethod, IpcService } from 'electron-ipc-decorator'
import {
  ElectronDevEmailPasswordSignInInputSchema,
  type ElectronDevEmailPasswordSignInInput
} from '@lody/shared/electron-ipc'
import { assertProductWindowSender } from '../assert-sender'
import { getIpcServiceDeps } from '../ipc-service-deps'

function assertAuthSender(): void {
  const { event } = getIpcContext()
  assertProductWindowSender(event)
}

const workspaceSelections = new WeakMap<
  Electron.WebContents,
  { organizationId?: string; organizationSlug?: string }
>()

export class AuthIpc extends IpcService {
  static override readonly groupName = 'auth'

  @IpcMethod()
  async startLogin() {
    assertAuthSender()
    await getIpcServiceDeps().authService.startLogin()
  }

  @IpcMethod()
  getLoginState() {
    assertAuthSender()
    return getIpcServiceDeps().authService.login.getState()
  }

  @IpcMethod()
  async signInWithDevEmailPassword(payload: ElectronDevEmailPasswordSignInInput) {
    assertAuthSender()
    const input = ElectronDevEmailPasswordSignInInputSchema.parse(payload)
    return await getIpcServiceDeps().authService.signInWithDevEmailPassword(input)
  }

  /**
   * Before the renderer clears its own auth state: every window whose own repo
   * holds unsaved changes flushes, and the user confirms dropping what is still
   * unsaved. False means signing out was cancelled and nothing changed.
   */
  @IpcMethod()
  async prepareSignOut(): Promise<boolean> {
    assertAuthSender()
    return await getIpcServiceDeps().windowStorageBarrier.approveTeardown(
      liveProductWindowIds(),
      'sign-out'
    )
  }

  @IpcMethod()
  async signOut(): Promise<{ signedOut: boolean }> {
    assertAuthSender()
    const sender = getIpcContext().event.sender
    // `destroy()` runs no beforeunload, so the storage barrier approves first; a
    // window that became unsaved since prepareSignOut is asked again.
    const approved = await tearDownWindows({
      barrier: getIpcServiceDeps().windowStorageBarrier,
      windowIds: liveProductWindowIds(),
      keep: sender.id,
      kind: 'sign-out',
      destroy: destroyProductWindow
    })
    if (!approved) return { signedOut: false }
    await getIpcServiceDeps().authService.signOut()
    return { signedOut: true }
  }

  @IpcMethod()
  async getSession(options?: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.getSession(options)
  }

  @IpcMethod()
  async listOrganizations(options?: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.listOrganizations(options)
  }

  @IpcMethod()
  async getActiveOrganization(options?: unknown) {
    assertAuthSender()
    const sender = getIpcContext().event.sender
    const url = new URL(sender.getURL())
    const path = url.protocol === 'file:' ? url.hash.slice(1) : url.pathname
    const slug = path.split('/')[1]?.split('?')[0]
    const query =
      workspaceSelections.get(sender) ??
      (slug && !['onboarding', 'sign-in', 'login'].includes(slug)
        ? { organizationSlug: slug }
        : undefined)
    return await getIpcServiceDeps().authService.getActiveOrganization(options, query)
  }

  @IpcMethod()
  async changeEmail(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.changeEmail(payload)
  }

  @IpcMethod()
  async listAccounts(options?: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.listAccounts(options)
  }

  @IpcMethod()
  async updateUser(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.updateUser(payload)
  }

  @IpcMethod()
  async changePassword(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.changePassword(payload)
  }

  @IpcMethod()
  async requestPasswordReset(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.requestPasswordReset(payload)
  }

  @IpcMethod()
  async convexToken(options?: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.convexToken(options)
  }

  @IpcMethod()
  async crossDomainVerifyOneTimeToken(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.crossDomainVerifyOneTimeToken(payload)
  }

  @IpcMethod()
  async getInvitation(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.organizationGetInvitation(payload)
  }

  @IpcMethod()
  async acceptInvitation(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.organizationAcceptInvitation(payload)
  }

  @IpcMethod()
  async listInvitations(payload?: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.organizationListInvitations(payload)
  }

  @IpcMethod()
  async inviteMember(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.organizationInviteMember(payload)
  }

  @IpcMethod()
  async cancelInvitation(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.organizationCancelInvitation(payload)
  }

  @IpcMethod()
  async removeMember(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.organizationRemoveMember(payload)
  }

  @IpcMethod()
  async updateMemberRole(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.organizationUpdateMemberRole(payload)
  }

  @IpcMethod()
  async setActive(payload: unknown) {
    assertAuthSender()
    const id = (payload as { organizationId?: unknown } | null)?.organizationId
    if (typeof id !== 'string' || !id) throw new Error('Invalid organization id')
    const sender = getIpcContext().event.sender
    const query = { organizationId: id }
    const previous = workspaceSelections.get(sender)
    workspaceSelections.set(sender, query)
    let accepted = false
    try {
      const result = await getIpcServiceDeps().authService.getActiveOrganization(payload, query)
      accepted = Boolean(result.data && !result.error)
      return result
    } finally {
      if (!accepted && workspaceSelections.get(sender) === query) {
        if (previous) workspaceSelections.set(sender, previous)
        else workspaceSelections.delete(sender)
      }
    }
  }

  @IpcMethod()
  async updateOrganization(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.organizationUpdate(payload)
  }

  @IpcMethod()
  async createOrganization(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.organizationCreate(payload)
  }

  @IpcMethod()
  async deleteOrganization(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.organizationDelete(payload)
  }

  @IpcMethod()
  async leaveOrganization(payload: unknown) {
    assertAuthSender()
    return await getIpcServiceDeps().authService.organizationLeave(payload)
  }
}
