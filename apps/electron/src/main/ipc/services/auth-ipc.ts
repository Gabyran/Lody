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
   * The one step of signing out that can be cancelled, so the renderer runs it
   * before it changes any auth state. Every other product window is closed here:
   * `destroy()` runs no beforeunload, so the storage barrier flushes and asks
   * first. False means the user kept unsaved changes and nothing changed. Closing
   * them now, not in {@link signOut}, leaves no window that could become unsaved
   * between this answer and the sign-out.
   */
  @IpcMethod()
  async prepareSignOut(): Promise<boolean> {
    assertAuthSender()
    return await tearDownWindows({
      barrier: getIpcServiceDeps().windowStorageBarrier,
      windowIds: liveProductWindowIds(),
      keep: getIpcContext().event.sender.id,
      kind: 'sign-out',
      destroy: destroyProductWindow
    })
  }

  /** Never cancels: the renderer has already cleared its auth state. */
  @IpcMethod()
  async signOut() {
    assertAuthSender()
    const sender = getIpcContext().event.sender
    // A window opened since prepareSignOut; one that already holds unsaved
    // changes stays open under its own unload guard rather than being destroyed.
    const barrier = getIpcServiceDeps().windowStorageBarrier
    for (const windowId of liveProductWindowIds()) {
      if (windowId !== sender.id && barrier.mayTearDown(windowId)) destroyProductWindow(windowId)
    }
    await getIpcServiceDeps().authService.signOut()
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
