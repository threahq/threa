import { useCallback, useEffect, useMemo, useRef } from "react"
import { useNavigate } from "react-router-dom"
import { ArrowLeft, Brain, Search as SearchIcon } from "lucide-react"
import { Link } from "react-router-dom"
import { SidebarShell } from "@/components/layout/sidebar/sidebar-shell"
import { StreamLoadingIndicator } from "@/components/loading"
import {
  RichInput,
  SEARCH_FILTER_TRIGGERS,
  SEARCH_TRIGGERS,
  type RichInputRef,
} from "@/components/quick-switcher/rich-input"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { usePreferences } from "@/contexts"
import { formatKeyBinding, getEffectiveKeyBinding } from "@/lib/keyboard-shortcuts"
import type { SearchResultItem } from "@/api"
import { useSearchPanel } from "./search-panel-context"
import { useMessageSearch } from "./use-message-search"
import { extractSearchTerms } from "./highlight"
import { SearchFilterChips } from "./search-filter-chips"
import { SearchRefineChips } from "./search-refine-chips"
import { SearchFilterMenu } from "./search-filter-menu"
import { SearchResults } from "./search-results"
import { SearchClusterList, countClusterResults } from "./search-cluster-list"
import { SearchResultDisplayToggle } from "./search-result-display-toggle"
import { useStoredSearchResultDisplayMode } from "@/lib/search-result-display-mode"
import { boundRefines, removeRefineFromQuery } from "@/lib/search-query-parser"
import { useFeatureFlag } from "@/hooks/use-feature-flags"
import { cn } from "@/lib/utils"

/**
 * Desktop sidebar in search mode — VS Code-style: the stream list swaps for a
 * search input plus grouped results, and the main view stays put so opening a
 * result previews it (stream focused on the matched message) while the result
 * list keeps the selection.
 */
