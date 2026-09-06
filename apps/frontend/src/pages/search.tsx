import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { SearchResultItem } from "@/api"
import { ArrowLeft, Brain, Search as SearchIcon } from "lucide-react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { SidebarToggle } from "@/components/layout"
import { StreamLoadingIndicator } from "@/components/loading"
import { RichInput, SEARCH_FILTER_TRIGGERS } from "@/components/quick-switcher/rich-input"
import { useSearchPanel } from "@/components/search/search-panel-context"
import { useMessageSearch, SEARCH_DEBOUNCE_MS } from "@/components/search/use-message-search"
import { extractSearchTerms } from "@/components/search/highlight"
import { SearchFilterChips } from "@/components/search/search-filter-chips"
import { SearchRefineChips } from "@/components/search/search-refine-chips"
import { SearchRefineStatus } from "@/components/search/search-refine-status"
import { SearchRefineRow } from "@/components/search/search-refine-row"
import { SearchRefineTrigger } from "@/components/search/search-refine-trigger"
import { useRefineControl } from "@/components/search/use-refine-control"
import { SearchFilterMenu } from "@/components/search/search-filter-menu"
import { SearchResults } from "@/components/search/search-results"
import { SearchClusterList, countClusterResults } from "@/components/search/search-cluster-list"
import { SearchResultDisplayToggle } from "@/components/search/search-result-display-toggle"
import { useStoredSearchResultDisplayMode } from "@/lib/search-result-display-mode"
import { boundRefines } from "@/lib/search-query-parser"
import { useFeatureFlag } from "@/hooks/use-feature-flags"
import { useInputMode } from "@/hooks/use-input-mode"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

/**
 * Full-page message search — the mobile-native search surface (mirrors the
 * memory/file explorer layout: list with the search input pinned on top).
 * The query (`?q=`) and committed refines (repeated `?refine=`) live in the URL
 * so refresh, back/forward, and shared links land on the same results (INV-59).
 */
