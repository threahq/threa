import type { MouseEvent } from "react"
import { Link } from "react-router-dom"
import type { DocBacklink } from "@threahq/types"
import { usePanel } from "@/contexts"
import { requestBlockFocus } from "@/lib/docs/block-focus"
import { streamLabel } from "@/lib/streams"
import { useWorkspaceStream } from "@/stores/workspace-store"
import { DocChip } from "./doc-chip"
import { pickStreamLabel, useLiveDocTitle } from "./use-live-doc-title"
import { useDocBacklinks } from "./use-doc-backlinks"

interface DocBacklinksProps {
  workspaceId: string
  docId: string
}

/** "Linked from": the docs whose text links to this one, each opening on the block that holds the link. */
export function DocBacklinks({ workspaceId, docId }: DocBacklinksProps) {
  const backlinks = useDocBacklinks(workspaceId, docId)
  if (backlinks.length === 0) return null

  return (
    <section className="mt-8 border-t pt-4" aria-labelledby="doc-backlinks-heading">
      <h2 id="doc-backlinks-heading" className="mb-2 text-xs font-medium text-muted-foreground">
        Linked from
      </h2>
      <ul className="space-y-1">
        {backlinks.map((backlink) => (
          <BacklinkRow key={backlink.docId} workspaceId={workspaceId} backlink={backlink} />
        ))}
      </ul>
    </section>
  )
}

function BacklinkRow({ workspaceId, backlink }: { workspaceId: string; backlink: DocBacklink }) {
  const { getPanelUrl } = usePanel()
  const { label } = useLiveDocTitle(workspaceId, backlink.docId, backlink.title ?? "")
  const host = useWorkspaceStream(workspaceId, backlink.hostStreamId ?? undefined, pickStreamLabel)
  const firstBlockId = backlink.blockIds[0]
  const handleClick = (event: MouseEvent) => {
    if (!firstBlockId || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    requestBlockFocus(backlink.docId, firstBlockId)
  }

  return (
    <li className="flex min-w-0 items-center gap-2 text-sm">
      <Link to={getPanelUrl(backlink.docId)} onClick={handleClick} className="min-w-0 no-underline">
        <DocChip label={label} />
      </Link>
      {host && <span className="truncate text-xs text-muted-foreground">{streamLabel(host)}</span>}
    </li>
  )
}
