import { useEffect, useRef, useState } from "react"
import { ImageOff } from "lucide-react"
import { cn } from "@/lib/utils"

interface GiphyImageProps {
  /** Giphy CDN URL of the GIF to render. */
  url: string
  title?: string
  className?: string
}

// A transient CDN/network blip must not leave a GIF permanently broken until the
// user reloads the page. On error we refetch a few times with exponential
// backoff, cache-busting each attempt so the browser issues a fresh request
// instead of reusing the failed response. After the attempts are exhausted we
// show a manual retry affordance, and we retry automatically when connectivity
// returns.
const MAX_RETRIES = 5
const RETRY_BASE_MS = 500

/** Append a cache-busting param so a retry forces a fresh CDN fetch. */
function withRetryParam(url: string, attempt: number): string {
  if (attempt === 0) return url
  try {
    const next = new URL(url)
    next.searchParams.set("_threaRetry", String(attempt))
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
export function GiphyImage({ url, title, className }: GiphyImageProps) {
  const [attempt, setAttempt] = useState(0)
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
    setAttempt(0)
    setFailed(false)
    return clearTimer
  }, [url])

  // When connectivity returns, give an exhausted GIF a fresh attempt.
  useEffect(() => {
    if (!failed) return
    const onOnline = () => {
      setFailed(false)
      setAttempt((current) => current + 1)
    }
    window.addEventListener("online", onOnline)
    return () => window.removeEventListener("online", onOnline)
  }, [failed])

  const handleError = () => {
    if (attempt >= MAX_RETRIES) {
      setFailed(true)
      return
    }
    const delay = RETRY_BASE_MS * 2 ** attempt
    clearTimer()
    timerRef.current = setTimeout(() => setAttempt((current) => current + 1), delay)
  }

  const handleRetryClick = () => {
    clearTimer()
    setFailed(false)
    setAttempt((current) => current + 1)
  }

  if (failed) {
    return (
      <button
        type="button"
        onClick={handleRetryClick}
        className={cn(
          "flex items-center gap-2 rounded-item border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted/70",
          className
        )}
        data-type="giphy-embed"
      >
        <ImageOff className="h-4 w-4 shrink-0" />
        <span>Couldn&apos;t load GIF — tap to retry</span>
      </button>
    )
  }

  return (
    <span className={cn("relative inline-block max-w-full align-bottom", className)} data-type="giphy-embed">
      <img
        key={attempt}
        src={withRetryParam(url, attempt)}
        alt={title || "GIF"}
        loading="lazy"
        onError={handleError}
        className="block max-h-64 w-auto max-w-full rounded-item"
      />
      <span className="pointer-events-none absolute bottom-1.5 right-1.5 rounded-md bg-black/55 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-white/85 backdrop-blur-sm">
        GIPHY
      </span>
    </span>
  )
}
