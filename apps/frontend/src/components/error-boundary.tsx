import { useEffect, useState } from "react"
import { useRouteError, isRouteErrorResponse, Link } from "react-router-dom"
import { AlertTriangle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from "@/components/ui/empty"
import { ErrorDetails } from "./error-details"
import { chunkUrlFromError, isChunkLoadError, runSwRecovery } from "@/lib/sw-recovery"

function formatError(error: unknown): string | null {
  if (error instanceof Error) {
    return error.stack ?? error.message
  }
  if (isRouteErrorResponse(error)) {
    const data = typeof error.data === "string" ? error.data : JSON.stringify(error.data, null, 2)
    return `${error.status} ${error.statusText}\n${data}`
  }
  if (error != null) {
    try {
      return JSON.stringify(error, null, 2)
    } catch {
      return String(error)
    }
  }
  return null
}

export function ErrorBoundary() {
  const error = useRouteError()
  const chunkLoadFailed = isChunkLoadError(error)

  // Flips to true only when runSwRecovery declines to reload because the
  // per-session attempt cap is reached. Until then we render the "Updating"
  // spinner instead of the error UI, so we don't flash the scary card for a
  // few hundred ms before the reload kicks in.
  const [recoveryDeclined, setRecoveryDeclined] = useState(false)

  // Stale-deploy auto-recovery: when a lazy route's dynamic import 404s, old
  // JS is trying to fetch a chunk whose filename has been replaced by a newer
  // build. Unregister the SW, clear caches, and hard-reload so the tab picks
  // up the current asset manifest. Gated by a shared sessionStorage counter
  // (see lib/sw-recovery.ts) so we can't loop past the cap.
  useEffect(() => {
    if (!chunkLoadFailed) return
    // Pass the failing chunk URL so recovery force-refetches it past the
    // browser HTTP cache — an immutable-cached bad response (HTML served as JS
    // at an /assets/* URL) is what unregister + caches.delete can't evict.
    const bustUrl = chunkUrlFromError(error)
    void runSwRecovery({ bustUrls: bustUrl ? [bustUrl] : undefined }).then((triggered) => {
      if (!triggered) setRecoveryDeclined(true)
    })
  }, [chunkLoadFailed, error])

  let title = "Something Went Wrong"
  let description = "The labyrinth has shifted unexpectedly. We encountered an error while navigating your path."

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      title = "Path Not Found"
      description = "The thread you seek does not exist in this labyrinth."
    } else if (error.status === 403) {
      title = "Access Denied"
      description = "The gates to this part of the labyrinth are sealed."
    }
  } else if (chunkLoadFailed && recoveryDeclined) {
    title = "Update needed"
    description =
      "A newer version of Threa was deployed, and we couldn't auto-update this tab. Visit /recover to force a full reset."
  }

  const handleReload = () => {
    window.location.reload()
  }

  const handleHardReload = () => {
    void runSwRecovery({ force: true })
  }

  const errorText = formatError(error)

  // Recovery is imminent — show a lightweight status instead of the scary
  // error UI, which would flash for a few hundred ms before the reload.
  if (chunkLoadFailed && !recoveryDeclined) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-background p-4">
        <Empty className="border-0 max-w-md w-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Loader2 className="animate-spin" />
            </EmptyMedia>
            <EmptyTitle>Updating Threa</EmptyTitle>
            <EmptyDescription>Fetching the latest version…</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  return (
    <div className="flex h-screen w-full items-center justify-center bg-background p-4">
      <Empty className="border-0 max-w-md w-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AlertTriangle />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={handleReload}>Try Again</Button>
            <Button variant="outline" asChild>
              <Link to="/workspaces">Back to Workspaces</Link>
            </Button>
            <Button variant="ghost" onClick={handleHardReload}>
              Clear cache &amp; reload
            </Button>
          </div>
          {errorText && <ErrorDetails text={errorText} />}
        </EmptyContent>
      </Empty>
    </div>
  )
}
