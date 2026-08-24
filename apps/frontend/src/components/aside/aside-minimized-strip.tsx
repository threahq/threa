import { useMemo } from "react"
import { X } from "lucide-react"
import { StreamTypes } from "@threa/types"
import { Button } from "@/components/ui/button"
import { useIsMobile } from "@/hooks/use-mobile"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { closeAside, rememberedAsideSurface, setAsideSurface, useAsideForHost } from "@/stores/aside-store"
import { resolveAsideRestoreSurface } from "@/lib/aside/surface"
import { COLLAPSED_COMPOSER_SHADOW } from "@/components/composer/collapsed-composer-bar"
import { truncateContent } from "@/components/layout/sidebar/utils"
import { STREAM_ICONS, streamFallbackLabel, streamLabel } from "@/lib/streams"
import { formatRelativeTime } from "@/lib/dates"
import { useCallDocked } from "./use-call-docked"
import { useAsideDrafts } from "./use-aside-drafts"

const AsideGlyph = STREAM_ICONS[StreamTypes.ASIDE]

interface AsideMinimizedStripProps {
  workspaceId: string
  hostKey: string
  /**
   * Mounted by the dock slot over the whole content area (phones), rather than
   * inside the page's main column (desktop). Each instance renders only on its
   * own form factor, so the strip is never drawn twice.
   */
  overlay?: boolean
}

/**
 * A minimized aside, parked above the host composer inside the page's main
 * column (never a global pill — it cannot outlive the stream).
 *
 * It is a card, not a chip: the composer's own width, radius, border and
 * shadow, with the aside's gold edge down its left. That matters because this
 * sits where a composer's attachments and reply strips sit, and those read as
 * "part of what I am about to send" — this is a surface that was put down, so
 * it carries the aside's title, what is waiting inside it, and an explicit way
 * back in rather than being a row that happens to be clickable.
 */
export function AsideMinimizedStrip({ workspaceId, hostKey, overlay = false }: AsideMinimizedStripProps) {
  const current = useAsideForHost(hostKey)
  const asideId = current?.surface === "minimized" ? current.asideId : null
  const streams = useWorkspaceStreams(workspaceId)
  const aside = useMemo(() => streams.find((stream) => stream.id === asideId), [streams, asideId])
  const drafts = useAsideDrafts(workspaceId, asideId ?? "")
  const { toEmoji } = useWorkspaceEmoji(workspaceId)
  const callDocked = useCallDocked()
  const isMobile = useIsMobile()
  if (!asideId || isMobile !== overlay) return null

  const title = aside ? streamLabel(aside) : streamFallbackLabel(StreamTypes.ASIDE, "generic")
  const restore = () =>
    setAsideSurface(resolveAsideRestoreSurface({ remembered: rememberedAsideSurface(asideId), callDocked }))

  // What is waiting in there, so the card is recognisably the thing just being
  // written in rather than an anonymous bar. Preview goes through the shared
  // strip-then-truncate path (INV-60), never raw markdown.
  const preview = aside?.lastMessagePreview
  const draftCount = drafts.filter((draft) => !draft.isEmpty).length
  const parts: string[] = []
  if (draftCount > 0) parts.push(`${draftCount} draft${draftCount === 1 ? "" : "s"}`)
  if (preview?.content) parts.push(truncateContent(preview.content, 60, toEmoji))
  else if (preview?.createdAt) parts.push(formatRelativeTime(new Date(preview.createdAt), new Date()))
  const subtitle = parts.join(" · ")

  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-20"
      style={{ bottom: "calc(var(--composer-height, 5rem) + 0.25rem)" }}
    >
      {/* The composer shell's own box, so the card's edges land exactly on the
          composer's below it rather than a gutter's width outside them. */}
      <div className="mx-auto w-full min-w-0 max-w-[800px] px-3 sm:px-6">
        <div
          data-testid="aside-strip"
          data-aside-id={asideId}
          className={`pointer-events-auto flex items-center gap-3 overflow-hidden rounded-[16px] border border-l-2 border-input border-l-primary/70 bg-card py-2 pl-3 pr-2 ${COLLAPSED_COMPOSER_SHADOW}`}
        >
          <AsideGlyph className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium leading-tight">{title}</p>
            {subtitle && <p className="truncate text-[11px] leading-tight text-muted-foreground">{subtitle}</p>}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={restore}
            aria-label={`Open aside: ${title}`}
            className="h-7 shrink-0 rounded-full bg-primary/10 px-3 text-[11px] font-medium text-primary hover:bg-primary/15 hover:text-primary"
          >
            Open
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={closeAside}
            aria-label="Close aside"
            className="h-7 w-7 shrink-0 text-muted-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}
