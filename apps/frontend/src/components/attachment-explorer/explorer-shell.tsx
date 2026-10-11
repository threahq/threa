import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Search, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-mobile"
import { useElementWidth } from "@/hooks/use-element-width"
import { useResizeDrag } from "@/hooks/use-resize-drag"
import { useDebouncedUrlText } from "@/hooks/use-debounced-url-text"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { PanelResizeHandle } from "@/components/layout/panel-resize-handle"
import { useExplorerUrlState } from "./use-explorer-url-state"
import { useAttachmentSearch } from "./use-attachment-search"
import { ExplorerFilters } from "./explorer-filters"
import { ExplorerList } from "./explorer-list"
import { ExplorerPreview } from "./explorer-preview"

const DEFAULT_PREVIEW_WIDTH = 420
const MIN_PREVIEW_WIDTH = 280
const MIN_LIST_WIDTH = 280

interface ExplorerShellProps {
  workspaceId: string
  /**
   * "modal" hides the page chrome and shows a close button that strips the
   * URL marker. "page" omits the close button — the surface owns its own
   * navigation chrome (back button, sidebar, etc.) and never closes.
   */
  mode: "modal" | "page"
  enabled: boolean
}

const QUERY_DEBOUNCE_MS = 200

export function ExplorerShell({ workspaceId, mode, enabled }: ExplorerShellProps) {
  const { filters, close, update } = useExplorerUrlState()
  const streams = useWorkspaceStreams(workspaceId)
  const isMobile = useIsMobile()

  const search = useAttachmentSearch(workspaceId, filters, { enabled })

  const { draft: queryDraft, setDraft: handleQueryChange } = useDebouncedUrlText({
    value: filters.queryText,
    onCommit: useCallback((next: string) => update({ queryText: next }), [update]),
    delayMs: QUERY_DEBOUNCE_MS,
  })

  const parentStreamId = useMemo(() => {
    // Surface a single parent only when exactly one stream is filtered to —
    // otherwise the "include parent" prompt would be ambiguous.
    if (filters.streamIds.length !== 1) return null
    const stream = streams.find((s) => s.id === filters.streamIds[0])
    if (!stream) return null
    return stream.rootStreamId ?? null
  }, [filters.streamIds, streams])

  const selectedItem = useMemo(() => {
    if (!filters.selectedAttachmentId) return null
    return search.items.find((item) => item.id === filters.selectedAttachmentId) ?? null
  }, [filters.selectedAttachmentId, search.items])

  const containerRef = useRef<HTMLDivElement | null>(null)
  // A narrow pane stacks like a phone. Unmeasured (0) counts as narrow, so the first commit can't auto-select.
  const width = useElementWidth(containerRef)
  const stacked = isMobile || width < MIN_LIST_WIDTH + MIN_PREVIEW_WIDTH

  // Auto-select the first item beside the list so the preview pane has content.
  // Also reselects when the current selection drops out of the result set
  // (e.g. after a filter change), otherwise the preview pane goes blank.
  // Stacked, we never auto-select — that would hide the list immediately.
  useEffect(() => {
    if (!enabled || stacked) return
    if (search.items.length === 0) return
    const stillVisible = search.items.some((item) => item.id === filters.selectedAttachmentId)
    if (stillVisible) return
    update({ selectedAttachmentId: search.items[0]!.id })
  }, [enabled, stacked, filters.selectedAttachmentId, search.items, update])

  // Narrowing a step (side by side, stacked pane, phone) drops the selection so the shell lands on the list.
  // It was auto-selected or made without a history entry, which the phone's Back would step past.
  const narrowness = Number(stacked) + Number(isMobile)
  const lastNarrowness = useRef(narrowness)
  useEffect(() => {
    if (narrowness > lastNarrowness.current) update({ selectedAttachmentId: null })
    lastNarrowness.current = narrowness
  }, [narrowness, update])

  useEffect(() => {
    // Stacked, a pick hides the focused row, stranding focus outside the shell.
    if (!enabled || stacked) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
      const target = e.target instanceof HTMLElement ? e.target : null
      // Stay scoped to the explorer; on /files the shell shares window with
      // the sidebar/header, where ArrowUp/Down should keep their default behavior.
      if (!target || !containerRef.current?.contains(target)) return
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return
      }
      if (!search.items.length) return
      const index = search.items.findIndex((item) => item.id === filters.selectedAttachmentId)
      if (e.key === "ArrowDown") {
        e.preventDefault()
        const next = search.items[Math.min(index + 1, search.items.length - 1)]
        if (next) update({ selectedAttachmentId: next.id })
      } else {
        e.preventDefault()
        const prev = search.items[Math.max(index - 1, 0)]
        if (prev) update({ selectedAttachmentId: prev.id })
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [enabled, stacked, search.items, filters.selectedAttachmentId, update])

  const hasFilters =
    filters.streamIds.length > 0 ||
    filters.categories.length > 0 ||
    Boolean(filters.uploadedBy) ||
    Boolean(filters.nameSubstring) ||
    Boolean(filters.before) ||
    Boolean(filters.after) ||
    filters.queryText.trim().length > 0

  const clearFilters = () =>
    update({
      streamIds: [],
      categories: [],
      uploadedBy: null,
      nameSubstring: null,
      before: null,
      after: null,
      queryText: "",
    })

  const widenScope = () => update({ streamIds: [] })

  const showPreviewOnly = stacked && Boolean(selectedItem)

  const [previewWidth, setPreviewWidth] = useState(DEFAULT_PREVIEW_WIDTH)

  const maxPreviewWidth = Math.max(MIN_PREVIEW_WIDTH, width - MIN_LIST_WIDTH)
  const shownPreviewWidth = Math.min(previewWidth, maxPreviewWidth)

  const handlePreviewWidthChange = useCallback(
    (next: number) => setPreviewWidth(Math.max(MIN_PREVIEW_WIDTH, Math.min(maxPreviewWidth, next))),
    [maxPreviewWidth]
  )

  const { isResizing, handleResizeStart, handleResizeMove, handleResizeEnd } = useResizeDrag({
    width: shownPreviewWidth,
    onWidthChange: handlePreviewWidthChange,
    direction: "left",
  })

  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 50 : 10
      if (e.key === "ArrowLeft") {
        e.preventDefault()
        handlePreviewWidthChange(shownPreviewWidth + step)
      } else if (e.key === "ArrowRight") {
        e.preventDefault()
        handlePreviewWidthChange(shownPreviewWidth - step)
      }
    },
    [shownPreviewWidth, handlePreviewWidthChange]
  )

  return (
    <div ref={containerRef} className="flex h-full flex-col" data-testid="attachment-explorer">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        {showPreviewOnly ? (
          <Button
            size="icon"
            variant="ghost"
            // Only a phone pushed the selection; a narrow pane's may be the auto-selected one.
            onClick={() => (isMobile ? window.history.back() : update({ selectedAttachmentId: null }))}
            aria-label="Back to file list"
            className="h-7 w-7"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        ) : (
          <Search className="h-4 w-4 flex-none text-muted-foreground" aria-hidden />
        )}
        <Input
          // Skip autoFocus on mobile — it pops the on-screen keyboard the
          // moment the explorer mounts, which is jarring for a surface the
          // user often opens just to browse.
          autoFocus={mode === "modal" && !isMobile}
          value={queryDraft}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder="Search filename, content, or use “quoted phrase” for exact"
          className="h-8 border-none px-1 shadow-none focus-visible:ring-0"
          aria-label="Search attachments"
        />
        {mode === "modal" ? (
          <Button size="icon" variant="ghost" onClick={close} aria-label="Close" className="h-7 w-7">
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      {showPreviewOnly ? null : (
        <ExplorerFilters
          workspaceId={workspaceId}
          filters={filters}
          parentStreamId={parentStreamId}
          onUpdate={update}
        />
      )}

      <div className="flex flex-1 overflow-hidden border-t">
        <div
          className={
            showPreviewOnly
              ? "hidden"
              : cn("flex w-full flex-1 flex-col overflow-y-auto", stacked ? "min-w-0" : "min-w-[280px]")
          }
        >
          <ExplorerList
            workspaceId={workspaceId}
            items={search.items}
            isLoading={search.isLoading}
            isError={search.isError}
            hasNextPage={search.hasNextPage}
            isFetchingNextPage={search.isFetchingNextPage}
            fetchNextPage={search.fetchNextPage}
            selectedId={filters.selectedAttachmentId}
            onSelect={(id) =>
              update(
                { selectedAttachmentId: id },
                // On mobile, tapping a row swaps the layout to preview-only —
                // push history so hardware Back returns to the list instead
                // of closing the explorer entirely.
                { history: isMobile ? "push" : "replace" }
              )
            }
            hasFilters={hasFilters}
            onClearFilters={clearFilters}
            onWidenScope={widenScope}
          />
        </div>
        {!stacked && (
          <PanelResizeHandle
            isResizing={isResizing}
            panelWidth={shownPreviewWidth}
            minWidth={MIN_PREVIEW_WIDTH}
            maxWidth={maxPreviewWidth}
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerEnd={handleResizeEnd}
            onKeyDown={handleResizeKeyDown}
            ariaLabel="Resize preview pane"
          />
        )}
        <div
          className={showPreviewOnly ? "w-full flex-1" : cn("flex-shrink-0", stacked && "hidden")}
          style={stacked ? undefined : { width: shownPreviewWidth }}
        >
          <ExplorerPreview workspaceId={workspaceId} item={selectedItem} />
        </div>
      </div>
    </div>
  )
}
