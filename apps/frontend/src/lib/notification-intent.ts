// One-shot, workspace-keyed handoff from the SW-message handler (which runs
// outside React, with no AccountScope context) to WorkspaceLayout's
// account-switch hook. The notification carries the recipient account's WorkOS
// user id; the hook reads it once and resolves/flips the active account so the
// deep link opens under the right identity.

let pending: { workspaceId: string; workosUserId: string } | null = null
const listeners = new Set<() => void>()

export function setNotificationIntent(workspaceId: string, workosUserId: string): void {
  pending = { workspaceId, workosUserId }
  for (const listener of [...listeners]) listener()
}

/**
 * Watch for intents set after the reader mounted. A notification click for
 * another account in the workspace already on screen navigates without
 * remounting anything, so a reader that only looks on mount would leave the
 * deep link open under the wrong account.
 */
export function subscribeNotificationIntent(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Returns the pending recipient WorkOS user id iff it was set for this exact
 * workspace, clearing it so it fires at most once. A mismatched workspace (a
 * later, unrelated mount) leaves the intent untouched and returns null.
 */
export function takeNotificationIntent(workspaceId: string): string | null {
  if (pending?.workspaceId !== workspaceId) return null
  const id = pending.workosUserId
  pending = null
  return id
}
