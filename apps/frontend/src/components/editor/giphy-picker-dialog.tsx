import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Search, Loader2 } from "lucide-react"
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
import { cn } from "@/lib/utils"

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
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading GIFs" />
      </div>
    )
  } else if (error) {
    body = (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <p className="text-sm font-medium text-muted-foreground">Could not load GIFs</p>
        <p className="mt-1 text-xs text-muted-foreground/60">Check your connection and try again.</p>
      </div>
    )
  } else if (showEmpty) {
    body = (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <p className="text-sm font-medium text-muted-foreground">No GIFs found</p>
        <p className="mt-1 text-xs text-muted-foreground/60">Try a different search.</p>
      </div>
    )
  } else {
    body = (
      <>
        <div className="columns-2 gap-2 sm:columns-3 [&>button]:mb-2">
          {items.map((gif) => (
            <button
              key={gif.id}
              type="button"
              onClick={() => handleSelect(gif)}
              className={cn(
                "block w-full overflow-hidden rounded-md border border-transparent bg-muted/40",
                "transition hover:border-primary focus-visible:border-primary focus-visible:outline-none"
              )}
              aria-label={gif.title || "GIF"}
            >
              <img
                src={gif.previewUrl}
                alt={gif.title || "GIF"}
                loading="lazy"
                width={gif.width}
                height={gif.height}
                className="h-auto w-full"
                style={{ aspectRatio: `${gif.width} / ${gif.height}` }}
              />
            </button>
          ))}
        </div>
        {nextOffset !== null && (
          <div className="mt-2 flex justify-center">
            <Button type="button" variant="outline" size="sm" onClick={handleLoadMore} disabled={loadingMore}>
              {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : "Load more"}
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
          <ResponsiveDialogTitle className="text-sm font-medium">Add a GIF</ResponsiveDialogTitle>
          <div className="relative mt-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search GIPHY"
              className="pl-8"
              aria-label="Search GIPHY"
            />
          </div>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody data-vaul-no-drag className="py-4 sm:min-h-[24rem]">
          {body}
          <p className="mt-4 text-center text-[10px] uppercase tracking-wide text-muted-foreground/50">
            Powered by GIPHY
          </p>
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
