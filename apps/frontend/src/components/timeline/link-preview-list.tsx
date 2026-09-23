import { Component, useState, useCallback, useEffect, useMemo, type ReactNode } from "react"
import { ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { linkPreviewsApi } from "@/api"
import { cn } from "@/lib/utils"
import { usePreferences } from "@/contexts"
import { useLinkPreviewDismissal } from "@/hooks/use-link-preview-dismissals"
import { useLinkPreviewOpen } from "@/hooks/use-link-preview-collapse"
import { LinkPreviewCard } from "./link-preview-card"
import { InAppLinkPreviewCard } from "./in-app-link-preview-card"
import { isInAppLinkContentType, LinkPreviewContentTypes, type LinkPreviewSummary } from "@threahq/types"

/** Previews a message opens as cards; web previews past it start as one-line chips. */
const MAX_OPEN_CARDS = 3

interface LinkPreviewListProps {
  messageId: string
  workspaceId: string
  /** Previews provided from stream event payload (real-time) */
  previews?: LinkPreviewSummary[]
  /** Currently hovered link URL from inline text */
  hoveredUrl?: string | null
  className?: string
  /** Whether to hydrate preview dismiss state/details from the API */
  hydrateFromApi?: boolean
}

class PreviewRenderBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) return null
    return this.props.children
  }
}

export function LinkPreviewList({
  messageId,
  workspaceId,
  previews: initialPreviews,
  hoveredUrl,
  className,
  hydrateFromApi = true,
}: LinkPreviewListProps) {
  const [previews, setPreviews] = useState<LinkPreviewSummary[]>(initialPreviews ?? [])
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set())
  const [isExpanded, setIsExpanded] = useState(false)
  const { preferences } = usePreferences()

  // An explicit empty array (edited message that removed URLs, or backend
  // dismissal filtering) clears stale previews; undefined leaves them intact.
  useEffect(() => {
    if (initialPreviews === undefined) return
    setPreviews(initialPreviews)
  }, [initialPreviews])

  // Sync dismissals from other views/tabs via a single shared socket listener
  useLinkPreviewDismissal(messageId, (linkPreviewId: string) => {
    setDismissedIds((prev) => {
      if (prev.has(linkPreviewId)) return prev
      return new Set([...prev, linkPreviewId])
    })
  })

  const handleDismiss = useCallback(
    async (previewId: string) => {
      setDismissedIds((prev) => new Set([...prev, previewId]))
      try {
        await linkPreviewsApi.dismiss(workspaceId, messageId, previewId)
      } catch {
        setDismissedIds((prev) => {
          const next = new Set(prev)
          next.delete(previewId)
          return next
        })
      }
    },
    [workspaceId, messageId]
  )

  // A stream link is a bare "#channel" reference, fully said by its inline chip,
  // so its card is suppressed. A message link keeps its card: the inline chip is
  // a compact named reference in the body, and the card carries the rich preview
  // (author face, snippet) below. Memo and web previews keep their card too.
  const visiblePreviews = useMemo(
    () => previews.filter((p) => !dismissedIds.has(p.id) && p.contentType !== LinkPreviewContentTypes.STREAM_LINK),
    [previews, dismissedIds]
  )

  if (visiblePreviews.length === 0) return null

  // In-app previews have no chip form, so past the cap they hide behind "Show more"
  // while web previews fold to chips, which share lines and never count.
  const collapsedByPreference = preferences?.linkPreviewDefault === "collapsed"
  let openCount = 0
  const displayedPreviews = visiblePreviews.flatMap((preview) => {
    if (isInAppLinkContentType(preview.contentType)) {
      openCount++
      return isExpanded || openCount <= MAX_OPEN_CARDS ? [{ preview, defaultOpen: true }] : []
    }
    const defaultOpen = !collapsedByPreference && openCount < MAX_OPEN_CARDS
    if (defaultOpen) openCount++
    return [{ preview, defaultOpen }]
  })
  const hiddenCount = visiblePreviews.length - displayedPreviews.length

  return (
    <div className={cn("flex flex-wrap items-start gap-2 mt-2", className)}>
      {displayedPreviews.map(({ preview, defaultOpen }) => {
        // In-app links (message / stream / memo / conversation) use a specialized card with
        // permission-checked resolve instead of a network-fetched web card.
        if (isInAppLinkContentType(preview.contentType)) {
          return (
            <PreviewRenderBoundary key={preview.id}>
              <div className="basis-full min-w-0">
                <InAppLinkPreviewCard
                  preview={preview}
                  workspaceId={workspaceId}
                  onDismiss={handleDismiss}
                  hydrate={hydrateFromApi}
                />
              </div>
            </PreviewRenderBoundary>
          )
        }

        return (
          <PreviewRenderBoundary key={preview.id}>
            <WebPreviewItem
              preview={preview}
              messageId={messageId}
              workspaceId={workspaceId}
              isHighlighted={hoveredUrl ? normalizeForCompare(preview.url) === normalizeForCompare(hoveredUrl) : false}
              defaultOpen={defaultOpen}
              onDismiss={handleDismiss}
            />
          </PreviewRenderBoundary>
        )
      })}

      {hiddenCount > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="basis-full justify-start h-7 text-xs text-muted-foreground"
          onClick={() => setIsExpanded(true)}
        >
          <ChevronDown className="h-3 w-3 mr-1" />
          Show {hiddenCount} more preview{hiddenCount > 1 ? "s" : ""}
        </Button>
      )}
    </div>
  )
}

function WebPreviewItem({
  preview,
  messageId,
  workspaceId,
  isHighlighted,
  defaultOpen,
  onDismiss,
}: {
  preview: LinkPreviewSummary
  messageId: string
  workspaceId: string
  isHighlighted: boolean
  defaultOpen: boolean
  onDismiss: (previewId: string) => void
}) {
  const { open, toggle } = useLinkPreviewOpen(messageId, preview.id, defaultOpen)
  const card = (
    <LinkPreviewCard
      preview={preview}
      messageId={messageId}
      workspaceId={workspaceId}
      isHighlighted={isHighlighted}
      isCollapsed={!open}
      onDismiss={onDismiss}
      onToggleCollapse={toggle}
    />
  )
  return open ? <div className="basis-full min-w-0">{card}</div> : card
}

/** Normalize URL for hover comparison (strip trailing slash, lowercase) */
function normalizeForCompare(url: string): string {
  try {
    const u = new URL(url)
    u.hostname = u.hostname.toLowerCase()
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1)
    }
    return u.toString()
  } catch {
    return url.toLowerCase()
  }
}
