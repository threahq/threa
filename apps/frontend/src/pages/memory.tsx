import { startTransition, useEffect, useRef, useState } from "react"
import { ArrowLeft, Search, RefreshCw, Hash, MessageSquareQuote, Check, ChevronsUpDown } from "lucide-react"
import { KNOWLEDGE_TYPES, MEMO_TYPES, type KnowledgeType, type MemoType } from "@threa/types"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { useMemoDetail, useMemoSearch } from "@/hooks"
import { useIsMobile } from "@/hooks/use-mobile"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Drawer, DrawerContent } from "@/components/ui/drawer"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { RelativeTime } from "@/components/relative-time"
import { SidebarToggle } from "@/components/layout"
import { KnowledgeTypeBadge, MemoDetailContent, formatStreamRef } from "@/components/memo/memo-detail"
import { cn } from "@/lib/utils"
import { streamLabel } from "@/lib/streams"
import { getKnowledgeConfig, memoLabel } from "@/lib/memo-display"
import type { MemoExplorerResult } from "@/api"

const ALL_MEMO_TYPES = "all-memo-types"
const ALL_KNOWLEDGE_TYPES = "all-knowledge-types"

function updateParams(
  searchParams: URLSearchParams,
  updates: Record<string, string | null | undefined>
): URLSearchParams {
  const next = new URLSearchParams(searchParams)

  for (const [key, value] of Object.entries(updates)) {
    if (!value) {
      next.delete(key)
    } else {
      next.set(key, value)
    }
  }

  return next
}

function MemoResultItem({ result, isActive, href }: { result: MemoExplorerResult; isActive: boolean; href: string }) {
  const sourceLabel = formatStreamRef(result.sourceStream)
  const rootLabel = formatStreamRef(result.rootStream)
  const config = getKnowledgeConfig(result.memo.knowledgeType)

  return (
    <Link
      to={href}
      className={cn(
        // [overflow-wrap:anywhere] is inherited by descendants and collapses the
        // intrinsic min-content of long unbreakable strings (URLs, hashes) so the
        // Radix ScrollArea's display:table wrapper can't be forced wider than the
        // viewport. `break-words` alone is insufficient — per spec it doesn't
        // affect min-content calculation.
        "group block overflow-hidden rounded-lg border-l-[3px] border border-l-transparent bg-card transition-all [overflow-wrap:anywhere]",
        isActive
          ? cn("border-primary/30 shadow-sm", config.accent)
          : "border-border/50 hover:border-border hover:shadow-sm"
      )}
    >
      <div className="min-w-0 px-3.5 py-3">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <h3 className="min-w-0 flex-1 text-[13px] font-semibold leading-snug text-foreground line-clamp-2">
            {result.memo.title}
          </h3>
          <RelativeTime
            date={result.memo.updatedAt}
            className="mt-0.5 shrink-0 text-[10px] tabular-nums text-muted-foreground/70"
          />
        </div>

        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground line-clamp-2">{result.memo.abstract}</p>

        <div className="mt-2.5 flex min-w-0 items-center gap-2">
          <KnowledgeTypeBadge type={result.memo.knowledgeType} size="xs" />

          {result.memo.tags.length > 0 && (
            <div className="flex min-w-0 items-center gap-1 overflow-hidden">
              {result.memo.tags.slice(0, 2).map((tag) => (
                <span
                  key={tag}
                  className="inline-flex min-w-0 items-center gap-0.5 text-[10px] text-muted-foreground/70"
                >
                  <Hash className="h-2.5 w-2.5 shrink-0" />
                  <span className="truncate">{tag}</span>
                </span>
              ))}
            </div>
          )}
        </div>

        {(sourceLabel || rootLabel) && (
          <div className="mt-2 flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground/60">
            <MessageSquareQuote className="h-2.5 w-2.5 shrink-0" />
            <span className="min-w-0 truncate">
              {sourceLabel}
              {sourceLabel && rootLabel && result.rootStream?.id !== result.sourceStream?.id && (
                <span className="text-muted-foreground/40"> in {rootLabel}</span>
              )}
            </span>
          </div>
        )}
      </div>
    </Link>
  )
}

