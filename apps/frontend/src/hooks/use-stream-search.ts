import { useState, useCallback, useRef, useMemo } from "react"
import { searchMessages, type SearchFilters, type SearchResultItem } from "@/api"
import { db, type CachedEvent } from "@/db"
import { requestDecryption } from "@/lib/crypto/decrypt-cache"
import { useE2eSession } from "@/stores/e2e-session-store"

interface UseStreamSearchOptions {
  workspaceId: string
  streamId: string
  /**
   * When the stream is end-to-end encrypted, in-stream search matches against
   * the *decrypted* message bodies (the server only stores ciphertext + a
   * zero-width placeholder), and the server-side ILIKE phase is skipped because
   * it can only ever match the placeholder. Plaintext streams are unaffected.
   */
  e2eEnabled?: boolean
  /** Current workspace user id — needed to resolve the E2E session for decryption. */
  userId?: string | null
}

/**
 * Resolve an event's searchable plaintext body: the bare `contentMarkdown` for
 * a plaintext row, or the decrypted markdown for a sealed row. Returns `null`
 * when a sealed row can't be read (locked session / decrypt failure) so it is
 * simply skipped rather than matched against its zero-width placeholder.
 */
export type SearchContentResolver = (event: CachedEvent) => Promise<string | null>

/** Extract the sealed payload off a cached event, or null when it's plaintext. */
function readSealedEventPayload(
  event: CachedEvent
): { ciphertext: string; envelope: unknown; contentMarkdown?: string } | null {
  if (event.eventType !== "message_created") return null
  const payload = event.payload as Record<string, unknown> | undefined
  if (!payload || typeof payload.ciphertext !== "string" || !payload.envelope) return null
  return {
    ciphertext: payload.ciphertext,
    envelope: payload.envelope,
    contentMarkdown: typeof payload.contentMarkdown === "string" ? payload.contentMarkdown : undefined,
  }
}

/**
 * Pure matcher: given loaded events (any order) and a content resolver, return
 * the chronologically-ordered `SearchResultItem`s whose resolved body contains
 * `query` (case-insensitive). Shared by the plaintext and E2E search paths and
 * unit-tested directly.
 */
export async function collectLocalMatches(
  events: CachedEvent[],
  query: string,
  resolve: SearchContentResolver
): Promise<SearchResultItem[]> {
  const lowerQuery = query.toLowerCase()
  const sorted = [...events].sort((a, b) => a._sequenceNum - b._sequenceNum)
  const resolved = await Promise.all(sorted.map(async (e) => ({ e, content: await resolve(e) })))
  const out: SearchResultItem[] = []
  for (const { e, content } of resolved) {
    if (!content || !content.toLowerCase().includes(lowerQuery)) continue
    const payload = e.payload as { messageId?: string }
    out.push({
      id: payload.messageId ?? e.id,
      streamId: e.streamId,
      content,
      authorId: e.actorId ?? "",
      authorType: (e.actorType ?? "user") as "user" | "persona",
      createdAt: e.createdAt,
      rank: 0,
    })
  }
  return out
}

/** A single navigable match: one text occurrence within one message */
export interface FlatMatch {
  messageId: string
  /** Which occurrence within this message (0-based) */
  occurrence: number
}

interface UseStreamSearchReturn {
  query: string
  setQuery: (query: string) => void
  results: SearchResultItem[]
  isSearching: boolean
  hasSearched: boolean
  error: Error | null
  /** All flat matches (every text occurrence across all messages) */
  flatMatches: FlatMatch[]
  /** Index into flatMatches for the currently active match */
  activeMatchIndex: number
  /** Total flat match count */
  matchCount: number
  /** Execute search with current query */
  search: () => Promise<void>
  /** Move to next (newer) match */
  nextResult: () => void
  /** Move to previous (older) match */
  prevResult: () => void
  /** Reset search state */
  clear: () => void
  /** The message ID of the currently active match */
  activeMessageId: string | null
  /** The occurrence index within the active message */
  activeOccurrence: number
  /** Re-focus the search input */
  focus: () => void
  inputRef: React.RefObject<HTMLInputElement | null>
}

