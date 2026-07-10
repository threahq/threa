import { Component, useState, useCallback, useEffect, useMemo, type ReactNode } from "react"
import { ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { linkPreviewsApi } from "@/api"
import { cn } from "@/lib/utils"
import { usePreferences } from "@/contexts"
import { useLinkPreviewDismissal } from "@/hooks/use-link-preview-dismissals"
import { LinkPreviewCard } from "./link-preview-card"
import { InAppLinkPreviewCard } from "./in-app-link-preview-card"
import { isInAppLinkContentType, LinkPreviewContentTypes, type LinkPreviewSummary } from "@threa/types"

const DEFAULT_VISIBLE_COUNT = 3

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
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  const [isExpanded, setIsExpanded] = useState(false)
  const { preferences } = usePreferences()

  const defaultCollapsed = preferences?.linkPreviewDefault === "collapsed"

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

  const displayedPreviews = isExpanded ? visiblePreviews : visiblePreviews.slice(0, DEFAULT_VISIBLE_COUNT)
  const hiddenCount = visiblePreviews.length - DEFAULT_VISIBLE_COUNT

  return (
    <div className={cn("flex flex-col gap-2 mt-2", className)}>
      {displayedPreviews.map((preview) => {
        // In-app links (message / stream / memo / conversation) use a specialized card with
        // permission-checked resolve instead of a network-fetched web card.
        if (isInAppLinkContentType(preview.contentType)) {
          return (
            <PreviewRenderBoundary key={preview.id}>
              <InAppLinkPreviewCard
                preview={preview}
                workspaceId={workspaceId}
                onDismiss={handleDismiss}
                hydrate={hydrateFromApi}
              />
            </PreviewRenderBoundary>
          )
        }

        const isHighlighted = hoveredUrl ? normalizeForCompare(preview.url) === normalizeForCompare(hoveredUrl) : false

        const explicitlyCollapsed = collapsedIds.has(preview.id)
        const explicitlyOpened = collapsedIds.has(`__opened_${preview.id}`)
        const isCollapsed = explicitlyCollapsed || (defaultCollapsed && !explicitlyOpened)

        return (
          <PreviewRenderBoundary key={preview.id}>
            <LinkPreviewCard
              preview={preview}
              messageId={messageId}
              workspaceId={workspaceId}
              isHighlighted={isHighlighted}
              isCollapsed={isCollapsed}
              onDismiss={handleDismiss}
              onToggleCollapse={(id) => {
                setCollapsedIds((prev) => {
                  const next = new Set(prev)
                  const currentlyCollapsed = next.has(id) || (defaultCollapsed && !next.has(`__opened_${id}`))
                  next.delete(id)
                  next.delete(`__opened_${id}`)
                  if (currentlyCollapsed) {
                    next.add(`__opened_${id}`)
                  } else {
                    next.add(id)
                  }
                  return next
                })
              }}
            />
          </PreviewRenderBoundary>
        )
      })}

      {hiddenCount > 0 && !isExpanded && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start h-7 text-xs text-muted-foreground"
          onClick={() => setIsExpanded(true)}
        >
          <ChevronDown className="h-3 w-3 mr-1" />
          Show {hiddenCount} more preview{hiddenCount > 1 ? "s" : ""}
        </Button>
      )}
    </div>
  )
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
