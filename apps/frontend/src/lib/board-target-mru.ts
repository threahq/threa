// Most-recently-used board post targets, per workspace: a small ordered list of
// picker values (stream ids or `new:*` sentinels) so the overlay composer can
// default to — and surface a Recents group for — the places you post to most.
// Supersedes the earlier single-value `board:new-post:target:<ws>` key.

const MRU_CAP = 5
const mruStorageKey = (workspaceId: string) => `board:post-target-mru:${workspaceId}`

/** The workspace's recent target values, newest first (capped, best-effort). */
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

/** Promote a target to the front of the MRU (dedup, cap). Best-effort. */
export function pushTargetMru(workspaceId: string, value: string): void {
  if (!value) return
  try {
    const next = [value, ...readTargetMru(workspaceId).filter((v) => v !== value)].slice(0, MRU_CAP)
    localStorage.setItem(mruStorageKey(workspaceId), JSON.stringify(next))
  } catch {
    // localStorage can throw (private mode / quota); the MRU is a convenience, not state.
  }
}
