import { useCallback, useEffect, useMemo, useRef } from "react"
import { useNavigate } from "react-router-dom"
import { ArrowLeft, Loader2, Search as SearchIcon, Sparkles } from "lucide-react"
import { SidebarShell } from "@/components/layout/sidebar/sidebar-shell"
import { RichInput, SEARCH_TRIGGERS, type RichInputRef } from "@/components/quick-switcher/rich-input"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { usePreferences } from "@/contexts"
import { formatKeyBinding, getEffectiveKeyBinding } from "@/lib/keyboard-shortcuts"
import type { SearchResultItem } from "@/api"
import { useSearchPanel } from "./search-panel-context"
import { useMessageSearch } from "./use-message-search"
import { useMemoMatches } from "./use-memo-matches"
import { MemoMatches } from "./memo-matches"
import { ConversationMatches } from "./conversation-matches"
import { extractSearchTerms } from "./highlight"
import { SearchFilterChips } from "./search-filter-chips"
import { SearchFilterMenu } from "./search-filter-menu"
import { SearchResults } from "./search-results"
import { SearchResultDisplayToggle } from "./search-result-display-toggle"
import { useStoredSearchResultDisplayMode } from "@/lib/search-result-display-mode"

/**
 * Desktop sidebar in search mode — VS Code-style: the stream list swaps for a
 * search input plus grouped results, and the main view stays put so opening a
 * result previews it (stream focused on the matched message) while the result
 * list keeps the selection.
 */
export function SidebarSearchPanel({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate()
  const { query, setQuery, activeResultId, setActiveResultId, closeSearch, registerFocusHandler } = useSearchPanel()
  const {
    results,
    conversations,
    isLoading,
    error,
    validationError,
    parsedFilters,
    apiFilters,
    searchText,
    hasQuery,
    canSearchDeeper,
    isSearchingDeeper,
    searchDeeper,
  } = useMessageSearch(workspaceId, query)
  const displayError = validationError ?? (error ? "Search failed. Try again." : null)
  const { preferences } = usePreferences()
  const [displayMode, setDisplayMode] = useStoredSearchResultDisplayMode(workspaceId)
  const { memos, exploreHref } = useMemoMatches(workspaceId, {
    searchText,
    parsedFilters,
    apiFilters,
    hasQuery,
  })
  const resultCount = results.length + memos.length
  const hasResults = resultCount > 0

  const inputRef = useRef<RichInputRef>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const isPopoverActiveRef = useRef(false)

  // Lets mod+shift+f refocus the input while the panel is already open.
  useEffect(() => {
    registerFocusHandler(() => inputRef.current?.focus())
    return () => registerFocusHandler(null)
  }, [registerFocusHandler])

  const terms = useMemo(() => extractSearchTerms(searchText), [searchText])
  const streamCount = useMemo(() => new Set(results.map((r) => r.streamId)).size, [results])
  const emptySummary = isLoading ? "Searching…" : "No results"
  const resultSummary = hasResults
    ? `${resultCount} result${resultCount === 1 ? "" : "s"} in ${streamCount} stream${streamCount === 1 ? "" : "s"}`
    : emptySummary
  const searchBinding = getEffectiveKeyBinding("openSearch", preferences?.keyboardShortcuts ?? {})

  const handleResultSelect = useCallback(
    (result: SearchResultItem) => {
      setActiveResultId(result.id)
    },
    [setActiveResultId]
  )

  const scrollResultIntoView = (resultId: string) => {
    requestAnimationFrame(() => {
      resultsRef.current
        ?.querySelector(`[data-search-result-id="${CSS.escape(resultId)}"]`)
        ?.scrollIntoView({ block: "nearest" })
    })
  }

  const moveActive = (delta: 1 | -1) => {
    if (results.length === 0) return
    const currentIndex = results.findIndex((r) => r.id === activeResultId)
    let nextIndex: number
    if (currentIndex === -1) {
      // No active row yet: ArrowDown starts at the top, ArrowUp at the bottom
      nextIndex = delta === 1 ? 0 : results.length - 1
    } else {
      nextIndex = Math.min(results.length - 1, Math.max(0, currentIndex + delta))
    }
    const next = results[nextIndex]
    setActiveResultId(next.id)
    scrollResultIntoView(next.id)
  }

  const openActiveResult = (withModifier: boolean) => {
    const active = results.find((r) => r.id === activeResultId) ?? results[0]
    if (!active) {
      searchDeeper()
      return
    }
    setActiveResultId(active.id)
    const href = `/w/${workspaceId}/s/${active.streamId}?m=${active.id}`
    if (withModifier) {
      window.open(href, "_blank")
    } else {
      navigate(href)
    }
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
        <div className="flex-shrink-0 border-b" onKeyDown={handleKeyDown}>
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
                onSubmit={openActiveResult}
                onPopoverActiveChange={(active) => {
                  isPopoverActiveRef.current = active
                }}
                triggers={SEARCH_TRIGGERS}
                placeholder="Search messages..."
                ariaLabel="Search messages"
                editorClassName="h-auto min-h-8 py-1.5 text-[13px]"
                autoFocus
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
            <SearchFilterChips query={query} parsedFilters={parsedFilters} onQueryChange={setQuery} />
            <SearchFilterMenu workspaceId={workspaceId} query={query} onQueryChange={setQuery} />
          </div>

          {hasQuery && !displayError && (
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 px-3 pb-2">
              <p className="min-w-0 truncate text-[11px] tabular-nums text-muted-foreground">{resultSummary}</p>
              <div className="flex items-center gap-1">
                {canSearchDeeper && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-[11px]"
                    type="button"
                    disabled={isLoading}
                    onClick={searchDeeper}
                  >
                    {isSearchingDeeper ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    Search deeper
                  </Button>
                )}
                <SearchResultDisplayToggle value={displayMode} onChange={setDisplayMode} />
              </div>
            </div>
          )}
        </div>
      }
      body={
        <div ref={resultsRef} onKeyDown={handleKeyDown}>
          {!hasQuery && (
            <div className="px-2 py-6 text-center">
              <p className="text-xs text-muted-foreground/80">Search every message in this workspace.</p>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/60">
                Narrow results with <code className="rounded bg-muted px-1">from:@user</code>,{" "}
                <code className="rounded bg-muted px-1">in:#channel</code>,{" "}
                <code className="rounded bg-muted px-1">before:2026-01-01</code>
              </p>
            </div>
          )}

          {hasQuery && !displayError && (
            <div className="px-1 pt-1">
              <MemoMatches memos={memos} exploreHref={exploreHref} compact />
              <ConversationMatches workspaceId={workspaceId} conversations={conversations} compact />
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

          {hasQuery && !displayError && results.length > 0 && (
            <SearchResults
              workspaceId={workspaceId}
              results={results}
              terms={terms}
              activeResultId={activeResultId}
              onResultSelect={handleResultSelect}
              mode={displayMode}
            />
          )}

          {hasQuery && !isLoading && !displayError && !hasResults && (
            <div className="px-2 py-6 text-center">
              <p className="text-xs font-medium text-muted-foreground/80">No messages found</p>
              <p className="mt-1 text-[11px] text-muted-foreground/60">Try different words or remove a filter</p>
            </div>
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