function LoadingBar({ visible }: { visible: boolean }) {
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (!visible) {
      setShow(false)
      return
    }

    const timer = setTimeout(() => setShow(true), 200)
    return () => clearTimeout(timer)
  }, [visible])

  return (
    <div
      className={cn(
        "absolute top-0 left-0 right-0 z-10 h-[2px] overflow-hidden",
        "transition-opacity duration-200",
        show ? "opacity-100" : "opacity-0"
      )}
      role="progressbar"
      aria-label="Loading"
      aria-hidden={!show}
    >
      <div className="absolute inset-0 bg-border/30" />
      <div
        className="absolute inset-y-0 w-1/3 animate-indeterminate-progress"
        style={{
          background: `linear-gradient(90deg, transparent 0%, hsl(var(--primary) / 0.6) 50%, transparent 100%)`,
        }}
      />
    </div>
  )
}

function StreamCombobox({
  options,
  value,
  onSelect,
  isActive,
}: {
  options: { id: string; label: string }[]
  value: string | null
  onSelect: (streamId: string | null) => void
  isActive: boolean
}) {
  const [open, setOpen] = useState(false)
  const selectedLabel = value ? options.find((o) => o.id === value)?.label : null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          role="combobox"
          aria-expanded={open}
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs transition-colors",
            "border-border/50 bg-background/60 hover:bg-accent/50",
            isActive && "border-primary/40 bg-primary/5"
          )}
        >
          <span className="truncate max-w-[10rem]">{selectedLabel ?? "All streams"}</span>
          <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[14rem] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search streams..." className="h-8 text-xs" />
          <CommandList>
            <CommandEmpty className="py-3 text-center text-xs text-muted-foreground">No streams found</CommandEmpty>
            <CommandGroup>
              <CommandItem
                onSelect={() => {
                  onSelect(null)
                  setOpen(false)
                }}
              >
                <Check className={cn("mr-2 h-3 w-3", !value ? "opacity-100" : "opacity-0")} />
                All streams
              </CommandItem>
              {options.map((option) => (
                <CommandItem
                  key={option.id}
                  value={option.label}
                  onSelect={() => {
                    onSelect(option.id)
                    setOpen(false)
                  }}
                >
                  <Check className={cn("mr-2 h-3 w-3", value === option.id ? "opacity-100" : "opacity-0")} />
                  {option.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function MemoryPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const streams = useWorkspaceStreams(workspaceId ?? "")
  const isMobile = useIsMobile()

  // Local filter state — initialized from URL params once, then app-owned.
  // URL params are written as a debounced side effect for bookmarkability.
  const [localQuery, setLocalQuery] = useState(() => searchParams.get("q") ?? "")
  const [selectedStreamId, setSelectedStreamId] = useState(() => searchParams.get("stream"))
  const [selectedMemoType, setSelectedMemoType] = useState(() => searchParams.get("memoType") as MemoType | null)
  const [selectedKnowledgeType, setSelectedKnowledgeType] = useState(
    () => searchParams.get("knowledgeType") as KnowledgeType | null
  )

  // Debounced query for the API — updates 300ms after the user stops typing
  const [debouncedQuery, setDebouncedQuery] = useState(localQuery)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null)

  function handleQueryChange(value: string) {
    setLocalQuery(value)

    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(value)
      syncToUrl({ q: value || null })
    }, 300)
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  // Write local filter state to URL params (debounced for query, immediate for filters).
  // replace: true avoids polluting history.
  function syncToUrl(updates: Record<string, string | null | undefined>) {
    startTransition(() => {
      setSearchParams((prev) => updateParams(prev, updates), { replace: true })
    })
  }

  function setFilter(updates: {
    stream?: string | null
    memoType?: MemoType | null
    knowledgeType?: KnowledgeType | null
  }) {
    if ("stream" in updates) setSelectedStreamId(updates.stream ?? null)
    if ("memoType" in updates) setSelectedMemoType(updates.memoType ?? null)
    if ("knowledgeType" in updates) setSelectedKnowledgeType(updates.knowledgeType ?? null)
    syncToUrl({
      ...("stream" in updates && { stream: updates.stream }),
      ...("memoType" in updates && { memoType: updates.memoType }),
      ...("knowledgeType" in updates && { knowledgeType: updates.knowledgeType }),
      memo: null,
    })
  }

  function clearFilters() {
    setSelectedStreamId(null)
    setSelectedMemoType(null)
    setSelectedKnowledgeType(null)
    syncToUrl({ stream: null, memoType: null, knowledgeType: null, memo: null })
  }

  const searchResponse = useMemoSearch(workspaceId ?? "", {
    query: debouncedQuery,
    limit: 50,
    filters: {
      in: selectedStreamId ? [selectedStreamId] : undefined,
      memoType: selectedMemoType ? [selectedMemoType] : undefined,
      knowledgeType: selectedKnowledgeType ? [selectedKnowledgeType] : undefined,
    },
  })

  const results = searchResponse.data?.results ?? []
  const memoParam = searchParams.get("memo")

  // On desktop, fall back to the first result so the detail pane isn't empty.
  // On mobile, only show the drawer when the user explicitly taps a memo.
  const selectedMemoId = memoParam ?? (isMobile ? null : (results[0]?.memo.id ?? null))
  const selectedMemo = useMemoDetail(workspaceId ?? "", selectedMemoId)
  const isRefreshing = searchResponse.isFetching || selectedMemo.isFetching

  const streamOptions = streams
    .filter((stream) => !stream.archivedAt)
    .map((stream) => ({
      id: stream.id,
      label: streamLabel(stream),
    }))
    .sort((a, b) => a.label.localeCompare(b.label))

  function refresh() {
    manualRefresh.current = true
    void Promise.allSettled([searchResponse.refetch(), selectedMemoId ? selectedMemo.refetch() : Promise.resolve()])
  }

  const selectedMemoData = selectedMemo.data?.memo ?? null
  const hasActiveFilters = selectedStreamId || selectedMemoType || selectedKnowledgeType

  // Brief confirmation flash when a manual refresh completes
  const [refreshConfirmed, setRefreshConfirmed] = useState(false)
  const manualRefresh = useRef(false)
  useEffect(() => {
    if (!isRefreshing && manualRefresh.current) {
      manualRefresh.current = false
      setRefreshConfirmed(true)
      const timer = setTimeout(() => setRefreshConfirmed(false), 800)
      return () => clearTimeout(timer)
    }
  }, [isRefreshing])

  if (!workspaceId) {
    return null
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-x-hidden bg-background">
      {/* Header */}
      <header className="border-b bg-card/50">
        <div className="flex h-12 items-center gap-2 px-4">
          <SidebarToggle location="page" />
          <Link to={`/w/${workspaceId}`}>
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>

          <div className="flex-1 min-w-0">
            <div className="relative max-w-xl">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                value={localQuery}
                onChange={(event) => handleQueryChange(event.target.value)}
                placeholder="Search workspace memory..."
                className="h-8 pl-9 bg-background/80 border-border/50 focus-visible:border-primary/40"
              />
            </div>
          </div>

          <span className="hidden sm:inline shrink-0 text-[11px] tabular-nums text-muted-foreground/50">
            {searchResponse.isLoading ? "\u2026" : `${results.length} memo${results.length !== 1 ? "s" : ""}`}
          </span>

          <Button
            variant="ghost"
            size="icon"
            onClick={refresh}
            disabled={isRefreshing}
            className={cn(
              "h-8 w-8 shrink-0 transition-colors",
              refreshConfirmed ? "text-emerald-500" : "text-muted-foreground"
            )}
          >
            {refreshConfirmed ? <Check className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
            <span className="sr-only">Refresh</span>
          </Button>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-2 overflow-x-auto border-t border-border/40 px-4 py-2 scrollbar-none">
          <span className="text-[11px] font-medium text-muted-foreground/50 uppercase tracking-wide mr-1 shrink-0">
            Filters
          </span>

          <StreamCombobox
            options={streamOptions}
            value={selectedStreamId}
            onSelect={(id) => setFilter({ stream: id })}
            isActive={!!selectedStreamId}
          />

          <Select
            value={selectedMemoType ?? ALL_MEMO_TYPES}
            onValueChange={(value) =>
              setFilter({ memoType: (value === ALL_MEMO_TYPES ? null : value) as MemoType | null })
            }
          >
            <SelectTrigger
              className={cn(
                "h-7 w-auto gap-1.5 rounded-md border-border/50 bg-background/60 px-2.5 text-xs",
                selectedMemoType && "border-primary/40 bg-primary/5"
              )}
            >
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_MEMO_TYPES}>All types</SelectItem>
              {MEMO_TYPES.map((memoType) => (
                <SelectItem key={memoType} value={memoType}>
                  {memoLabel(memoType)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={selectedKnowledgeType ?? ALL_KNOWLEDGE_TYPES}
            onValueChange={(value) =>
              setFilter({ knowledgeType: (value === ALL_KNOWLEDGE_TYPES ? null : value) as KnowledgeType | null })
            }
          >
            <SelectTrigger
              className={cn(
                "h-7 w-auto gap-1.5 rounded-md border-border/50 bg-background/60 px-2.5 text-xs",
                selectedKnowledgeType && "border-primary/40 bg-primary/5"
              )}
            >
              <SelectValue placeholder="All knowledge" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_KNOWLEDGE_TYPES}>All knowledge</SelectItem>
              {KNOWLEDGE_TYPES.map((knowledgeType) => (
                <SelectItem key={knowledgeType} value={knowledgeType}>
                  {memoLabel(knowledgeType)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              className="h-7 shrink-0 px-2 text-[11px] text-muted-foreground"
            >
              Clear filters
            </Button>
          )}
        </div>
      </header>

      {/* Content — relative wrapper for the loading bar overlay */}
      <div className="relative flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Delayed loading bar — covers the header/content divider */}
        <LoadingBar visible={isRefreshing} />
        {/* Results list — full width on mobile, fixed sidebar on desktop.
            `[&>div>div]:!block [&>div>div]:!w-full` overrides Radix ScrollArea's
            internal `display:table` wrapper so the cards can't be pushed past
            the column by descendant min-content (matches saved/activity/scheduled). */}
        <ScrollArea className="min-w-0 flex-1 lg:w-[22rem] lg:flex-none lg:border-r border-border/50 [&>div>div]:!block [&>div>div]:!w-full">
          <div className="min-w-0 space-y-1.5 p-2 [overflow-wrap:anywhere]">
            {searchResponse.isLoading && (
              <>
                <Skeleton className="h-24 rounded-lg" />
                <Skeleton className="h-24 rounded-lg" />
                <Skeleton className="h-24 rounded-lg" />
                <Skeleton className="h-24 rounded-lg" />
              </>
            )}

            {!searchResponse.isLoading && results.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="rounded-full bg-muted/50 p-3 mb-3">
                  <Search className="h-5 w-5 text-muted-foreground/40" />
                </div>
                <p className="text-sm font-medium text-muted-foreground/70">No memos found</p>
                <p className="mt-1 text-xs text-muted-foreground/50 max-w-[14rem]">
                  {localQuery
                    ? "Try adjusting your search or filters"
                    : "Memos will appear here as knowledge is extracted from conversations"}
                </p>
              </div>
            )}

            {results.map((result) => {
              const href = `/w/${workspaceId}/memory?${updateParams(searchParams, { memo: result.memo.id }).toString()}`
              return (
                <MemoResultItem
                  key={result.memo.id}
                  result={result}
                  isActive={result.memo.id === selectedMemoId}
                  href={href}
                />
              )
            })}
          </div>
        </ScrollArea>

        {/* Desktop detail pane. Uses `flex-1 min-h-0 overflow-y-auto` on a
            plain div rather than Radix ScrollArea: between the mobile
            breakpoint (640px) and `lg:flex-row` (1024px) the parent is a
            flex-col with TWO flex-1 siblings (list + detail), and Radix
            ScrollArea's `h-full` Viewport height chain is brittle when
            sharing vertical space — the Root relies on `overflow-hidden`
            implying min-height:0 on flex items, which some flex-col +
            sibling-ScrollArea combinations don't resolve reliably. Native
            `overflow-y-auto` + explicit `min-h-0` is unambiguous. */}
        {!isMobile && (
          <div className="min-w-0 flex-1 min-h-0 overflow-y-auto">
            <main className="mx-auto min-w-0 max-w-3xl p-5 sm:p-8">
              <MemoDetailContent data={selectedMemoData} workspaceId={workspaceId} isLoading={selectedMemo.isLoading} />
            </main>
          </div>
        )}
      </div>

      {/* Mobile detail drawer */}
      {isMobile && (
        <Drawer
          open={!!selectedMemoId}
          onOpenChange={(open) => {
            if (!open) syncToUrl({ memo: null })
          }}
        >
          <DrawerContent className="max-h-[85dvh]">
            {/*
              Scrollable content inside a Vaul drawer needs an explicit flex
              scroll container: DrawerContent is a flex-col with max-h, so the
              child must `flex-1 min-h-0 overflow-y-auto` to claim remaining
              height and actually scroll. `data-vaul-no-drag` stops Vaul from
              intercepting touch-drags as close gestures once the user is
              inside the scrollable body. Radix ScrollArea doesn't fit here
              because its Root has fixed overflow:hidden and no intrinsic
              flex sizing — a plain div is the codebase convention (see
              message-action-drawer.tsx).
            */}
            <div data-vaul-no-drag className="min-w-0 flex-1 min-h-0 overflow-y-auto p-4 pb-8">
              <MemoDetailContent data={selectedMemoData} workspaceId={workspaceId} isLoading={selectedMemo.isLoading} />
            </div>
          </DrawerContent>
        </Drawer>
      )}
    </div>
  )
}
