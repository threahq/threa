import { useMemo } from "react"
import { X } from "lucide-react"
import { StreamTypes } from "@threa/types"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { closeAside, rememberedAsideSurface, setAsideSurface, useAsideForHost } from "@/stores/aside-store"
import { resolveAsideRestoreSurface } from "@/lib/aside/surface"
import { streamFallbackLabel, streamLabel } from "@/lib/streams"
import { useCallDocked } from "./use-call-docked"

interface AsideMinimizedStripProps {
  workspaceId: string
  hostKey: string
}

/**
 * A minimized aside: a slim strip riding just above the host composer, inside
 * the page's main column (never a global pill — it cannot outlive the stream).
 * The strip is the restore control; the title is its content.
 */
export function AsideMinimizedStrip({ workspaceId, hostKey }: AsideMinimizedStripProps) {
  const current = useAsideForHost(hostKey)
  const asideId = current?.surface === "minimized" ? current.asideId : null
  const streams = useWorkspaceStreams(workspaceId)
  const aside = useMemo(() => streams.find((stream) => stream.id === asideId), [streams, asideId])
  const callDocked = useCallDocked()
  if (!asideId) return null

  const title = aside ? streamLabel(aside) : streamFallbackLabel(StreamTypes.ASIDE, "generic")
  const restore = () =>
    setAsideSurface(resolveAsideRestoreSurface({ remembered: rememberedAsideSurface(asideId), callDocked }))

  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-20 px-3 sm:px-6"
      style={{ bottom: "calc(var(--composer-height, 5rem) + 0.25rem)" }}
    >
      <div
        data-testid="aside-strip"
        data-aside-id={asideId}
        className="pointer-events-auto mx-auto flex h-10 max-w-[800px] items-center gap-2 rounded-lg border border-primary/40 bg-background pl-3 pr-1 shadow-md"
      >
        <button
          type="button"
          onClick={restore}
          aria-label={`Open aside: ${title}`}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
        >
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-primary" />
          <span className="min-w-0 truncate font-medium">{title}</span>
        </button>
        <button
          type="button"
          onClick={closeAside}
          aria-label="Close aside"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
