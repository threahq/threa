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

const MRU_CAP = 5
const mruStorageKey = (workspaceId: string) => `board:post-target-mru:${workspaceId}`
const draftTargetKey = (workspaceId: string) => `board:new-post:target:${workspaceId}`

/** The in-progress draft's target (a stream id / `new:*` sentinel), or "" if none. */
export function readDraftTarget(workspaceId: string): string {
  try {
    return localStorage.getItem(draftTargetKey(workspaceId)) ?? ""
  } catch {
    return ""
  }
}

/** Persist (or, with "", clear) the in-progress draft's target. */
export function writeDraftTarget(workspaceId: string, value: string): void {
  try {
    if (value) localStorage.setItem(draftTargetKey(workspaceId), value)
    else localStorage.removeItem(draftTargetKey(workspaceId))
  } catch {
    /* ignore */
  }
}

/** The workspace's recently-posted-to target values, newest first (capped). */
export function readTargetMru(workspaceId: string): string[] {
  try {
    const raw = localStorage.getItem(mruStorageKey(workspaceId))
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
  try {
    const next = [value, ...readTargetMru(workspaceId).filter((v) => v !== value)].slice(0, MRU_CAP)
    localStorage.setItem(mruStorageKey(workspaceId), JSON.stringify(next))
  } catch {
    /* ignore */
  }
}
