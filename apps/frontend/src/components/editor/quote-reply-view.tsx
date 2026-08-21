import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { X, Quote } from "lucide-react"
import { useParams } from "react-router-dom"
import { stripMarkdownToInline, truncateInline } from "@/lib/markdown/strip"
import { cn } from "@/lib/utils"
import { useActors } from "@/hooks"
import { useUserProfile } from "@/components/user-profile"
import { PersonaAvatar } from "@/components/persona-avatar"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import type { QuoteReplyAttrs } from "./quote-reply-extension"
import type { AuthorType } from "@threa/types"

export function QuoteReplyView({ node, deleteNode, selected }: NodeViewProps) {
  const attrs = node.attrs as QuoteReplyAttrs
  // The snippet is the formatted slice the server will store, so the chip strips
  // it to inline text rather than showing raw markdown (INV-60).
  const displaySnippet = truncateInline(stripMarkdownToInline(attrs.snippet), 200)

  const { workspaceId } = useParams<{ workspaceId: string }>()

  return (
    <NodeViewWrapper
      className={cn(
        "my-1 flex items-start gap-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-sm select-none",
        "group/quote-reply reveal-host",
        selected && "ring-2 ring-primary/30"
      )}
      data-type="quote-reply"
    >
      <Quote className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        {workspaceId && attrs.authorId ? (
          <QuoteAuthor
            workspaceId={workspaceId}
            authorName={attrs.authorName}
            authorId={attrs.authorId}
            actorType={attrs.actorType as AuthorType}
          />
        ) : (
          <span className="text-xs font-medium text-muted-foreground">{attrs.authorName}</span>
        )}
        <p className="mt-0.5 text-muted-foreground">{displaySnippet}</p>
      </div>
      <button
        type="button"
        onClick={deleteNode}
        className="shrink-0 rounded-sm p-0.5 text-muted-foreground reveal-actions hover:text-foreground"
        aria-label="Remove quote"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </NodeViewWrapper>
  )
}

function QuoteAuthor({
  workspaceId,
  authorName,
  authorId,
  actorType,
}: {
  workspaceId: string
  authorName: string
  authorId: string
  actorType: AuthorType
}) {
  const { getActorAvatar } = useActors(workspaceId)
  const { openUserProfile } = useUserProfile()
  const { fallback, slug, avatarUrl } = getActorAvatar(authorId, actorType)
  const isPersona = actorType === "persona"
  const isBot = actorType === "bot"
  const isSystem = actorType === "system"
  const isUser = actorType === "user"

  const handleAuthorClick = () => {
    if (isUser && authorId) {
      openUserProfile(authorId)
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      {isPersona ? (
        <PersonaAvatar slug={slug} avatarUrl={avatarUrl} fallback={fallback} size="sm" className="h-4 w-4 text-[8px]" />
      ) : (
        <Avatar className="h-4 w-4 rounded-[4px] shrink-0">
          {avatarUrl && <AvatarImage src={avatarUrl} alt={authorName} />}
          <AvatarFallback
            className={cn(
              "text-[8px]",
              isSystem && "bg-blue-500/10 text-blue-500",
              isBot && "bg-emerald-500/10 text-emerald-600",
              !isSystem && !isBot && "bg-muted text-foreground"
            )}
          >
            {fallback}
          </AvatarFallback>
        </Avatar>
      )}
      <button
        type="button"
        onClick={handleAuthorClick}
        className={cn(
          "text-xs font-medium",
          isUser && authorId ? "text-muted-foreground hover:underline" : "text-muted-foreground cursor-default",
          isPersona && "text-primary",
          isBot && "text-emerald-600",
          isSystem && "text-blue-500"
        )}
      >
        {authorName}
      </button>
    </span>
  )
}
