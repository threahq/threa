const COLORS = [
  { avatar: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300", presence: "#d97706" },
  { avatar: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300", presence: "#2563eb" },
  { avatar: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300", presence: "#059669" },
  { avatar: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300", presence: "#7c3aed" },
  { avatar: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300", presence: "#e11d48" },
  { avatar: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300", presence: "#0891b2" },
  { avatar: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300", presence: "#ea580c" },
  { avatar: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300", presence: "#0d9488" },
]

function colorFor(id: string): (typeof COLORS)[number] {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0
  }
  return COLORS[Math.abs(hash) % COLORS.length]
}

/** Deterministic avatar background and text classes for a user id. */
export function getAvatarColor(id: string): string {
  return colorFor(id).avatar
}

/** The same hue as `getAvatarColor`, as hex `#rrggbb` (y-prosemirror appends an alpha byte for selections). */
export function getPresenceColor(id: string): string {
  return colorFor(id).presence
}
