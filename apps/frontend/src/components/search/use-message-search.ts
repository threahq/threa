import { useCallback, useEffect, useMemo, useRef } from "react"
import { useSearch } from "@/hooks"
import { localStartOfDayISO } from "@/lib/dates"
import {
  useWorkspaceBots,
  useWorkspacePersonas,
  useWorkspaceStreams,
  useWorkspaceUsers,
} from "@/stores/workspace-store"
import { parseSearchQuery, type ParsedFilter } from "@/lib/search-query-parser"
import {
  recordSearchClick,
  type MemoExplorerResult,
  type SearchClickTarget,
  type SearchCluster,
  type SearchFilters,
  type SearchResultItem,
  type SearchRefineOutcome,
} from "@/api"
import type { ArchiveStatus } from "@/api"
import { MAX_SEARCH_PHRASES, MAX_SEARCH_REFINE_CHARS, STREAM_TYPES, type StreamType } from "@threahq/types"

export const SEARCH_DEBOUNCE_MS = 300
const SEARCH_RESULT_LIMIT = 50

export interface MessageSearchState {
  /** Message hits in ranked order, for the flat Ranked view. */
  results: SearchResultItem[]
  /** Conversation rows in ranked order, the default view. */
  clusters: SearchCluster[]
  /** Memo hits the rows point at through `memoIds`. */
  memos: MemoExplorerResult[]
  isLoading: boolean
  error: Error | null
  validationError: string | null
  /** Structured filters parsed out of the query string (from:@…, in:#…, …). */
  parsedFilters: ParsedFilter[]
  /** Free-text part of the query with filters removed. */
  searchText: string
  /** True when the query contains anything searchable; a `/refine` alone is not. */
  hasQuery: boolean
  /** `/refine` prose still in the input, waiting for Enter to commit it; null without a marker. */
  pendingRefine: string | null
  /** The line shown under the summary: the model's note, or why the list is unrefined; null when there is nothing to say. */
  refineNote: string | null
  /** `/w/<ws>/memory?q=<text>`: the memory explorer opened on the same words; memo chips append `&memo=<id>`. */
  exploreHref: string
  /** Attributes an opened result to the logged search; a no-op unless the user opted into query logging. */
  recordResultClick: (target: SearchClickTarget) => void
}

/**
 * Debounced workspace message search over a raw query string with inline
 * filter syntax (`from:@user in:#channel after:2026-01-01 …`) plus the
 * committed `refines`. Shared by the desktop sidebar search panel and the
 * mobile search page so both surfaces parse, resolve, and rank identically.
 */
