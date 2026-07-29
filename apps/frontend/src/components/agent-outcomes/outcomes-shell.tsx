import { useCallback, useMemo, useRef, useState } from "react"
import { ArrowLeft, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PanelResizeHandle } from "@/components/layout/panel-resize-handle"
import { useAgentOutcomes } from "@/hooks/use-agent-outcomes"
import { useDebouncedUrlText } from "@/hooks/use-debounced-url-text"
import { useIsMobile, useIsSplitCapable } from "@/hooks/use-mobile"
import { useResizeDrag } from "@/hooks/use-resize-drag"
import { toOutcomeItems } from "@/lib/agent-outcomes/items"
import { OutcomesDetail } from "./outcomes-detail"
import { OutcomesFilters } from "./outcomes-filters"
import { OutcomesList } from "./outcomes-list"
import { DEFAULT_OUTCOMES_STATE, useOutcomesUrlState } from "./use-outcomes-url-state"

const DEFAULT_DETAIL_WIDTH = 400
const MIN_DETAIL_WIDTH = 300
const MIN_LIST_WIDTH = 320
const QUERY_DEBOUNCE_MS = 200

interface OutcomesShellProps {
  workspaceId: string
  /**
   * "modal" hides the page chrome and shows a close button that strips the URL
   * marker. "page" omits it — the host page owns its own navigation chrome and
   * the surface never closes.
   */
  mode: "modal" | "page"
  enabled: boolean
}

export function OutcomesShell({ workspaceId, mode, enabled }: OutcomesShellProps) {
  const { filters, close, update } = useOutcomesUrlState()
  const isMobile = useIsMobile()
  // MIN_LIST_WIDTH + MIN_DETAIL_WIDTH is 620px before the docked sidebar, so
  // the split needs SPLIT_VIEW_BREAKPOINT, not the phone breakpoint.
  const isSplitCapable = useIsSplitCapable()

  const query = useAgentOutcomes(
    workspaceId,
    {
      streamIds: filters.streamIds,
      state: filters.state,
      ...(filters.kind ? { kind: filters.kind } : {}),
      ...(filters.queryText.trim() ? { queryText: filters.queryText.trim() } : {}),
    },
    { enabled }
  )

  const items = useMemo(
    () => toOutcomeItems(workspaceId, query.data?.pages.flatMap((page) => page.items) ?? []),
    [workspaceId, query.data]
  )

  const { draft: queryDraft, setDraft: handleQueryChange } = useDebouncedUrlText({
    value: filters.queryText,
    onCommit: useCallback((next: string) => update({ queryText: next }), [update]),
    delayMs: QUERY_DEBOUNCE_MS,
  })

  const selectedItem = useMemo(() => {
    if (!filters.selectedOutcomeId) return null
    return items.find((item) => item.id === filters.selectedOutcomeId) ?? null
  }, [filters.selectedOutcomeId, items])

  const hasFilters =
    filters.streamIds.length > 0 ||
    filters.kind !== null ||
    filters.state !== DEFAULT_OUTCOMES_STATE ||
    filters.queryText.trim().length > 0

  const clearFilters = () => update({ streamIds: [], kind: null, state: "all", queryText: "" })
  const widenScope = () => update({ streamIds: [] })

  const showDetailOnly = !isSplitCapable && Boolean(selectedItem)

  const splitContainerRef = useRef<HTMLDivElement | null>(null)
  const [detailWidth, setDetailWidth] = useState(DEFAULT_DETAIL_WIDTH)

  const handleDetailWidthChange = useCallback((next: number) => {
    const containerWidth = splitContainerRef.current?.offsetWidth ?? 0
    const max = Math.max(MIN_DETAIL_WIDTH, containerWidth - MIN_LIST_WIDTH)
    setDetailWidth(Math.max(MIN_DETAIL_WIDTH, Math.min(max, next)))
  }, [])

  const { isResizing, handleResizeStart, handleResizeMove, handleResizeEnd } = useResizeDrag({
    width: detailWidth,
    onWidthChange: handleDetailWidthChange,
    direction: "left",
  })

  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 50 : 10
      if (e.key === "ArrowLeft") {
        e.preventDefault()
        handleDetailWidthChange(detailWidth + step)
      } else if (e.key === "ArrowRight") {
        e.preventDefault()
        handleDetailWidthChange(detailWidth - step)
      }
    },
    [detailWidth, handleDetailWidthChange]
  )

  const maxDetailWidth = Math.max(MIN_DETAIL_WIDTH, (splitContainerRef.current?.offsetWidth ?? 0) - MIN_LIST_WIDTH)

  return (
    <div className="flex h-full min-w-0 flex-col" data-testid="outcomes-shell">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        {showDetailOnly ? (
          <Button
            size="icon"
            variant="ghost"
            onClick={() => window.history.back()}
            aria-label="Back to the agenda list"
            className="h-7 w-7"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        ) : (
          <Search className="h-4 w-4 flex-none text-muted-foreground" aria-hidden />
        )}
        <Input
          autoFocus={mode === "modal" && !isMobile}
          value={queryDraft}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder="Search follow-ups and delegated tasks"
          className="h-8 border-none px-1 shadow-none focus-visible:ring-0"
          aria-label="Search the agenda"
        />
        {mode === "modal" ? (
          <Button size="icon" variant="ghost" onClick={close} aria-label="Close" className="h-7 w-7">
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      {showDetailOnly ? null : <OutcomesFilters workspaceId={workspaceId} filters={filters} onUpdate={update} />}

      <div ref={splitContainerRef} className="flex min-w-0 flex-1 overflow-hidden border-t">
        <div className={showDetailOnly ? "hidden" : "flex w-full min-w-0 flex-1 flex-col overflow-y-auto"}>
          <OutcomesList
            workspaceId={workspaceId}
            items={items}
            filters={filters}
            hasFilters={hasFilters}
            isLoading={query.isLoading}
            isError={query.isError}
            hasNextPage={query.hasNextPage}
            isFetchingNextPage={query.isFetchingNextPage}
            fetchNextPage={query.fetchNextPage}
            selectedId={filters.selectedOutcomeId}
            onSelect={(id) =>
              update(
                { selectedOutcomeId: id },
                // Below the split breakpoint the detail replaces the list, so push history and
                // hardware Back returns to the list instead of leaving the page.
                { history: isSplitCapable ? "replace" : "push" }
              )
            }
            onClearFilters={clearFilters}
            onWidenScope={widenScope}
          />
        </div>
        {!showDetailOnly && isSplitCapable && (
          <PanelResizeHandle
            isResizing={isResizing}
            panelWidth={detailWidth}
            minWidth={MIN_DETAIL_WIDTH}
            maxWidth={maxDetailWidth}
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerEnd={handleResizeEnd}
            onKeyDown={handleResizeKeyDown}
            ariaLabel="Resize detail pane"
          />
        )}
        <div
          className={showDetailOnly ? "w-full min-w-0 flex-1" : "hidden min-w-0 flex-shrink-0 lg:block"}
          style={!showDetailOnly && isSplitCapable ? { width: detailWidth } : undefined}
          data-testid="outcomes-detail-pane"
        >
          <OutcomesDetail workspaceId={workspaceId} item={selectedItem} />
        </div>
      </div>
    </div>
  )
}
