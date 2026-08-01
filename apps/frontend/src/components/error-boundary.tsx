import { useEffect, useState } from "react"
import { useRouteError, isRouteErrorResponse, Link } from "react-router-dom"
import { AlertTriangle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from "@/components/ui/empty"
import { ErrorDetails } from "./error-details"
import { chunkUrlFromError, isChunkLoadError, runSwRecovery } from "@/lib/sw-recovery"
import { fetchLatestVersion, shouldRecoverForVersion } from "@/hooks/use-app-update"
import { currentAppVersion } from "@/lib/app-build"

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

  // "checking" while the staleness probe runs, "recovering" once the wipe is
  // in flight (both render the "Updating" spinner so the scary card doesn't
  // flash before the reload). "declined_unverified" falls through to the
  // ordinary error card; "declined_cap" to the update-needed copy.
  const [chunkRecovery, setChunkRecovery] = useState<
    "checking" | "recovering" | "declined_unverified" | "declined_cap"
  >("checking")

  // Stale-deploy auto-recovery: when a lazy route's dynamic import 404s, old
  // JS is trying to fetch a chunk whose filename has been replaced by a newer
  // build. Unregister the SW, clear caches, and hard-reload so the tab picks
  // up the current asset manifest. Gated by a shared sessionStorage counter
  // (see lib/sw-recovery.ts) so we can't loop past the cap.
  //
  // The browser reports a slow-network fetch failure and a stale-deploy 404
  // with the SAME generic dynamic-import message, so the error alone never
  // justifies the wipe: destroying the precached shell on a flaky connection
  // makes the next load fully network-bound — the reload-to-white loop. Wipe
  // only on a CONFIRMED newer deploy (shouldRecoverForVersion: both versions
  // known and different — a successful probe also proves we're online enough
  // for the recovery refetch to land); otherwise fall through to the error
  // card, whose plain reload serves from the intact cache.
  useEffect(() => {
    if (!chunkLoadFailed) return
    let cancelled = false
    void (async () => {
      const latest = await fetchLatestVersion()
      if (cancelled) return
      if (!shouldRecoverForVersion(currentAppVersion(), latest)) {
        setChunkRecovery("declined_unverified")
        return
      }
      setChunkRecovery("recovering")
      // Pass the failing chunk URL so recovery force-refetches it past the
      // browser HTTP cache — an immutable-cached bad response (HTML served as JS
      // at an /assets/* URL) is what unregister + caches.delete can't evict.
      const bustUrl = chunkUrlFromError(error)
      const triggered = await runSwRecovery({ bustUrls: bustUrl ? [bustUrl] : undefined })
      if (!cancelled && !triggered) setChunkRecovery("declined_cap")
    })()
    return () => {
      cancelled = true
    }
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
  } else if (chunkLoadFailed && chunkRecovery === "declined_cap") {
    title = "Update needed"
    description =
      "A newer version of Threa was deployed, and we couldn't auto-update this tab. Visit /recover to force a full reset."
  }

  const handleReload = () => {
    window.location.reload()
  }

  const handleHardReload = () => {
    const bustUrl = chunkUrlFromError(error)
    void runSwRecovery({ force: true, bustUrls: bustUrl ? [bustUrl] : undefined })
  }

  const errorText = formatError(error)

  // Recovery is imminent (or the staleness probe is still deciding) — show a
  // lightweight status instead of the scary error UI, which would flash for a
  // few hundred ms before the reload.
  if (chunkLoadFailed && (chunkRecovery === "checking" || chunkRecovery === "recovering")) {
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
