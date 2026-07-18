import { useEffect, useRef } from "react"
import { reportPreviewHidden, reportPreviewVisible } from "@/lib/preview-visibility"

/**
 * Report a provider preview card's viewport presence to the visibility batcher
 * (which feeds the backend's conditional-refresh nudge). Returns a ref for the
 * card's root element. No-ops when disabled, when ids are missing (transient
 * previews without a workspace), or where IntersectionObserver doesn't exist
 * (jsdom).
 */
export function useReportPreviewVisible(params: {
  workspaceId: string | undefined
  previewId: string
  enabled: boolean
}): React.RefObject<HTMLDivElement | null> {
  const { workspaceId, previewId, enabled } = params
  const elementRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const element = elementRef.current
    if (!enabled || !workspaceId || !element || typeof IntersectionObserver === "undefined") return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) reportPreviewVisible(workspaceId, previewId)
          else reportPreviewHidden(workspaceId, previewId)
        }
      },
      // A sliver of a card peeking in shouldn't count as "looking at it".
      { threshold: 0.5 }
    )
    observer.observe(element)

    return () => {
      observer.disconnect()
      reportPreviewHidden(workspaceId, previewId)
    }
  }, [enabled, workspaceId, previewId])

  return elementRef
}
