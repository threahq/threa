import { BOARD_FILTER_PARAMS, BOARD_LENS_PARAM } from "@/components/board/board-filter-params"

const STORAGE_PREFIX = "threa-navigation-journal"

export const NAVIGATION_JOURNAL_LIMIT = 50

export interface JournalEntry {
  path: string
  at: number
}

/** `cursor` is -1 exactly when `entries` is empty. */
export interface NavigationJournal {
  entries: JournalEntry[]
  cursor: number
}

export const EMPTY_JOURNAL: NavigationJournal = { entries: [], cursor: -1 }

export interface JournalStep {
  to: string
  state: { journalCursor: number }
}

export interface RecentStream {
  streamId: string
  href: string
  at: number
}

/** Params that identify a page rather than an overlay on it. `m`, `context`,
 *  `media`, `settings`, `convOverlay`, `memo`, … are overlays: they come and go
 *  on the same page and must not each become a journal stop. */
const JOURNAL_PARAMS: ReadonlySet<string> = new Set([
  "panel",
  "trace",
  "convView",
  BOARD_LENS_PARAM,
  ...BOARD_FILTER_PARAMS,
])

export function journalPath(location: { pathname: string; search: string }): string {
  const out = new URLSearchParams()
  for (const [param, value] of new URLSearchParams(location.search)) {
    if (JOURNAL_PARAMS.has(param)) out.append(param, value)
  }
  const query = out.toString()
  return query ? `${location.pathname}?${query}` : location.pathname
}

export function isJournaledPath(pathname: string, workspaceId: string): boolean {
  const prefix = `/w/${workspaceId}`
  if (!pathname.startsWith(`${prefix}/`)) return false
  if (pathname.startsWith(`${prefix}/delegations/`)) return false
  if (pathname.startsWith(`${prefix}/memos/`)) return false
  return true
}

/** Whether the page's own stream or any `?panel=` stream on this journal path
 *  is in `streamIds`. Used to keep hidden (aside) streams out of the journal. */
export function journalTouchesStream(path: string, workspaceId: string, streamIds: ReadonlySet<string>): boolean {
  const pageId = pageStreamId(path, workspaceId)
  if (pageId && streamIds.has(pageId)) return true
  return new URLSearchParams(path.split("?")[1]).getAll("panel").some((panel) => streamIds.has(panel))
}

export interface VisitOptions {
  cursorHint?: number
  navigationType: "PUSH" | "POP" | "REPLACE"
}

export function recordVisit(
  journal: NavigationJournal,
  path: string,
  now: number,
  opts: VisitOptions
): NavigationJournal {
  const { entries, cursor } = journal
  const stamp = (index: number): NavigationJournal => ({
    entries: entries.map((entry, i) => (i === index ? { ...entry, at: now } : entry)),
    cursor: index,
  })

  // Same page re-observed (an overlay param changed, the streams cache
  // re-rendered the recorder): never a new entry, never a re-stamp.
  if (entries[cursor]?.path === path) return journal

  const hint = opts.cursorHint
  if (typeof hint === "number" && entries[hint]?.path === path) return stamp(hint)

  if (opts.navigationType === "POP") {
    if (entries[cursor - 1]?.path === path) return stamp(cursor - 1)
    if (entries[cursor + 1]?.path === path) return stamp(cursor + 1)
  }

  const kept = entries.slice(0, cursor + 1)
  kept.push({ path, at: now })
  const trimmed = kept.slice(Math.max(0, kept.length - NAVIGATION_JOURNAL_LIMIT))
  return { entries: trimmed, cursor: trimmed.length - 1 }
}

export function journalTarget(journal: NavigationJournal, direction: -1 | 1): JournalStep | null {
  const target = journal.cursor + direction
  const entry = journal.entries[target]
  if (!entry) return null
  return { to: entry.path, state: { journalCursor: target } }
}

