import { useEffect, useRef, useState } from "react"
import { ImageOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface GiphyImageProps {
  /** Giphy CDN URL of the GIF to render. */
  url: string
  title?: string
  className?: string
  /** Intrinsic pixel size of the rendition, when known. Used to reserve an
   *  aspect-ratio box before the GIF decodes so the timeline doesn't reflow. */
  width?: number
  height?: number
}

// A transient CDN/network blip must not leave a GIF permanently broken until the
// user reloads the page. On error we refetch a few times with exponential
// backoff, cache-busting each attempt so the browser issues a fresh request
// instead of reusing the failed response. After the attempts are exhausted we
// show a manual retry affordance, and we retry automatically when connectivity
// returns — both of which start a fresh backoff cycle.
const MAX_RETRIES = 5
const RETRY_BASE_MS = 500

/** Append a cache-busting param so a reload forces a fresh CDN fetch. */
function withReloadParam(url: string, token: number): string {
  if (token === 0) return url
  try {
    const next = new URL(url)
    next.searchParams.set("_threaReload", String(token))
    return next.toString()
  } catch {
    return url
  }
}

/**
 * Renders a GIF straight from Giphy's CDN with the required GIPHY attribution
 * mark. Shared by the composer node view and the timeline renderer so the embed
 * looks the same wherever it appears. Failed loads are retried with backoff so a
 * transient CDN hiccup doesn't drop the asset until the next page refresh.
 */
export function GiphyImage({ url, title, className, width, height }: GiphyImageProps) {
  // Reserve the GIF's box before its bytes decode. Without intrinsic dimensions
  // the <img> lays out at ~0 height and grows to the decoded height on load,
  // shifting every message below it — the "timeline jumps on load" report. With
  // the width/height attributes plus an explicit aspect-ratio the browser
  // reserves the (height-capped) box up front, so load is a no-reflow swap.
  const hasDimensions = typeof width === "number" && typeof height === "number" && width > 0 && height > 0
  // Monotonic token: drives the <img> key and cache-bust param so every reload
  // is a genuinely fresh request rather than a reuse of the failed response.
  const [reloadToken, setReloadToken] = useState(0)
  // Auto-retries used in the current cycle, capped at MAX_RETRIES. Reset to 0
  // when the user taps retry or connectivity returns, so each is a full cycle.
  const [retries, setRetries] = useState(0)
  const [failed, setFailed] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  // Reset retry state whenever the GIF source changes, and clear any pending
  // retry on unmount.
  useEffect(() => {
    setReloadToken(0)
    setRetries(0)
    setFailed(false)
    return clearTimer
  }, [url])

  // When connectivity returns, give an exhausted GIF a fresh backoff cycle.
  useEffect(() => {
    if (!failed) return
    const onOnline = () => {
      clearTimer()
      setFailed(false)
      setRetries(0)
      setReloadToken((token) => token + 1)
    }
    window.addEventListener("online", onOnline)
    return () => window.removeEventListener("online", onOnline)
  }, [failed])

  const handleError = () => {
    if (retries >= MAX_RETRIES) {
      setFailed(true)
      return
    }
    const delay = RETRY_BASE_MS * 2 ** retries
    clearTimer()
    timerRef.current = setTimeout(() => {
      setRetries((current) => current + 1)
      setReloadToken((token) => token + 1)
    }, delay)
  }

  const handleRetryClick = () => {
    clearTimer()
    setFailed(false)
    setRetries(0)
    setReloadToken((token) => token + 1)
  }

  if (failed) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleRetryClick}
        className={cn("h-auto gap-2 px-3 py-2 text-xs font-normal text-muted-foreground", className)}
        data-type="giphy-embed"
      >
        <ImageOff className="h-4 w-4 shrink-0" />
        <span>Couldn&apos;t load GIF — tap to retry</span>
      </Button>
    )
  }

  return (
    <span className={cn("relative inline-block max-w-full align-bottom", className)} data-type="giphy-embed">
      <img
        key={reloadToken}
        src={withReloadParam(url, reloadToken)}
        alt={title || "GIF"}
        loading="lazy"
        width={hasDimensions ? width : undefined}
        height={hasDimensions ? height : undefined}
        onError={handleError}
        className="block max-h-64 w-auto max-w-full rounded-item"
        style={hasDimensions ? { aspectRatio: `${width} / ${height}` } : undefined}
      />
      <span className="pointer-events-none absolute bottom-1.5 right-1.5 rounded-md bg-black/55 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-white/85 backdrop-blur-sm">
        GIPHY
      </span>
    </span>
  )
}
