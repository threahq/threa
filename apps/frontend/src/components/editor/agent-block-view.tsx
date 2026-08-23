import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { X } from "lucide-react"
import { useParams } from "react-router-dom"
import { useActors } from "@/hooks"
import { PersonaAvatar } from "@/components/persona-avatar"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { cn } from "@/lib/utils"
import type { AgentBlockAttrs } from "./agent-block-extension"

/**
 * The agent block inside a composer: a gold frame with the agent's name, and
 * the body as ordinary editable content. Removing the frame is one control —
 * dropping the block also drops the text, which is the honest pairing.
 */
export function AgentBlockView({ node, deleteNode, selected }: NodeViewProps) {
  const attrs = node.attrs as AgentBlockAttrs
  const { workspaceId } = useParams<{ workspaceId: string }>()

  return (
    <NodeViewWrapper
      className={cn(
        "group/agent-block reveal-host my-1 rounded-md border border-primary/40 bg-primary/[0.03] px-3 py-2",
        selected && "ring-2 ring-primary/30"
      )}
      data-type="agent-block"
      data-author-id={attrs.authorId}
    >
      <div className="flex items-center gap-2" contentEditable={false}>
        <AgentIdentity workspaceId={workspaceId} authorId={attrs.authorId} authorName={attrs.authorName} />
        <span className="flex-1" />
        <button
          type="button"
          onClick={deleteNode}
          className="shrink-0 rounded-sm p-0.5 text-muted-foreground reveal-actions hover:text-foreground"
          aria-label={`Remove ${attrs.authorName || "agent"} block`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <NodeViewContent className="mt-1 text-sm" />
    </NodeViewWrapper>
  )
}

function AgentIdentity({
  workspaceId,
  authorId,
  authorName,
}: {
  workspaceId: string | undefined
  authorId: string
  authorName: string
}) {
  const actorType = authorId.startsWith("bot_") ? "bot" : "persona"
  const { getActorAvatar } = useActors(workspaceId ?? "")
  const { fallback, slug, avatarUrl } = getActorAvatar(authorId, actorType)

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {actorType === "persona" ? (
        <PersonaAvatar slug={slug} avatarUrl={avatarUrl} fallback={fallback} size="sm" className="h-4 w-4 text-[8px]" />
      ) : (
        <Avatar className="h-4 w-4 shrink-0 rounded-[4px]">
          {avatarUrl && <AvatarImage src={avatarUrl} alt={authorName} />}
          <AvatarFallback className="bg-emerald-500/10 text-[8px] text-emerald-600">{fallback}</AvatarFallback>
        </Avatar>
      )}
      <span className={cn("truncate text-xs font-medium", actorType === "bot" ? "text-emerald-600" : "text-primary")}>
        {authorName}
      </span>
    </span>
  )
}
