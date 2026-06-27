import { useEffect, useMemo, useState } from "react"
import type { JSONContent } from "@threa/types"
import { extractInAppLinkUrls } from "@/lib/in-app-links"
import { ComposerInAppLinkPreviewCard } from "@/components/timeline/in-app-link-preview-card"
import { cn } from "@/lib/utils"

/**
 * Wait for typing to settle before resolving — a link mid-type (host/path not
 * yet complete) shouldn't thrash the resolver. The extractor already filters to
 * complete in-app URL shapes, so this only smooths the keystroke cadence.
 */
const DEBOUNCE_MS = 400

interface ComposerLinkPreviewsProps {
  content: JSONContent
  workspaceId: string
  className?: string
}

/**
 * Live in-app link previews for the message composer: the same access-tiered
 * cards a posted message renders, shown while the draft is still being written.
 * Resolves each in-app link straight from its URL (no persisted preview row),
 * deduped and capped to match the server's per-message preview limit.
 */
export function ComposerLinkPreviews({ content, workspaceId, className }: ComposerLinkPreviewsProps) {
  const [debounced, setDebounced] = useState(content)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(content), DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [content])

  const urls = useMemo(() => extractInAppLinkUrls(debounced), [debounced])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  // Forget a dismissal once its link leaves the draft, so removing then
  // re-adding a link previews it again and the set can't grow unbounded.
  useEffect(() => {
    setDismissed((prev) => {
      const next = new Set([...prev].filter((u) => urls.includes(u)))
      return next.size === prev.size ? prev : next
    })
  }, [urls])

  const visibleUrls = urls.filter((u) => !dismissed.has(u))
  if (visibleUrls.length === 0) return null

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {visibleUrls.map((url) => (
        <ComposerInAppLinkPreviewCard
          key={url}
          url={url}
          workspaceId={workspaceId}
          onDismiss={(u) => setDismissed((prev) => new Set(prev).add(u))}
        />
      ))}
    </div>
  )
}
