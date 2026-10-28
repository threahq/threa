import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { usePanel } from "@/contexts"
import { cn } from "@/lib/utils"

const ROW_CLASS =
  "group flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground sm:min-h-0 sm:px-6"
const LINK_CLASS =
  "transition-colors hover:bg-primary/[0.04] focus-visible:bg-primary/[0.04] focus-visible:outline-none"

/**
 * A host timeline row about a doc: a link to its pane, or plain text when the doc is unreadable. A doc the viewer can
 * no longer read is not in the cache, and its link would only open a dead pane.
 */
export function DocEventRow({ docId, readable, children }: { docId: string; readable: boolean; children: ReactNode }) {
  const { getPanelUrl } = usePanel()
  if (!readable) return <div className={ROW_CLASS}>{children}</div>
  return (
    <Link to={getPanelUrl(docId)} data-doc-id={docId} className={cn(ROW_CLASS, LINK_CLASS)}>
      {children}
    </Link>
  )
}
