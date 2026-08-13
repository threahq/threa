import { useEffect, useMemo, useState } from "react"
import type { JSONContent } from "@threa/types"
import {
  classifyDraftLink,
  extractDraftLinkUrls,
  isBelowRowDraftLink,
  type BelowRowDraftLink,
} from "@/lib/in-app-links"
import { ComposerLinkChip } from "./composer-link-chip"
import { cn } from "@/lib/utils"

/**
 * Wait for typing to settle before resolving — a link mid-type shouldn't thrash
 * the resolver. The extractor only matches complete link-mark URLs, so this just
 * smooths the keystroke cadence.
 */
const DEBOUNCE_MS = 400

interface ComposerLinkPreviewsProps {
  content: JSONContent
  workspaceId: string
  className?: string
}

/**
 * Compact chip row for the links in a draft — the same attachment-pill surface
 * file uploads use, so several links don't bury the composer on mobile the way a
 * full preview card each would. Memo in-app links chip to their memo name; web
 * links chip their host. Dismiss hides a chip (the link text stays); a
 * dismissal is forgotten once its link leaves the draft.
 */
export function ComposerLinkPreviews({ content, workspaceId, className }: ComposerLinkPreviewsProps) {
  const [debounced, setDebounced] = useState(content)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(content), DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [content])

  const urls = useMemo(() => extractDraftLinkUrls(debounced), [debounced])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  // Forget a dismissal once its link leaves the draft, so removing then
  // re-adding a link chips it again and the set can't grow unbounded.
  useEffect(() => {
    setDismissed((prev) => {
      const next = new Set([...prev].filter((u) => urls.includes(u)))
      return next.size === prev.size ? prev : next
    })
  }, [urls])

  // Stream/message/conversation in-app links render as an inline chip in the draft
  // body, not a below-row chip (`isBelowRowDraftLink`) — so this row carries only
  // web and memo links, matching the timeline's inline-chip card suppression (#1103).
  const visible = useMemo(
    () =>
      urls
        .filter((u) => !dismissed.has(u))
        .map((u) => classifyDraftLink(u))
        .filter((l): l is BelowRowDraftLink => l !== null && isBelowRowDraftLink(l)),
    [urls, dismissed]
  )
  if (visible.length === 0) return null

  const dismiss = (url: string) => setDismissed((prev) => new Set(prev).add(url))

  return (
    <div className={cn("flex shrink-0 flex-wrap gap-2 max-h-[120px] overflow-y-auto", className)}>
      {visible.map((link) => (
        <ComposerLinkChip key={link.url} link={link} workspaceId={workspaceId} onDismiss={dismiss} />
      ))}
    </div>
  )
}
