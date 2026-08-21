export type Level = "ok" | "warn" | "fail" | "pending" | "skipped"

export interface Finding {
  level: Level
  /** Stable id so `watch` can diff findings across snapshots, e.g. `revision.frontend`. */
  id: string
  message: string
}

export const LEVEL_RANK: Record<Level, number> = { ok: 0, skipped: 0, pending: 1, warn: 2, fail: 3 }

export function worst(levels: Level[]): Level {
  return levels.reduce<Level>((acc, l) => (LEVEL_RANK[l] > LEVEL_RANK[acc] ? l : acc), "ok")
}

export function exitCodeFor(level: Level): number {
  if (level === "fail") return 2
  if (level === "warn" || level === "pending") return 1
  return 0
}

export interface Window {
  /** ISO timestamp the "since" comparison starts at (usually the deploy). */
  since: string
  /** ISO timestamp of the equally long window before `since`. */
  priorStart: string
  /** Now, ISO. */
  now: string
  label: string
}

export function makeWindow(since: Date, now: Date, minWindowMs: number, label: string): Window {
  const requested = now.getTime() - since.getTime()
  const span = Math.max(requested, minWindowMs)
  const effectiveSince = new Date(now.getTime() - span)
  const minutes = Math.round(span / 60000)
  const floored = requested < minWindowMs ? `, floored to ${minutes}m` : ""
  return {
    since: effectiveSince.toISOString(),
    priorStart: new Date(effectiveSince.getTime() - span).toISOString(),
    now: now.toISOString(),
    label: `${label} ${since.toISOString().slice(11, 16)}Z (${minutes}m window${floored})`,
  }
}