export function recentStreams(journal: NavigationJournal, workspaceId: string, limit = 5): RecentStream[] {
  const currentPath = journal.entries[journal.cursor]?.path
  const exclude = currentPath ? pageStreamId(currentPath, workspaceId) : null
  // Back/Forward re-stamp `at` in place, so position is not recency: rank by
  // each stream's newest stamp.
  // Equal stamps (visits within one ms) fall back to journal position.
  const newest = new Map<string, RecentStream & { index: number }>()
  journal.entries.forEach((entry, index) => {
    const streamId = pageStreamId(entry.path, workspaceId)
    if (!streamId || streamId === exclude) return
    const previous = newest.get(streamId)
    if (!previous || entry.at >= previous.at) {
      newest.set(streamId, { streamId, href: `/w/${workspaceId}/s/${streamId}`, at: entry.at, index })
    }
  })
  return [...newest.values()]
    .sort((a, b) => b.at - a.at || b.index - a.index)
    .slice(0, limit)
    .map(({ streamId, href, at }) => ({ streamId, href, at }))
}

/** The stream a `/w/:ws/s/:id` path renders; null for any other page. */
export function pageStreamId(path: string, workspaceId: string): string | null {
  const pathname = path.split("?")[0]
  const prefix = `/w/${workspaceId}/s/`
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length)
  return rest && !rest.includes("/") ? rest : null
}

function key(userId: string, workspaceId: string): string {
  return `${STORAGE_PREFIX}:${userId}:${workspaceId}`
}

// `useSyncExternalStore` compares snapshots by identity, so a fresh parse per
// read would loop forever: one object per key lives here until a write.
const cache = new Map<string, NavigationJournal>()
const listeners = new Map<string, Set<() => void>>()

function parseJournal(raw: string): NavigationJournal | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (!Array.isArray(record.entries) || typeof record.cursor !== "number") return null
  const entries: JournalEntry[] = []
  for (const item of record.entries) {
    if (typeof item !== "object" || item === null) return null
    const entry = item as Record<string, unknown>
    if (typeof entry.path !== "string" || typeof entry.at !== "number") return null
    entries.push({ path: entry.path, at: entry.at })
  }
  const cursor = record.cursor
  if (!Number.isInteger(cursor) || cursor < -1 || cursor >= entries.length) return null
  if ((entries.length === 0) !== (cursor === -1)) return null
  return { entries, cursor }
}

export function readJournal(userId: string, workspaceId: string): NavigationJournal {
  const storageKey = key(userId, workspaceId)
  const cached = cache.get(storageKey)
  if (cached) return cached
  let journal = EMPTY_JOURNAL
  try {
    const raw = localStorage.getItem(storageKey)
    journal = (raw ? parseJournal(raw) : null) ?? EMPTY_JOURNAL
  } catch {
    journal = EMPTY_JOURNAL
  }
  cache.set(storageKey, journal)
  return journal
}

export function writeJournal(userId: string, workspaceId: string, journal: NavigationJournal): void {
  const storageKey = key(userId, workspaceId)
  cache.set(storageKey, journal)
  try {
    localStorage.setItem(storageKey, JSON.stringify(journal))
  } catch {
    // Storage unavailable
  }
  for (const listener of listeners.get(storageKey) ?? []) listener()
}

/** Records a visit into the stored journal; a no-op write when nothing changed. */
export function journalVisit(userId: string, workspaceId: string, path: string, opts: VisitOptions): void {
  const current = readJournal(userId, workspaceId)
  const next = recordVisit(current, path, Date.now(), opts)
  if (next !== current) writeJournal(userId, workspaceId, next)
}

export function subscribeJournal(userId: string, workspaceId: string, listener: () => void): () => void {
  const storageKey = key(userId, workspaceId)
  let set = listeners.get(storageKey)
  if (!set) {
    set = new Set()
    listeners.set(storageKey, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(storageKey)
  }
}

/** Drops the identity cache so a test's `localStorage.clear()` is observable. */
export function resetJournalCacheForTests(): void {
  cache.clear()
}
