import { useCallback, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { usePanel } from "@/contexts"
import { useEffectiveArchived } from "@/hooks/use-effective-archived"
import { cn } from "@/lib/utils"
import { indexStreams, useWorkspaceStreamsSelect, type CachedStream } from "@/stores/workspace-store"

const ROW_CLASS =
  "group flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground sm:min-h-0 sm:px-6"
const LINK_CLASS =
  "transition-colors hover:bg-primary/[0.04] focus-visible:bg-primary/[0.04] focus-visible:outline-none"

/**
 * Whether a host row's doc opens. A cached doc does, and a doc missing from the cache is one the viewer can no longer
 * read, except under a sealed host: the bootstrap never lists the docs of an archived host, so the cache can't say.
 */
export function useDocRowReadable(workspaceId: string, hostStreamId: string, docName: string | null): boolean {
  const selectHost = useCallback((rows: CachedStream[]) => indexStreams(rows).get(hostStreamId) ?? null, [hostStreamId])
  const host = useWorkspaceStreamsSelect(workspaceId, selectHost)
  const { isArchived } = useEffectiveArchived({ workspaceId, stream: host, fallbackArchived: null })
  return docName !== null || isArchived
}

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
