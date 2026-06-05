import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Search, Loader2, Film, SearchX, ImageOff } from "lucide-react"
import type { GiphyGif } from "@threa/types"
import { giphyApi } from "@/api"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

// Varied aspect ratios so the loading skeleton mimics a real GIF grid's
// staggered masonry rather than a wall of identical boxes.
const SKELETON_RATIOS = [1.4, 1, 0.8, 1.6, 1, 0.75, 1.3, 1, 0.9, 1.5, 1, 0.85]

/** Centered icon + copy used by the empty and error states. */
function GiphyEmptyState({ icon, title, hint }: { icon: ReactNode; title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-3 rounded-full bg-muted/60 p-3">{icon}</div>
      <p className="text-sm font-medium text-muted-foreground/80">{title}</p>
      <p className="mt-1 max-w-[16rem] text-xs text-muted-foreground/50">{hint}</p>
    </div>
  )
}

interface GiphyPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  /** Called with the chosen GIF. The host downloads its bytes and attaches them. */
  onSelect: (gif: GiphyGif) => void
}

const SEARCH_DEBOUNCE_MS = 350

export function GiphyPickerDialog({ open, onOpenChange, workspaceId, onSelect }: GiphyPickerDialogProps) {
  const [query, setQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [items, setItems] = useState<GiphyGif[]>([])
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(false)

  // Bumps on every fresh (reset) load so an out-of-order resolution from a
  // superseded query can't overwrite the current results.
  const requestSeq = useRef(0)

  // Debounce the raw input into the query that actually drives fetches.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  // Reset everything when the dialog closes so it reopens on a clean slate.
  useEffect(() => {
    if (!open) {
      setQuery("")
      setDebouncedQuery("")
      setItems([])
      setNextOffset(null)
      setError(false)
    }
  }, [open])

  const fetchPage = useCallback(
    async (
      q: string,
      offset: number,
      signal: AbortSignal
    ): Promise<{ items: GiphyGif[]; nextOffset: number | null }> => {
      return q
        ? giphyApi.search(workspaceId, q, { offset, signal })
        : giphyApi.trending(workspaceId, { offset, signal })
    },
    [workspaceId]
  )

  // Load the first page whenever the dialog is open and the query changes
  // (empty query => trending).
  useEffect(() => {
    if (!open) return
    const seq = ++requestSeq.current
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    fetchPage(debouncedQuery, 0, controller.signal)
      .then((page) => {
        if (seq !== requestSeq.current) return
        setItems(page.items)
        setNextOffset(page.nextOffset)
      })
      .catch((err) => {
        if (controller.signal.aborted || seq !== requestSeq.current) return
        setError(true)
        setItems([])
        setNextOffset(null)
        console.warn("Giphy request failed", err)
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false)
      })
    return () => controller.abort()
  }, [open, debouncedQuery, fetchPage])

  const handleLoadMore = useCallback(() => {
    if (nextOffset === null || loadingMore) return
    const seq = requestSeq.current
    const controller = new AbortController()
    setLoadingMore(true)
    fetchPage(debouncedQuery, nextOffset, controller.signal)
      .then((page) => {
        if (seq !== requestSeq.current) return
        setItems((prev) => [...prev, ...page.items])
        setNextOffset(page.nextOffset)
      })
      .catch((err) => {
        if (!controller.signal.aborted) console.warn("Giphy load-more failed", err)
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoadingMore(false)
      })
  }, [debouncedQuery, fetchPage, loadingMore, nextOffset])

  const handleSelect = useCallback(
    (gif: GiphyGif) => {
      onSelect(gif)
      onOpenChange(false)
    },
    [onSelect, onOpenChange]
  )

  const showEmpty = !loading && !error && items.length === 0

  let body: ReactNode
  if (loading) {
    body = (
      <div className="columns-2 gap-2 sm:columns-3" aria-busy="true" aria-label="Loading GIFs">
        {SKELETON_RATIOS.map((ratio, i) => (
          <Skeleton key={i} className="mb-2 w-full rounded-lg" style={{ aspectRatio: String(ratio) }} />
        ))}
      </div>
    )
  } else if (error) {
    body = (
      <GiphyEmptyState
        icon={<ImageOff className="h-6 w-6 text-muted-foreground/40" aria-hidden="true" />}
        title="Couldn't load GIFs"
        hint="Check your connection and try again."
      />
    )
  } else if (showEmpty) {
    body = (
      <GiphyEmptyState
        icon={<SearchX className="h-6 w-6 text-muted-foreground/40" aria-hidden="true" />}
        title={debouncedQuery ? `No GIFs for "${debouncedQuery}"` : "No GIFs found"}
        hint="Try a different search."
      />
    )
  } else {
    body = (
      <>
        <div className="columns-2 gap-2 duration-200 animate-in fade-in sm:columns-3">
          {items.map((gif) => (
            <button
              key={gif.id}
              type="button"
              onClick={() => handleSelect(gif)}
              className={cn(
                "group mb-2 block w-full overflow-hidden rounded-lg border border-border/60 bg-muted/40",
                "transition-[border-color,box-shadow] hover:border-primary hover:shadow-sm",
                "focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              )}
              aria-label={gif.title || "GIF"}
            >
              <img
                src={gif.previewUrl}
                alt={gif.title || "GIF"}
                loading="lazy"
                width={gif.width}
                height={gif.height}
                className="h-auto w-full transition-opacity group-hover:opacity-90"
                style={{ aspectRatio: `${gif.width} / ${gif.height}` }}
              />
            </button>
          ))}
        </div>
        {nextOffset !== null && (
          <div className="mt-3 flex justify-center">
            <Button type="button" variant="outline" size="sm" onClick={handleLoadMore} disabled={loadingMore}>
              {loadingMore ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Loading…
                </>
              ) : (
                "Load more"
              )}
            </Button>
          </div>
        )}
      </>
    )
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        desktopClassName="max-w-2xl max-h-[85vh] sm:flex flex-col gap-0 p-0"
        drawerClassName="flex flex-col"
        aria-describedby={undefined}
      >
        <ResponsiveDialogHeader className="border-b px-4 py-3 sm:px-6">
          <ResponsiveDialogTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Film className="h-4 w-4 text-primary" aria-hidden="true" />
            Add a GIF
          </ResponsiveDialogTitle>
          <div className="relative mt-2.5">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search GIPHY"
              className="pl-9"
              aria-label="Search GIPHY"
            />
          </div>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody data-vaul-no-drag className="py-4 sm:min-h-[24rem]">
          {body}
          <p className="mt-5 text-center text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/45">
            Powered by GIPHY
          </p>
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