export function SearchPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const { activeResultId, setActiveResultId } = useSearchPanel()
  // Suppress autofocus only when a finger is the active input, so a virtual
  // keyboard doesn't spring up on open; a mouse (even on a touchscreen laptop)
  // still autofocuses the search input.
  const autoFocusSearch = useInputMode() !== "touch"
  // Phone widths fold each conversation's hits behind a count so the list fits on screen.
  const isMobile = useIsMobile()

  // Local state for typing; URL is written behind a debounce for bookmarkability.
  const [localQuery, setLocalQuery] = useState(() => searchParams.get("q") ?? "")
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null)
  const refinesKey = searchParams.getAll("refine").join("\u0000")
  const refines = useMemo(() => boundRefines(refinesKey ? refinesKey.split("\u0000") : []), [refinesKey])

  function handleQueryChange(value: string) {
    setLocalQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      startTransition(() => {
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev)
            if (value) {
              next.set("q", value)
            } else {
              next.delete("q")
            }
            return next
          },
          { replace: true }
        )
      })
    }, SEARCH_DEBOUNCE_MS)
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  function setRefines(next: string[]) {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        params.delete("refine")
        for (const refine of next) params.append("refine", refine)
        return params
      },
      { replace: true }
    )
  }

  const {
    results,
    clusters,
    memos,
    isLoading,
    error,
    validationError,
    parsedFilters,
    searchText,
    hasQuery,
    refineNote,
    refineFailed,
    retryRefine,
    exploreHref,
    recordResultClick,
  } = useMessageSearch(workspaceId ?? "", localQuery, refines)
  const displayError = validationError ?? (error ? "Search failed. Try again." : null)
  const refineEnabled = useFeatureFlag(workspaceId ?? "", "search") === "on"
  const refineControl = useRefineControl({ refines, onChange: setRefines })
  const canRefine = refineEnabled && hasQuery
  const terms = useMemo(() => extractSearchTerms(searchText), [searchText])
  const [displayMode, setDisplayMode] = useStoredSearchResultDisplayMode(workspaceId ?? "")
  const resultCount = displayMode === "ranked" ? results.length : countClusterResults(clusters)
  const hasResults = displayMode === "ranked" ? results.length > 0 : clusters.length > 0

  const handleResultSelect = useCallback(
    (result: SearchResultItem) => {
      setActiveResultId(result.id)
      recordResultClick({ kind: "message", id: result.id })
    },
    [setActiveResultId, recordResultClick]
  )

  if (!workspaceId) {
    return null
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-x-hidden bg-background">
      <header className="relative border-b bg-card/50">
        <div className="flex h-12 items-center gap-2 px-4">
          <SidebarToggle location="page" />
          <Link to={`/w/${workspaceId}`} aria-label="Back to workspace">
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>

          <div className="min-w-0 flex-1">
            <div className="flex max-w-xl items-center gap-2 rounded-md border border-border/50 bg-background/80 px-3 transition-all focus-within:border-primary/40">
              <SearchIcon className="h-4 w-4 shrink-0 text-muted-foreground/50" />
              <RichInput
                value={localQuery}
                onChange={handleQueryChange}
                triggers={SEARCH_FILTER_TRIGGERS}
                placeholder="Search messages..."
                ariaLabel="Search messages"
                editorClassName="h-auto min-h-8 py-1.5"
                autoFocus={autoFocusSearch}
              />
            </div>
          </div>

          <span className="hidden shrink-0 text-[11px] tabular-nums text-muted-foreground/50 sm:inline">
            {hasQuery && (hasResults || !isLoading) ? `${resultCount} result${resultCount === 1 ? "" : "s"}` : ""}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-t border-border/40 px-4 py-2">
          <SearchFilterChips query={localQuery} parsedFilters={parsedFilters} onQueryChange={handleQueryChange} />
          <SearchRefineChips
            refines={refines}
            onRemove={(index) => setRefines(refines.filter((_, i) => i !== index))}
            onEdit={canRefine ? refineControl.edit : undefined}
            pending={isLoading && refines.length > 0}
            failed={refineFailed}
          />
          <SearchFilterMenu
            workspaceId={workspaceId}
            query={localQuery}
            onQueryChange={handleQueryChange}
            className="h-7"
          />
          {canRefine && (
            <SearchRefineTrigger
              ref={refineControl.triggerRef}
              open={refineControl.isOpen}
              onToggle={refineControl.toggle}
              className="h-7"
            />
          )}
          {hasQuery && !displayError && (
            <div className="ml-auto flex items-center gap-1">
              {searchText.trim().length > 0 && (
                <Button variant="ghost" size="sm" className="h-9" asChild>
                  <Link to={exploreHref}>
                    <Brain className="h-3.5 w-3.5" />
                    Search memory
                  </Link>
                </Button>
              )}
              <SearchResultDisplayToggle value={displayMode} onChange={setDisplayMode} size="touch" />
            </div>
          )}
          {!isLoading && (
            <SearchRefineStatus note={refineNote} failed={refineFailed} onRetry={retryRefine} size="touch" />
          )}
        </div>

        {canRefine && refineControl.isOpen && (
          <div className="px-4 pb-2">
            <SearchRefineRow
              key={refineControl.editingIndex ?? "new"}
              initialValue={refineControl.initialValue}
              onCommit={refineControl.commit}
              onClose={refineControl.close}
              size="touch"
            />
          </div>
        )}
        <StreamLoadingIndicator isLoading={isLoading} />
      </header>

      <ScrollArea className="min-h-0 flex-1 [&>div>div]:!block [&>div>div]:!w-full">
        <div
          className={cn(
            "mx-auto w-full max-w-3xl p-2 transition-opacity [overflow-wrap:anywhere]",
            isLoading && hasResults && "opacity-60 delay-150"
          )}
        >
          {!hasQuery && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="mb-3 rounded-full bg-muted/50 p-3">
                <SearchIcon className="h-5 w-5 text-muted-foreground/40" />
              </div>
              <p className="text-sm font-medium text-muted-foreground/70">Search every message in this workspace</p>
              <p className="mt-1 max-w-[18rem] text-xs text-muted-foreground/50">
                Narrow results with <code className="rounded bg-muted px-1">from:@user</code>,{" "}
                <code className="rounded bg-muted px-1">in:#channel</code> or{" "}
                <code className="rounded bg-muted px-1">before:2026-01-01</code>
              </p>
            </div>
          )}

          {hasQuery && isLoading && !hasResults && (
            <div className="flex flex-col gap-2 py-1">
              <Skeleton className="h-14 rounded-md" />
              <Skeleton className="h-14 rounded-md" />
              <Skeleton className="h-14 rounded-md" />
              <Skeleton className="h-14 rounded-md" />
            </div>
          )}

          {displayError && <p className="py-8 text-center text-sm text-destructive">{displayError}</p>}

          {hasQuery && !displayError && hasResults && displayMode === "clusters" && (
            <SearchClusterList
              workspaceId={workspaceId}
              clusters={clusters}
              memos={memos}
              terms={terms}
              activeResultId={activeResultId}
              exploreHref={exploreHref}
              foldHits={isMobile}
              onResultSelect={handleResultSelect}
              onConversationSelect={(id) => recordResultClick({ kind: "conversation", id })}
              onMemoSelect={(id) => recordResultClick({ kind: "memo", id })}
            />
          )}

          {hasQuery && !displayError && hasResults && displayMode === "ranked" && (
            <SearchResults
              workspaceId={workspaceId}
              results={results}
              terms={terms}
              activeResultId={activeResultId}
              onResultSelect={handleResultSelect}
            />
          )}

          {hasQuery && !isLoading && !displayError && !hasResults && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <p className="text-sm font-medium text-muted-foreground/70">No results</p>
              <p className="mt-1 text-xs text-muted-foreground/50">Try different words or remove a filter</p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
