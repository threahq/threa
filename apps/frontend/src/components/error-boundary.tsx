import { useEffect, useState } from "react"
import { useRouteError, isRouteErrorResponse, Link } from "react-router-dom"
import { AlertTriangle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from "@/components/ui/empty"
import { ErrorDetails } from "./error-details"
import { chunkUrlFromError, isChunkLoadError, runSwRecovery } from "@/lib/sw-recovery"
import { fetchLatestVersion, shouldRecoverForVersion } from "@/hooks/use-app-update"
import { currentAppVersion } from "@/lib/app-build"
import { captureException } from "@/lib/analytics/posthog"

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

  useEffect(() => {
    if (error !== undefined) captureException(error)
  }, [error])

  // "checking" while the deploy probe runs, "reloading" once the reload is in
  // flight (both render the spinner so the error card doesn't flash first).
  // "declined_unverified" falls through to the ordinary error card;
  // "declined_cap" to the update-needed copy.
  const [chunkRecovery, setChunkRecovery] = useState<"checking" | "reloading" | "declined_unverified" | "declined_cap">(
    "checking"
  )

  // A lazy route's dynamic import fails with the same generic browser message
  // whether a newer deploy replaced the chunk or the network dropped it, so
  // reload only on a CONFIRMED newer deploy; otherwise fall through to the error
  // card, whose plain reload serves from the intact cache. This path is a capped
  // plain reload that keeps the worker registered and every cache intact —
  // clearing caches happens only when the user picks it below.
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
      setChunkRecovery("reloading")
      const triggered = await runSwRecovery()
      if (!cancelled && !triggered) setChunkRecovery("declined_cap")
    })()
    return () => {
      cancelled = true
    }
  }, [chunkLoadFailed])

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
      "Part of Threa couldn't load after reloading. Clearing the cache will require downloading the app again."
  }

  const handleReload = () => {
    window.location.reload()
  }

  const handleHardReload = () => {
    const bustUrl = chunkUrlFromError(error)
    void runSwRecovery({ force: true, bustUrls: bustUrl ? [bustUrl] : undefined })
  }

  const errorText = formatError(error)

  // A reload is imminent (or the deploy probe is still deciding) — show a
  // lightweight status instead of the scary error UI, which would flash for a
  // few hundred ms before the reload.
  if (chunkLoadFailed && (chunkRecovery === "checking" || chunkRecovery === "reloading")) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-background p-4">
        <Empty className="border-0 max-w-md w-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Loader2 className="animate-spin" />
            </EmptyMedia>
            <EmptyTitle>Reloading Threa</EmptyTitle>
            <EmptyDescription>Part of the app didn't load. Trying again…</EmptyDescription>
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