export function useMessageSearch(workspaceId: string, query: string, refines: string[] = []): MessageSearchState {
  const users = useWorkspaceUsers(workspaceId)
  const personas = useWorkspacePersonas(workspaceId)
  const bots = useWorkspaceBots(workspaceId)
  const streams = useWorkspaceStreams(workspaceId)
  const { results, clusters, memos, queryLogId, refine, isLoading, error, search, clear } = useSearch({
    workspaceId,
    limit: SEARCH_RESULT_LIMIT,
  })

  const {
    filters: parsedFilters,
    text: searchText,
    semanticText,
    phrases,
    refine: pendingRefine,
  } = useMemo(() => parseSearchQuery(query), [query])
  const validationError = validationErrorFor(phrases.length, pendingRefine)

  // Resolve filter slugs (user/stream handles) to ids the API understands.
  const apiFilters = useMemo((): SearchFilters => {
    const filters: SearchFilters = {}

    const resolveUserSlug = (slug: string) => users.find((u) => u.slug === slug)?.id ?? null
    // The from:/with: pickers suggest personas and bots too; authors and stream
    // participants can be any actor. Collision precedence user > persona > bot (INV-64).
    const resolveActorSlug = (slug: string) =>
      resolveUserSlug(slug) ??
      personas.find((p) => p.slug === slug)?.id ??
      bots.find((b) => b.slug === slug)?.id ??
      null
    const resolveStreamSlug = (slug: string) => streams.find((s) => s.slug === slug)?.id ?? null

    for (const filter of parsedFilters) {
      switch (filter.type) {
        case "from": {
          const actorId = resolveActorSlug(filter.value)
          if (actorId) filters.from = actorId
          break
        }
        case "with": {
          const actorId = resolveActorSlug(filter.value)
          if (actorId) filters.with = [...(filters.with ?? []), actorId]
          break
        }
        // Invalid type/status values degrade like unresolved slugs (silent skip)
        // instead of failing the whole request on backend validation.
        case "type":
          if ((STREAM_TYPES as readonly string[]).includes(filter.value)) {
            filters.type = [...(filters.type ?? []), filter.value as StreamType]
          }
          break
        case "status":
          if (filter.value === "active" || filter.value === "archived") {
            filters.status = [...(filters.status ?? []), filter.value as ArchiveStatus]
          }
          break
        case "in": {
          // in:#channel resolves a stream slug; in:@user resolves the user id
          // (the backend maps it to the DM stream with that user)
          const id = filter.raw.startsWith("in:#") ? resolveStreamSlug(filter.value) : resolveUserSlug(filter.value)
          if (id) filters.in = [...(filters.in ?? []), id]
          break
        }
        // The syntax carries date-only values; the API validates full ISO
        // datetimes. Widen to the start of that date in the device's local
        // timezone, and drop values that aren't dates (same silent-skip as
        // unresolved user/stream slugs above).
        case "after": {
          const iso = localStartOfDayISO(filter.value)
          if (iso) filters.after = iso
          break
        }
        case "before": {
          const iso = localStartOfDayISO(filter.value)
          if (iso) filters.before = iso
          break
        }
      }
    }

    if (!parsedFilters.some((filter) => filter.type === "status")) {
      filters.status = ["active", "archived"]
    }

    return filters
  }, [parsedFilters, users, personas, bots, streams])

  const hasQuery = searchText.trim().length > 0 || phrases.length > 0 || parsedFilters.length > 0

  // `users`/`streams` come from live queries that produce a NEW array on every
  // workspace IndexedDB write (incoming messages, presence, …), which gives
  // `apiFilters` a new identity even when its VALUES are unchanged. Depending
  // on the object would reset the debounce on every socket event and starve
  // the search in an active workspace — so the effect keys on a serialized
  // form and reads the current object through a ref.
  const filtersKey = JSON.stringify(apiFilters)
  const filtersRef = useRef(apiFilters)
  filtersRef.current = apiFilters
  const phrasesKey = JSON.stringify(phrases)
  const phrasesRef = useRef(phrases)
  phrasesRef.current = phrases
  const refinesKey = JSON.stringify(refines)
  const refinesRef = useRef(refines)
  refinesRef.current = refines

  useEffect(() => {
    if (!hasQuery || validationError) {
      clear()
      return
    }

    const timer = setTimeout(() => {
      if (refinesRef.current.length > 0) {
        void search(semanticText, filtersRef.current, phrasesRef.current, refinesRef.current)
      } else if (phrasesRef.current.length > 0) {
        void search(semanticText, filtersRef.current, phrasesRef.current)
      } else {
        void search(semanticText, filtersRef.current)
      }
    }, SEARCH_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [hasQuery, validationError, semanticText, filtersKey, phrasesKey, refinesKey, search, clear])

  const recordResultClick = useCallback(
    (target: SearchClickTarget) => {
      if (!queryLogId) return
      recordSearchClick(workspaceId, queryLogId, target).catch((err: unknown) => {
        console.warn("Failed to record search click", err)
      })
    },
    [workspaceId, queryLogId]
  )

  return {
    results,
    clusters,
    memos,
    isLoading,
    error,
    validationError,
    parsedFilters,
    searchText,
    hasQuery,
    pendingRefine,
    refineNote: refineNoteFor(refine),
    exploreHref: `/w/${workspaceId}/memory?q=${encodeURIComponent(searchText)}`,
    recordResultClick,
  }
}

function validationErrorFor(phraseCount: number, pendingRefine: string | null): string | null {
  if (phraseCount > MAX_SEARCH_PHRASES) return `Search supports at most ${MAX_SEARCH_PHRASES} quoted phrases.`
  if (pendingRefine !== null && pendingRefine.length > MAX_SEARCH_REFINE_CHARS) {
    return `A refinement is at most ${MAX_SEARCH_REFINE_CHARS} characters.`
  }
  return null
}

function refineNoteFor(refine: SearchRefineOutcome | null): string | null {
  if (!refine) return null
  return refine.applied ? refine.note : "Couldn't apply the refine; showing the unrefined list."
}
