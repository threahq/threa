// Last workspace each signed-in account had open. Read at the `/` entry route
// and when an account switch lands, so a returning viewer goes straight to
// `/w/:id` (which renders from IndexedDB) instead of waiting on the
// control-plane `/api/workspaces` round trip just to discover where to go.
// Purely a navigation hint: the workspace layout still enforces auth and
// membership, and a stale/wrong id falls back to the normal bootstrap path.
//
// Keyed per account: a shared pointer sent every account to the account that
// last wrote it, which for a workspace the destination can't see means a 403
// bounce back into the previous account.
const STORAGE_PREFIX = "threa-last-workspace"

// Pre-multi-account shared pointer. No record of who wrote it, so it is never
// read; it is removed the first time any account writes its own.
const LEGACY_KEY = STORAGE_PREFIX

function key(workosUserId: string): string {
  return `${STORAGE_PREFIX}:${workosUserId}`
}

export function getLastWorkspaceId(workosUserId: string): string | null {
  try {
    return localStorage.getItem(key(workosUserId))
  } catch {
    return null
  }
}

export function setLastWorkspaceId(workosUserId: string, workspaceId: string): void {
  try {
    localStorage.setItem(key(workosUserId), workspaceId)
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    // Storage unavailable
  }
}

export function clearLastWorkspaceId(workosUserId: string): void {
  try {
    localStorage.removeItem(key(workosUserId))
  } catch {
    // Storage unavailable
  }
}

export function clearAllLastWorkspaceIds(): void {
  try {
    for (const storageKey of Object.keys(localStorage)) {
      if (storageKey === LEGACY_KEY || storageKey.startsWith(`${STORAGE_PREFIX}:`)) {
        localStorage.removeItem(storageKey)
      }
    }
  } catch {
    // Storage unavailable
  }
}

/**
 * Where an account lands when it becomes active through the switcher: its own
 * last workspace, or the workspace list when this browser has never seen it
 * there. Never the outgoing account's location.
 */
export function accountHomePath(workosUserId: string): string {
  const workspaceId = getLastWorkspaceId(workosUserId)
  return workspaceId ? `/w/${workspaceId}` : "/workspaces"
}
