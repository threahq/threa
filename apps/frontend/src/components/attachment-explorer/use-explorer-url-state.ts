import { useCallback, useMemo } from "react"
import { useSearchParams } from "react-router-dom"
import { ATTACHMENT_CATEGORIES, type AttachmentCategory } from "@threahq/types"

export const EXPLORER_PARAM = "explorer"
const STREAMS_PARAM = "streams"
const QUERY_PARAM = "q"
const TYPE_PARAM = "type"
const FROM_PARAM = "from"
const NAME_PARAM = "name"
const BEFORE_PARAM = "before"
const AFTER_PARAM = "after"
const VIEW_PARAM = "view"
const SELECTED_PARAM = "selected"

export type ExplorerView = "list" | "grid"

export interface ExplorerFilters {
  /**
   * IDs of streams the user has selected as filters. Empty means "all streams
   * the caller can read" (workspace-wide). Threads are server-side expanded
   * into their root scope when the streamId is a thread root.
   */
  streamIds: string[]
  queryText: string
  categories: AttachmentCategory[]
  uploadedBy: string | null
  nameSubstring: string | null
  before: string | null
  after: string | null
  view: ExplorerView
  selectedAttachmentId: string | null
}

const CATEGORY_SET = new Set<AttachmentCategory>(ATTACHMENT_CATEGORIES)

function parseStreamIds(raw: string | null): string[] {
  if (!raw) return []
  const ids = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
  return Array.from(new Set(ids))
}

function parseCategories(raw: string | null): AttachmentCategory[] {
  if (!raw) return []
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p): p is AttachmentCategory => CATEGORY_SET.has(p as AttachmentCategory))
  return Array.from(new Set(parts))
}

function parseView(raw: string | null): ExplorerView {
  return raw === "grid" ? "grid" : "list"
}

export function readExplorerFiltersFromParams(params: URLSearchParams): ExplorerFilters {
  return {
    streamIds: parseStreamIds(params.get(STREAMS_PARAM)),
    queryText: params.get(QUERY_PARAM) ?? "",
    categories: parseCategories(params.get(TYPE_PARAM)),
    uploadedBy: params.get(FROM_PARAM) || null,
    nameSubstring: params.get(NAME_PARAM) || null,
    before: params.get(BEFORE_PARAM) || null,
    after: params.get(AFTER_PARAM) || null,
    view: parseView(params.get(VIEW_PARAM)),
    selectedAttachmentId: params.get(SELECTED_PARAM) || null,
  }
}

export function isExplorerOpen(params: URLSearchParams): boolean {
  return params.has(EXPLORER_PARAM)
}

function applyFilter(params: URLSearchParams, key: string, value: string | null) {
  if (value === null || value === "") {
    params.delete(key)
  } else {
    params.set(key, value)
  }
}

export function writeExplorerFiltersToParams(params: URLSearchParams, next: Partial<ExplorerFilters>): URLSearchParams {
  const updated = new URLSearchParams(params)

  if ("streamIds" in next) {
    const ids = next.streamIds ?? []
    if (ids.length === 0) updated.delete(STREAMS_PARAM)
    else updated.set(STREAMS_PARAM, Array.from(new Set(ids)).join(","))
  }
  if ("queryText" in next) applyFilter(updated, QUERY_PARAM, next.queryText ?? null)
  if ("categories" in next) applyFilter(updated, TYPE_PARAM, next.categories?.length ? next.categories.join(",") : null)
  if ("uploadedBy" in next) applyFilter(updated, FROM_PARAM, next.uploadedBy ?? null)
  if ("nameSubstring" in next) applyFilter(updated, NAME_PARAM, next.nameSubstring ?? null)
  if ("before" in next) applyFilter(updated, BEFORE_PARAM, next.before ?? null)
  if ("after" in next) applyFilter(updated, AFTER_PARAM, next.after ?? null)
  if ("view" in next) {
    if (!next.view || next.view === "list") updated.delete(VIEW_PARAM)
    else updated.set(VIEW_PARAM, next.view)
  }
  if ("selectedAttachmentId" in next) applyFilter(updated, SELECTED_PARAM, next.selectedAttachmentId ?? null)

  return updated
}

const EXPLORER_KEYS = [
  EXPLORER_PARAM,
  STREAMS_PARAM,
  QUERY_PARAM,
  TYPE_PARAM,
  FROM_PARAM,
  NAME_PARAM,
  BEFORE_PARAM,
  AFTER_PARAM,
  VIEW_PARAM,
  SELECTED_PARAM,
]

/**
 * Modal state lives entirely in URL search params (INV-59). Refresh, back/forward,
 * and shared links all reproduce the exact view. The hook is the single source of
 * truth — callers must not duplicate state in `useState`.
 */
export function useExplorerUrlState() {
  const [searchParams, setSearchParams] = useSearchParams()

  const isOpen = isExplorerOpen(searchParams)

  const filters = useMemo(() => readExplorerFiltersFromParams(searchParams), [searchParams])

  const open = useCallback(
    (overrides?: Partial<ExplorerFilters>) => {
      const next = writeExplorerFiltersToParams(searchParams, overrides ?? {})
      next.set(EXPLORER_PARAM, "")
      setSearchParams(next, { replace: false })
    },
    [searchParams, setSearchParams]
  )

  const close = useCallback(() => {
    const next = new URLSearchParams(searchParams)
    for (const key of EXPLORER_KEYS) next.delete(key)
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const update = useCallback(
    (overrides: Partial<ExplorerFilters>, options: { history?: "push" | "replace" } = {}) => {
      const next = writeExplorerFiltersToParams(searchParams, overrides)
      setSearchParams(next, { replace: options.history !== "push" })
    },
    [searchParams, setSearchParams]
  )

  return { isOpen, filters, open, close, update }
}