export function SidebarSearchPanel({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate()
  const { query, setQuery, refines, setRefines, activeResultId, setActiveResultId, closeSearch, registerFocusHandler } =
    useSearchPanel()
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
    pendingRefine,
    refineNote,
    refineFailed,
    retryRefine,
    exploreHref,
    recordResultClick,
  } = useMessageSearch(workspaceId, query, refines)
  const displayError = validationError ?? (error ? "Search failed. Try again." : null)
  const refineEnabled = useFeatureFlag(workspaceId, "search") === "on"
  const { preferences } = usePreferences()
  const [displayMode, setDisplayMode] = useStoredSearchResultDisplayMode(workspaceId)
  // Keyboard navigation walks the rows in the order they are on screen.
  const navigableResults = useMemo(
    () => (displayMode === "ranked" ? results : clusters.flatMap((cluster) => cluster.hits)),
    [displayMode, results, clusters]
  )
  const resultCount = displayMode === "ranked" ? results.length : countClusterResults(clusters)
  const hasResults = displayMode === "ranked" ? results.length > 0 : clusters.length > 0

  const inputRef = useRef<RichInputRef>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const isPopoverActiveRef = useRef(false)

  // Lets mod+shift+f refocus the input while the panel is already open.
  useEffect(() => {
    registerFocusHandler(() => inputRef.current?.focus())
    return () => registerFocusHandler(null)
  }, [registerFocusHandler])

  const terms = useMemo(() => extractSearchTerms(searchText), [searchText])
  const streamCount = useMemo(() => new Set(clusters.map((cluster) => cluster.streamId)).size, [clusters])
  const emptySummary = isLoading ? "Searching…" : "No results"
  const resultSummary = hasResults
    ? `${resultCount} result${resultCount === 1 ? "" : "s"} in ${streamCount} stream${streamCount === 1 ? "" : "s"}`
    : emptySummary
  const searchBinding = getEffectiveKeyBinding("openSearch", preferences?.keyboardShortcuts ?? {})

  const handleResultSelect = useCallback(
    (result: SearchResultItem) => {
      setActiveResultId(result.id)
      recordResultClick({ kind: "message", id: result.id })
    },
    [setActiveResultId, recordResultClick]
  )

  const scrollResultIntoView = (resultId: string) => {
    requestAnimationFrame(() => {
      resultsRef.current
        ?.querySelector(`[data-search-result-id="${CSS.escape(resultId)}"]`)
        ?.scrollIntoView({ block: "nearest" })
    })
  }

  const moveActive = (delta: 1 | -1) => {
    if (navigableResults.length === 0) return
    const currentIndex = navigableResults.findIndex((r) => r.id === activeResultId)
    let nextIndex: number
    if (currentIndex === -1) {
      // No active row yet: ArrowDown starts at the top, ArrowUp at the bottom
      nextIndex = delta === 1 ? 0 : navigableResults.length - 1
    } else {
      nextIndex = Math.min(navigableResults.length - 1, Math.max(0, currentIndex + delta))
    }
    const next = navigableResults[nextIndex]
    setActiveResultId(next.id)
    scrollResultIntoView(next.id)
  }

  const openActiveResult = (withModifier: boolean) => {
    const active = navigableResults.find((r) => r.id === activeResultId) ?? navigableResults[0]
    if (!active) return
    handleResultSelect(active)
    const href = `/w/${workspaceId}/s/${active.streamId}?m=${active.id}`
    if (withModifier) {
      window.open(href, "_blank")
    } else {
      navigate(href)
    }
  }

  // Enter commits `/refine …` prose as a chip (an over-long one stays in the
  // field with the validation error); the newest refine displaces the oldest
  // past the backend's limit. Without pending prose it opens a result.
  const handleSubmit = (withModifier: boolean) => {
    const prose = pendingRefine?.trim()
    if (!prose) {
      openActiveResult(withModifier)
      return
    }
    if (validationError) return
    setRefines(boundRefines([...refines, prose]))
    setQuery(removeRefineFromQuery(query))
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    // While a suggestion popover is open, TipTap owns the keyboard
    if (event.defaultPrevented || isPopoverActiveRef.current) return

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault()
        moveActive(1)
        break
      case "ArrowUp":
        event.preventDefault()
        moveActive(-1)
        break
      case "Escape":
        event.preventDefault()
        closeSearch()
        break
    }
  }

  return (
    <SidebarShell
      header={
        <div className="relative flex-shrink-0 border-b" onKeyDown={handleKeyDown}>
          <div className="flex h-12 items-center gap-1 px-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-muted-foreground"
                  onClick={closeSearch}
                  aria-label="Back to streams"
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Back to streams (esc)</TooltipContent>
            </Tooltip>
            <span className="text-sm font-semibold">Search</span>
            {searchBinding && (
              <kbd className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {formatKeyBinding(searchBinding)}
              </kbd>
            )}
          </div>

          <div className="px-3 pb-2">
            <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 transition-all focus-within:border-primary/60 focus-within:shadow-[0_0_0_2px_hsl(var(--primary)/0.06)]">
              <SearchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
              <RichInput
                ref={inputRef}
                value={query}
                onChange={setQuery}
                onSubmit={handleSubmit}
                onPopoverActiveChange={(active) => {
                  isPopoverActiveRef.current = active
                }}
                triggers={refineEnabled ? SEARCH_TRIGGERS : SEARCH_FILTER_TRIGGERS}
                placeholder="Search messages..."
                ariaLabel="Search messages"
                editorClassName="h-auto min-h-8 py-1.5 text-[13px]"
                autoFocus
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
            <SearchFilterChips query={query} parsedFilters={parsedFilters} onQueryChange={setQuery} />
            <SearchRefineChips
              refines={refines}
              onRemove={(index) => setRefines(refines.filter((_, i) => i !== index))}
              pending={isLoading && refines.length > 0}
              failed={refineFailed}
            />
            <SearchFilterMenu workspaceId={workspaceId} query={query} onQueryChange={setQuery} />
          </div>

          {hasQuery && !displayError && (
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 px-3 pb-2">
              <p className="min-w-0 truncate text-[11px] tabular-nums text-muted-foreground">{resultSummary}</p>
              <div className="flex items-center gap-1">
                {searchText.trim().length > 0 && (
                  <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" asChild>
                    <Link to={exploreHref}>
                      <Brain className="h-3.5 w-3.5" />
                      Search memory
                    </Link>
                  </Button>
                )}
                <SearchResultDisplayToggle value={displayMode} onChange={setDisplayMode} />
              </div>
              {refineNote && !isLoading && (
                <p className="w-full text-[11px] leading-snug text-muted-foreground" data-search-refine-note>
                  {refineNote}
                </p>
              )}
              {refineFailed && !isLoading && (
                <p
                  className="flex w-full flex-wrap items-center gap-x-1 text-[11px] leading-snug text-destructive"
                  data-search-refine-failed
                >
                  Couldn&apos;t apply the refinement after two tries. Showing all results.
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1.5 text-[11px] text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={retryRefine}
                  >
                    Retry
                  </Button>
                </p>
              )}
            </div>
          )}
          <StreamLoadingIndicator isLoading={isLoading} />
        </div>
      }
      body={
        <div
          ref={resultsRef}
          onKeyDown={handleKeyDown}
          className={cn("transition-opacity", isLoading && hasResults && "opacity-60 delay-150")}
        >
          {!hasQuery && (
            <div className="px-2 py-6 text-center">
              <p className="text-xs text-muted-foreground/80">Search every message in this workspace.</p>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/60">
                Narrow results with <code className="rounded bg-muted px-1">from:@user</code>,{" "}
                <code className="rounded bg-muted px-1">in:#channel</code>,{" "}
                <code className="rounded bg-muted px-1">before:2026-01-01</code>
              </p>
              {refineEnabled && (
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground/60">
                  Refine the list in plain words with <code className="rounded bg-muted px-1">/refine</code>
                </p>
              )}
            </div>
          )}

          {hasQuery && isLoading && !hasResults && (
            <div className="flex flex-col gap-1.5 px-1 py-1">
              <Skeleton className="h-12 rounded-md" />
              <Skeleton className="h-12 rounded-md" />
              <Skeleton className="h-12 rounded-md" />
            </div>
          )}

          {displayError && <p className="px-2 py-4 text-center text-xs text-destructive">{displayError}</p>}

          {hasQuery && !displayError && hasResults && displayMode === "clusters" && (
            <div className="px-1 pt-1">
              <SearchClusterList
                workspaceId={workspaceId}
                clusters={clusters}
                memos={memos}
                terms={terms}
                activeResultId={activeResultId}
                exploreHref={exploreHref}
                onResultSelect={handleResultSelect}
                onConversationSelect={(id) => recordResultClick({ kind: "conversation", id })}
                onMemoSelect={(id) => recordResultClick({ kind: "memo", id })}
              />
            </div>
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
            <p className="px-2 py-6 text-center text-[11px] text-muted-foreground/60">
              Try different words or remove a filter
            </p>
          )}
        </div>
      }
      footer={
        <p className="flex items-center justify-center gap-3 text-[10px] text-muted-foreground/70">
          <span>
            <kbd className="kbd-hint">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="kbd-hint">↵</kbd> open
          </span>
          <span>
            <kbd className="kbd-hint">esc</kbd> close
          </span>
        </p>
      }
    />
  )
}