/** Count non-overlapping occurrences of `query` in `text` (case-insensitive) */
function countOccurrences(text: string, query: string): number {
  if (!query) return 0
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  let count = 0
  let pos = 0
  while ((pos = lower.indexOf(q, pos)) !== -1) {
    count++
    pos += q.length
  }
  return count
}

/** Build a flat list of all matches: one entry per text occurrence, ordered chronologically */
function buildFlatMatches(results: SearchResultItem[], query: string): FlatMatch[] {
  const matches: FlatMatch[] = []
  for (const result of results) {
    const count = countOccurrences(result.content, query)
    for (let i = 0; i < Math.max(count, 1); i++) {
      matches.push({ messageId: result.id, occurrence: i })
    }
  }
  return matches
}

/**
 * Search local IDB events for a text match (case-insensitive substring),
 * resolving each event's body through `resolve` — bare markdown for plaintext
 * streams, decrypted markdown for E2E streams.
 */
async function searchLocalEvents(
  streamId: string,
  query: string,
  resolve: SearchContentResolver
): Promise<SearchResultItem[]> {
  const events = await db.events
    .where("streamId")
    .equals(streamId)
    .filter((e) => e.eventType === "message_created" || e.eventType === "companion_response")
    .toArray()
  return collectLocalMatches(events, query, resolve)
}

/** Merge local and server results, dedup by id, sort chronologically (oldest first) */
function mergeAndSort(local: SearchResultItem[], server: SearchResultItem[]): SearchResultItem[] {
  const seen = new Map<string, SearchResultItem>()
  for (const r of local) seen.set(r.id, r)
  for (const r of server) seen.set(r.id, r)
  return Array.from(seen.values()).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
}

