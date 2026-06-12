import { startTransition, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Search as SearchIcon } from "lucide-react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { SidebarToggle } from "@/components/layout"
import { RichInput, SEARCH_TRIGGERS } from "@/components/quick-switcher/rich-input"
import { useSearchPanel } from "@/components/search/search-panel-context"
import { useMessageSearch, SEARCH_DEBOUNCE_MS } from "@/components/search/use-message-search"
import { extractSearchTerms } from "@/components/search/highlight"
import { SearchFilterChips } from "@/components/search/search-filter-chips"
import { SearchResults } from "@/components/search/search-results"
import { useIsMobile } from "@/hooks/use-mobile"

/**
 * Full-page message search — the mobile-native search surface (mirrors the
 * memory/file explorer layout: list with the search input pinned on top).
 * The query lives in the URL (`?q=`) so refresh, back/forward, and shared
 * links land on the same results (INV-59).
 */
export function SearchPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const { activeResultId, setActiveResultId } = useSearchPanel()
  const isMobile = useIsMobile()

  // Local state for typing; URL is written behind a debounce for bookmarkability.
  const [localQuery, setLocalQuery] = useState(() => searchParams.get("q") ?? "")
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null)

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

  const { results, isLoading, error, parsedFilters, searchText, hasQuery } = useMessageSearch(
    workspaceId ?? "",
    localQuery
  )
  const terms = useMemo(() => extractSearchTerms(searchText), [searchText])

  if (!workspaceId) {
    return null
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-x-hidden bg-background">
      <header className="border-b bg-card/50">
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
                triggers={SEARCH_TRIGGERS}
                placeholder="Search messages..."
                ariaLabel="Search messages"
                editorClassName="h-8 py-1.5"
                autoFocus={!isMobile}
              />
            </div>
          </div>

          <span className="hidden shrink-0 text-[11px] tabular-nums text-muted-foreground/50 sm:inline">
            {hasQuery && !isLoading ? `${results.length} result${results.length === 1 ? "" : "s"}` : ""}
          </span>
        </div>

        {parsedFilters.length > 0 && (
          <div className="border-t border-border/40 px-4 py-2">
            <SearchFilterChips query={localQuery} parsedFilters={parsedFilters} onQueryChange={handleQueryChange} />
          </div>
        )}
      </header>

      <ScrollArea className="min-h-0 flex-1 [&>div>div]:!block [&>div>div]:!w-full">
        <div className="mx-auto w-full max-w-3xl p-2 [overflow-wrap:anywhere]">
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

          {hasQuery && isLoading && results.length === 0 && (
            <div className="flex flex-col gap-2 py-1">
              <Skeleton className="h-14 rounded-md" />
              <Skeleton className="h-14 rounded-md" />
              <Skeleton className="h-14 rounded-md" />
              <Skeleton className="h-14 rounded-md" />
            </div>
          )}

          {error && <p className="py-8 text-center text-sm text-destructive">Search failed. Try again.</p>}

          {hasQuery && !error && results.length > 0 && (
            <SearchResults
              workspaceId={workspaceId}
              results={results}
              terms={terms}
              activeResultId={activeResultId}
              onResultSelect={(result) => setActiveResultId(result.id)}
            />
          )}

          {hasQuery && !isLoading && !error && results.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <p className="text-sm font-medium text-muted-foreground/70">No messages found</p>
              <p className="mt-1 text-xs text-muted-foreground/50">Try different words or remove a filter</p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
