import type { ReactNode } from "react"
import { useParams } from "react-router-dom"
import { useActors } from "@/hooks"
import { PersonaAvatar } from "@/components/persona-avatar"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { cn } from "@/lib/utils"

interface AgentBlockProps {
  authorId: string
  authorName: string
  children: ReactNode
}

/**
 * A received agent block: the gold frame that says a person sent you text an
 * agent wrote. The attribution is the whole point, so it renders from the
 * stored `agent:` pointer even when the actor is no longer in the workspace.
 */
export function AgentBlock({ authorId, authorName, children }: AgentBlockProps) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const actorType = authorId.startsWith("bot_") ? "bot" : "persona"
  const { getActorAvatar } = useActors(workspaceId ?? "")
  const { fallback, slug, avatarUrl } = getActorAvatar(authorId, actorType)

  return (
    <div
      className="my-2 rounded-md border border-primary/40 bg-primary/[0.03] px-3 py-2"
      data-type="agent-block"
      data-author-id={authorId}
    >
      <span className="inline-flex min-w-0 items-center gap-1.5">
        {actorType === "persona" ? (
          <PersonaAvatar
            slug={slug}
            avatarUrl={avatarUrl}
            fallback={fallback}
            size="sm"
            className="h-4 w-4 text-[8px]"
          />
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
      <div className="mt-1">{children}</div>
    </div>
  )
}
