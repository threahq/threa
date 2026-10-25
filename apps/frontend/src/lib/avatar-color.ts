/** Deterministic color from user ID for avatar backgrounds */
const AVATAR_COLORS = [
  "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
  "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
]

/** Hex `#rrggbb` (y-prosemirror appends an alpha byte for selections), index-aligned with `AVATAR_COLORS`. */
const PRESENCE_COLORS = ["#d97706", "#2563eb", "#059669", "#7c3aed", "#e11d48", "#0891b2", "#ea580c", "#0d9488"]

function colorIndex(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % AVATAR_COLORS.length
}

export function getAvatarColor(id: string): string {
  return AVATAR_COLORS[colorIndex(id)]
}

export function getPresenceColor(id: string): string {
  return PRESENCE_COLORS[colorIndex(id)]
}
