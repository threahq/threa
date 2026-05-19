import { useMemo, useRef, type ReactNode } from "react"
import { Quote, ChevronDown, ChevronRight } from "lucide-react"
import { Link, useParams } from "react-router-dom"
import { DEFAULT_BLOCKQUOTE_COLLAPSE_THRESHOLD, type AuthorType } from "@threa/types"
import { useActors } from "@/hooks"
import { useUserProfile } from "@/components/user-profile"
import { PersonaAvatar } from "@/components/persona-avatar"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { cn } from "@/lib/utils"
import { usePreferencesOptional } from "@/contexts/preferences-context"
import { useBlockCollapse } from "./use-block-collapse"
import { useMeasuredLineCount } from "./use-measured-line-count"
import { InsideCollapsibleBlockProvider } from "./markdown-block-context"
import { extractBlockText } from "./extract-block-text"

interface QuoteReplyBlockProps {
  authorName: string
  authorId: string
  actorType: string
  streamId: string
  messageId: string
  children: ReactNode
}

/**
 * Renders a quote-reply block in message display.
 * Clicking the quoted text navigates to the source message; the chevron
 * toggles a summary / full-quote view. INV-40: the outer wrapper is a plain
 * container so author and toggle buttons aren't nested inside the Link.
 */
export function QuoteReplyBlock({
  authorName,
  authorId,
  actorType,
  streamId,
  messageId,
  children,
}: QuoteReplyBlockProps) {
  const { workspaceId } = useParams<{ workspaceId: string }>()

  const quotedText = useMemo(() => extractBlockText(children), [children])

  const preferencesContext = usePreferencesOptional()
  const threshold =
    preferencesContext?.preferences?.blockquoteCollapseThreshold ?? DEFAULT_BLOCKQUOTE_COLLAPSE_THRESHOLD

  const bodyRef = useRef<HTMLDivElement | null>(null)
  const measured = useMeasuredLineCount(bodyRef, [quotedText])
  const lineCount = measured.lineCount
  // Measured by rendered line-height (handles soft wrapping) with the same
  // "more than threshold" semantic. The +0.5 keeps barely-over quotes from
  // sprouting a toggle that would only hide the half line we already show.
  const collapsible = lineCount !== null && lineCount > threshold + 0.5
  const displayLineCount = lineCount !== null ? Math.max(1, Math.round(lineCount)) : 0

  const { collapsed, canToggle, toggle } = useBlockCollapse({
    // Quote replies are anchored by the quoted (streamId, messageId) pair, so
    // two quote-replies to the same message in a single container collapse
    // together — which is what users expect.
    kind: "quote-reply",
    hashNamespace: `${streamId}/${messageId}`,
    content: quotedText,
    collapsible,
  })

  if (!workspaceId) return null

  const url = `/w/${workspaceId}/s/${streamId}?m=${messageId}`

  const collapseLabel = collapsed
    ? `Expand ${displayLineCount} line${displayLineCount === 1 ? "" : "s"}`
    : "Collapse quote reply"
  const collapsedMaxHeight =
    collapsed && measured.lineHeightPx !== null ? (threshold + 0.5) * measured.lineHeightPx : undefined

  return (
    <InsideCollapsibleBlockProvider active={canToggle}>
      <div className="my-2 flex items-start gap-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-sm">
        <Quote className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <QuoteAuthor
              workspaceId={workspaceId}
              authorName={authorName}
              authorId={authorId}
              actorType={actorType as AuthorType}
            />
            {canToggle && (
              <button
                type="button"
                onClick={toggle}
                aria-expanded={!collapsed}
                aria-label={collapseLabel}
                title={collapseLabel}
                className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-primary/10 hover:text-foreground"
              >
                {collapsed ? (
                  <ChevronRight className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <ChevronDown className="h-3 w-3" aria-hidden="true" />
                )}
              </button>
            )}
          </div>
          <Link
            to={url}
            className="relative mt-0.5 block text-muted-foreground no-underline transition-colors hover:text-foreground"
          >
            <div
              ref={bodyRef}
              className={cn("[&_p]:mb-0", collapsed && "overflow-hidden")}
              style={collapsedMaxHeight !== undefined ? { maxHeight: collapsedMaxHeight } : undefined}
            >
              {children}
            </div>
            {collapsed && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-b from-transparent to-muted/30"
              />
            )}
          </Link>
        </div>
      </div>
    </InsideCollapsibleBlockProvider>
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
  const { fallback, slug, avatarUrl } = getActorAvatar(authorId || null, actorType)
  const isPersona = actorType === "persona"
  const isBot = actorType === "bot"
  const isSystem = actorType === "system"
  const isUser = actorType === "user"

  const handleAuthorClick = () => {
    if (isUser && authorId) {
      openUserProfile(authorId)
    }
  }

  let avatar = null
  if (authorId && isPersona) {
    avatar = <PersonaAvatar slug={slug} fallback={fallback} size="sm" className="h-4 w-4 text-[8px]" />
  } else if (authorId) {
    avatar = (
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
    )
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      {avatar}
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