export function useStreamSearch({
  workspaceId,
  streamId,
  e2eEnabled = false,
  userId = null,
}: UseStreamSearchOptions): UseStreamSearchReturn {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [activeMatchIndex, setActiveMatchIndex] = useState(0)
  const [hasSearched, setHasSearched] = useState(false)
  const searchIdRef = useRef(0)
  const queryRef = useRef(query)
  queryRef.current = query
  const inputRef = useRef<HTMLInputElement>(null)
  const activeMatchIndexRef = useRef(activeMatchIndex)
  activeMatchIndexRef.current = activeMatchIndex

  // E2E search reads decrypted bodies on demand. For a plaintext stream the
  // session is irrelevant (sealed-payload resolution returns null and the row
  // falls through to its plaintext `contentMarkdown`), so this is a no-op there.
  const session = useE2eSession(workspaceId, userId ?? "")
  const sessionRef = useRef(session)
  sessionRef.current = session

  // Resolve an event's searchable body. Sealed rows decrypt on demand (warming
  // the shared decrypt cache the timeline also reads); plaintext rows return
  // their stored markdown. A sealed row that can't be opened resolves to null
  // and is skipped — matching the documented "search over already-decrypted
  // content" behavior rather than matching the zero-width placeholder.
  const resolveContent = useCallback<SearchContentResolver>(
    async (event) => {
      const sealed = readSealedEventPayload(event)
      if (!sealed) {
        const payload = event.payload as { contentMarkdown?: string }
        return typeof payload.contentMarkdown === "string" ? payload.contentMarkdown : null
      }
      const s = sessionRef.current
      if (s.status !== "unlocked" || !s.privateKey || !s.keyId) return null
      const entry = await requestDecryption(
        event.id,
        { contentMarkdown: sealed.contentMarkdown ?? "", envelope: sealed.envelope, ciphertext: sealed.ciphertext },
        { privateKey: s.privateKey, recipientKeyId: s.keyId, workspaceId, streamId: event.streamId }
      )
      return entry.status === "decrypted" && entry.content ? entry.content.contentMarkdown : null
    },
    [workspaceId]
  )

  // Build flat matches from results + current query
  const flatMatches = useMemo(() => buildFlatMatches(results, query), [results, query])

  const search = useCallback(async () => {
    const trimmed = queryRef.current.trim()
    if (!trimmed) {
      setResults([])
      setActiveMatchIndex(0)
      return
    }

    const searchId = ++searchIdRef.current
    setIsSearching(true)
    setError(null)
    let localResults: SearchResultItem[] = []

    try {
      // Phase 1: instant local IDB substring search (decrypting sealed rows on
      // demand for E2E streams).
      localResults = await searchLocalEvents(streamId, trimmed, resolveContent)
      if (searchId !== searchIdRef.current) return

      if (localResults.length > 0) {
        setResults(localResults)
        const localFlat = buildFlatMatches(localResults, trimmed)
        setActiveMatchIndex(localFlat.length > 0 ? localFlat.length - 1 : 0)
        setHasSearched(true)
      }

      // E2E streams: the server only holds ciphertext + a zero-width placeholder,
      // so the ILIKE phase can never match the real body. The local decrypted
      // search above is authoritative — finalize (even when empty) and stop.
      if (e2eEnabled) {
        const localFlat = buildFlatMatches(localResults, trimmed)
        setResults(localResults)
        setActiveMatchIndex(localFlat.length > 0 ? localFlat.length - 1 : -1)
        setHasSearched(true)
        return
      }

      // Phase 2: server exact search (ILIKE) — covers events not in IDB.
      // Uses exact=true to avoid semantic/fuzzy matches that can't be highlighted.
      const filters: SearchFilters = { in: [streamId] }
      const response = await searchMessages(workspaceId, { query: trimmed, filters, exact: true, limit: 50 })
      if (searchId !== searchIdRef.current) return

      const merged = mergeAndSort(localResults, response.results)
      setResults(merged)
      // Stabilize the active match after merge — server results may insert
      // older items before the current selection, shifting all indices.
      // Find the previously active message in the new flat list to keep the
      // user on the same match instead of silently redirecting them.
      const mergedFlat = buildFlatMatches(merged, trimmed)
      const prevActiveId =
        localResults.length > 0 ? buildFlatMatches(localResults, trimmed)[activeMatchIndexRef.current]?.messageId : null
      if (prevActiveId) {
        let restoredIdx = -1
        for (let i = mergedFlat.length - 1; i >= 0; i--) {
          if (mergedFlat[i].messageId === prevActiveId) {
            restoredIdx = i
            break
          }
        }
        setActiveMatchIndex(restoredIdx >= 0 ? restoredIdx : mergedFlat.length - 1)
      } else {
        setActiveMatchIndex(mergedFlat.length > 0 ? mergedFlat.length - 1 : -1)
      }
      setHasSearched(true)
    } catch (e) {
      if (searchId !== searchIdRef.current) return
      setError(e instanceof Error ? e : new Error("Search failed"))
      // Keep local results if server fails
      if (localResults.length === 0) {
        setResults([])
        setActiveMatchIndex(-1)
      }
    } finally {
      if (searchId === searchIdRef.current) {
        setIsSearching(false)
      }
    }
  }, [workspaceId, streamId, e2eEnabled, resolveContent])

  const prevResult = useCallback(() => {
    if (flatMatches.length === 0) return
    setActiveMatchIndex((prev) => (prev > 0 ? prev - 1 : flatMatches.length - 1))
  }, [flatMatches.length])

  const nextResult = useCallback(() => {
    if (flatMatches.length === 0) return
    setActiveMatchIndex((prev) => (prev < flatMatches.length - 1 ? prev + 1 : 0))
  }, [flatMatches.length])

  const clear = useCallback(() => {
    setQuery("")
    setResults([])
    setActiveMatchIndex(0)
    setError(null)
    setIsSearching(false)
    setHasSearched(false)
    searchIdRef.current++
  }, [])

  const focus = useCallback(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const activeMatch = flatMatches.length > 0 && activeMatchIndex >= 0 ? flatMatches[activeMatchIndex] : null

  return {
    query,
    setQuery,
    results,
    isSearching,
    error,
    flatMatches,
    activeMatchIndex,
    hasSearched,
    matchCount: flatMatches.length,
    search,
    nextResult,
    prevResult,
    clear,
    activeMessageId: activeMatch?.messageId ?? null,
    activeOccurrence: activeMatch?.occurrence ?? 0,
    focus,
    inputRef,
  }
}
