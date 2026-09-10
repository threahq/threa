import { accountStorageKey } from "@/lib/account-storage"

// Per-workspace persistence for the board overlay composer's target, in two roles:
//
//  - the **current draft target** (`board:new-post:target:<ws>`) pairs with the
//    in-progress `board:new-post` draft body, so a reload restores the body AND
//    the place it was headed — without it a restored draft re-pairs with the
//    wrong stream (or none, disabling send with no explanation).
//  - the **recents MRU** (`board:post-target-mru:<ws>`) is the small list of
//    streams recently POSTED to, feeding the picker's Recents group. It does NOT
//    seed the default target — a successful post clears the target so the next
//    "New post" starts blank instead of re-defaulting to where the last one went.
//
// All best-effort: localStorage can throw (private mode / quota), so every read
// falls back and every write no-ops on failure — this is convenience, not state.

// Both values name streams, and which streams a viewer can see is their own, so
// both keys hang off the active account. With none resolved there is no key, so
// nothing to read and nothing to write.
const MRU_CAP = 5
const mruStorageKey = (workspaceId: string) => accountStorageKey(`board:post-target-mru:${workspaceId}`)
const draftTargetKey = (workspaceId: string) => accountStorageKey(`board:new-post:target:${workspaceId}`)

/** The in-progress draft's target (a stream id / `new:*` sentinel), or "" if none. */
export function readDraftTarget(workspaceId: string): string {
  const key = draftTargetKey(workspaceId)
  if (key === null) return ""
  try {
    return localStorage.getItem(key) ?? ""
  } catch {
    return ""
  }
}

/** Persist (or, with "", clear) the in-progress draft's target. */
export function writeDraftTarget(workspaceId: string, value: string): void {
  const key = draftTargetKey(workspaceId)
  if (key === null) return
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

/** The workspace's recently-posted-to target values, newest first (capped). */
export function readTargetMru(workspaceId: string): string[] {
  const key = mruStorageKey(workspaceId)
  if (key === null) return []
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === "string").slice(0, MRU_CAP)
  } catch {
    return []
  }
}

/** Promote a target to the front of the MRU (dedup, cap). */
export function pushTargetMru(workspaceId: string, value: string): void {
  if (!value) return
  const key = mruStorageKey(workspaceId)
  if (key === null) return
  try {
    const next = [value, ...readTargetMru(workspaceId).filter((v) => v !== value)].slice(0, MRU_CAP)
    localStorage.setItem(key, JSON.stringify(next))
  } catch {
    /* ignore */
  }
}
