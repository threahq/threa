import { useEffect, useMemo, useState } from "react"
import type { JSONContent } from "@threa/types"
import { classifyDraftLink, extractDraftLinkUrls } from "@/lib/in-app-links"
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
 * full preview card each would. In-app links chip to their stream/memo name;
 * web links chip their host. Dismiss hides a chip (the link text stays); a
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

  const links = useMemo(() => urls.filter((u) => !dismissed.has(u)).map((u) => classifyDraftLink(u)), [urls, dismissed])
  const visible = links.filter((l) => l !== null)
  if (visible.length === 0) return null

  const dismiss = (url: string) => setDismissed((prev) => new Set(prev).add(url))

  return (
    <div className={cn("flex flex-wrap gap-2 max-h-[120px] overflow-y-auto", className)}>
      {visible.map((link) => (
        <ComposerLinkChip key={link.url} link={link} workspaceId={workspaceId} onDismiss={dismiss} />
      ))}
    </div>
  )
}
