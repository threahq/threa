import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"
import type { AuthorType } from "@threa/types"
import { ChevronDown, ChevronLeft, Quote } from "lucide-react"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { useMessageReactions, stripColons, reactionShortcodes } from "@/hooks/use-message-reactions"
import { useActors } from "@/hooks"
import { getInitials } from "@/lib/initials"
import { cn } from "@/lib/utils"
import { buildQuickEmojis } from "@/lib/emoji-picker"
import {
  type MessageActionContext,
  type MessageAction,
  type GroupedActionItem,
  getVisibleActions,
  groupVisibleActions,
  resolveActionLabel,
} from "./message-actions"
import { EmojiQuickBar } from "./emoji-quick-bar"

interface MessageActionDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  context: MessageActionContext
  /** Author display name for the message preview */
  authorName: string
}

export function MessageActionDrawer({ open, onOpenChange, context, authorName }: MessageActionDrawerProps) {
  const actions = getVisibleActions(context)
  const groupedActions = useMemo(() => groupVisibleActions(actions), [actions])
  const { emojis, emojiWeights } = useWorkspaceEmoji(context.workspaceId ?? "")
  const { toggleReaction } = useMessageReactions(context.workspaceId ?? "", context.messageId ?? "")
  // Author's active status (users only; expiry-masked) for the preview byline —
  // mirrors what the timeline header shows next to the timestamp.
  const { getActorAvatar } = useActors(context.workspaceId ?? "")
  const authorStatus = context.authorId
    ? getActorAvatar(context.authorId, (context.actorType ?? "user") as AuthorType).status
    : undefined
  const [expanded, setExpanded] = useState(false)
  const [selectedText, setSelectedText] = useState("")
  const contentRef = useRef<HTMLDivElement>(null)

  // Reset expanded state when drawer closes
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) setExpanded(false)
      onOpenChange(open)
    },
    [onOpenChange]
  )

  // Track text selection within the expanded content area
  useEffect(() => {
    if (!expanded) {
      setSelectedText("")
      return
    }

    const handleSelectionChange = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        setSelectedText("")
        return
      }

      const text = sel.toString().trim()
      if (!text) {
        setSelectedText("")
        return
      }

      // Verify selection is within our content area
      const range = sel.getRangeAt(0)
      if (contentRef.current?.contains(range.startContainer) && contentRef.current?.contains(range.endContainer)) {
        setSelectedText(text)
      } else {
        setSelectedText("")
      }
    }

    document.addEventListener("selectionchange", handleSelectionChange)
    return () => document.removeEventListener("selectionchange", handleSelectionChange)
  }, [expanded])

  const handleQuoteSelected = useCallback(() => {
    if (!selectedText || !context.onQuoteReplyWithSnippet) return
    context.onQuoteReplyWithSnippet(selectedText)
    window.getSelection()?.removeAllRanges()
    handleOpenChange(false)
  }, [selectedText, context, handleOpenChange])

  const handleBack = useCallback(() => {
    window.getSelection()?.removeAllRanges()
    setExpanded(false)
  }, [])

  const activeShortcodes = useMemo(() => {
    if (!context.currentUserId || !context.reactions) return new Set<string>()
    const active = new Set<string>()
    for (const [shortcode, userIds] of Object.entries(context.reactions)) {
      if (userIds.includes(context.currentUserId)) {
        active.add(stripColons(shortcode))
      }
    }
    return active
  }, [context.currentUserId, context.reactions])

  const allReactionShortcodes = useMemo(() => reactionShortcodes(context.reactions), [context.reactions])

  const activeEmojis = useMemo(
    () => emojis.filter((e) => activeShortcodes.has(e.shortcode)),
    [emojis, activeShortcodes]
  )

  const othersEmojis = useMemo(
    () => emojis.filter((e) => allReactionShortcodes.has(e.shortcode) && !activeShortcodes.has(e.shortcode)),
    [emojis, allReactionShortcodes, activeShortcodes]
  )

  const quickEmojis = useMemo(
    () => buildQuickEmojis(emojis, emojiWeights, undefined, undefined, allReactionShortcodes),
    [emojis, emojiWeights, allReactionShortcodes]
  )

  // Quick-react toggles: removes if user already reacted, adds otherwise
  const handleQuickReact = useCallback(
    (shortcode: string) => {
      handleOpenChange(false)
      toggleReaction(shortcode, context.reactions ?? {}, context.currentUserId ?? null)
    },
    [handleOpenChange, toggleReaction, context.reactions, context.currentUserId]
  )

  const handleAction = useCallback(
    (action: MessageAction) => {
      handleOpenChange(false)
      action.action?.(context)
    },
    [context, handleOpenChange]
  )

  if (!open && actions.length === 0) return null

  return (
    <Drawer open={open} onOpenChange={handleOpenChange}>
      <DrawerContent className={cn(expanded ? "h-[95dvh]" : "max-h-[85dvh]")}>
        {/* Accessible title (visually hidden) */}
        <DrawerTitle className="sr-only">{expanded ? "Select text to quote" : "Message actions"}</DrawerTitle>

        {expanded ? (
          <ExpandedQuoteView
            contentMarkdown={context.contentMarkdown}
            authorName={authorName}
            actorType={context.actorType}
            statusEmoji={authorStatus?.emoji ?? null}
            statusText={authorStatus?.text ?? null}
            selectedText={selectedText}
            contentRef={contentRef}
            onBack={handleBack}
            onQuote={handleQuoteSelected}
          />
        ) : (
          <>
            {/* Message preview */}
            <div className="px-4 pt-1 pb-3">
              <button
                type="button"
                className={cn(
                  "group/preview relative w-full text-left rounded-xl bg-muted/60 px-3.5 py-2.5 disabled:opacity-100 disabled:cursor-default",
                  context.onQuoteReplyWithSnippet && "active:bg-muted/80 transition-colors cursor-pointer"
                )}
                onClick={context.onQuoteReplyWithSnippet ? () => setExpanded(true) : undefined}
                disabled={!context.onQuoteReplyWithSnippet}
              >
                <div className="mb-0.5 flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground">
                  <span className="truncate">{authorName}</span>
                  {authorStatus?.emoji && (
                    <span aria-hidden className="text-sm leading-none">
                      {authorStatus.emoji}
                    </span>
                  )}
                  {authorStatus?.text && (
                    <span className="truncate font-normal text-muted-foreground/70">{authorStatus.text}</span>
                  )}
                </div>
                <div className="text-sm text-foreground/80 line-clamp-2 leading-snug pr-6">
                  <MarkdownContent content={context.contentMarkdown} />
                </div>
                {context.onQuoteReplyWithSnippet && (
                  <Quote
                    aria-hidden="true"
                    className="absolute top-2.5 right-2.5 h-3.5 w-3.5 text-muted-foreground/40 group-active/preview:text-primary transition-colors"
                  />
                )}
              </button>
              {context.onQuoteReplyWithSnippet && (
                <p className="text-[11px] text-muted-foreground/60 mt-1.5 px-1 flex items-center gap-1">
                  <span className="inline-block h-1 w-1 rounded-full bg-primary/60" />
                  Tap to highlight a passage
                </p>
              )}
            </div>

            {/* Quick reactions row + full picker button */}
            {(activeEmojis.length > 0 || othersEmojis.length > 0 || quickEmojis.length > 0) && context.onReact && (
              <div className="flex justify-center px-4 pb-3">
                <EmojiQuickBar
                  activeEmojis={activeEmojis}
                  othersEmojis={othersEmojis}
                  quickEmojis={quickEmojis}
                  onReact={handleQuickReact}
                  onOpenFullPicker={() => {
                    handleOpenChange(false)
                    // Deferred so the drawer finishes closing before the picker opens
                    setTimeout(() => context.onOpenFullPicker?.(), 150)
                  }}
                />
              </div>
            )}

            {/* Action list */}
            <div className="px-2 pb-[max(12px,env(safe-area-inset-bottom))]">
              {groupedActions.map((item) => (
                <DrawerActionItem
                  key={item.kind === "single" ? item.action.id : item.members[0].id}
                  item={item}
                  context={context}
                  onClose={() => handleOpenChange(false)}
                  onAction={handleAction}
                />
              ))}
            </div>
          </>
        )}
      </DrawerContent>
    </Drawer>
  )
}

interface ExpandedQuoteViewProps {
  contentMarkdown: string
  authorName: string
  actorType: string | null
  statusEmoji: string | null
  statusText: string | null
  selectedText: string
  contentRef: React.RefObject<HTMLDivElement | null>
  onBack: () => void
  onQuote: () => void
}

function ExpandedQuoteView({
  contentMarkdown,
  authorName,
  actorType,
  statusEmoji,
  statusText,
  selectedText,
  contentRef,
  onBack,
  onQuote,
}: ExpandedQuoteViewProps) {
  const initials = getInitials(authorName)
  const charCount = selectedText.length
  const isPersona = actorType === "persona"
  const isBot = actorType === "bot"
  const isSystem = actorType === "system"

  // Match timeline message-event.tsx accent styling exactly: persona=gold,
  // bot=emerald, system=blue, user=no accent. Inset shadow forms the left
  // "thread" stripe; gradient adds a faint actor-typed wash.
  const accentClass = cn(
    isPersona && "bg-gradient-to-r from-primary/[0.06] to-transparent shadow-[inset_3px_0_0_hsl(var(--primary))]",
    isBot && "bg-gradient-to-r from-emerald-500/[0.06] to-transparent shadow-[inset_3px_0_0_hsl(152_69%_41%)]",
    isSystem && "bg-gradient-to-r from-blue-500/[0.04] to-transparent shadow-[inset_3px_0_0_hsl(210_100%_55%)]"
  )

  // Decorative watermark color follows the same actor-typed logic, neutral for users
  const watermarkClass = cn(
    "absolute top-[-12px] right-3 text-[140px] leading-none font-serif select-none pointer-events-none",
    isPersona && "text-primary/[0.05]",
    isBot && "text-emerald-500/[0.05]",
    isSystem && "text-blue-500/[0.05]",
    !isPersona && !isBot && !isSystem && "text-muted-foreground/[0.08]"
  )

  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* Header — soft app-bar with gradient divider */}
      <div className="relative flex items-center gap-1 px-2 pt-2 pb-3">
        <button
          type="button"
          className="flex items-center justify-center h-9 w-9 rounded-full text-muted-foreground active:bg-muted/80 transition-colors"
          aria-label="Back to actions"
          onClick={onBack}
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <h2 className="text-[15px] font-semibold tracking-tight text-muted-foreground">Full message</h2>
        <div className="absolute left-0 right-0 bottom-0 h-px bg-gradient-to-r from-transparent via-border/70 to-transparent" />
      </div>

      {/* Scrollable byline + content as a single actor-typed block */}
      <div data-vaul-no-drag className="flex-1 min-h-0 overflow-y-auto">
        <div className={cn("relative", accentClass)}>
          {/* Decorative quote watermark */}
          <div aria-hidden="true" className={watermarkClass}>
            &ldquo;
          </div>

          {/* Byline — avatar anchored, matches timeline message style */}
          <div className="relative flex items-center gap-3 px-4 pt-4 pb-3">
            <Avatar className="h-9 w-9 rounded-[10px] shrink-0">
              <AvatarFallback
                className={cn(
                  "rounded-[10px] text-[13px] font-semibold",
                  isSystem && "bg-blue-500/10 text-blue-500",
                  isBot && "bg-emerald-500/10 text-emerald-600",
                  isPersona && "bg-primary/10 text-primary",
                  !isSystem && !isBot && !isPersona && "bg-muted text-foreground"
                )}
              >
                {initials}
              </AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 items-center gap-1.5">
              <p
                className={cn(
                  "text-sm font-semibold truncate",
                  isPersona && "text-primary",
                  isBot && "text-emerald-600",
                  isSystem && "text-blue-500"
                )}
              >
                {authorName}
              </p>
              {statusEmoji && (
                <span aria-hidden className="text-sm leading-none">
                  {statusEmoji}
                </span>
              )}
              {statusText && (
                <span className="truncate text-xs font-normal text-muted-foreground/70">{statusText}</span>
              )}
            </div>
          </div>

          {/* Selectable message content */}
          <div
            ref={contentRef}
            className="relative px-4 pb-6 select-text [-webkit-touch-callout:none] outline-none"
            tabIndex={-1}
          >
            <MarkdownContent content={contentMarkdown} className="text-sm leading-relaxed text-foreground" />
          </div>
        </div>
      </div>

      {/* Footer toolbar — compact, two-state */}
      <div className="relative px-4 pt-2.5 pb-[max(10px,env(safe-area-inset-bottom))]">
        <div
          aria-hidden="true"
          className="absolute left-0 right-0 top-0 h-px bg-gradient-to-r from-transparent via-border/70 to-transparent"
        />
        {selectedText ? (
          <div className="flex items-center justify-between gap-3 animate-in fade-in slide-in-from-bottom-1 duration-150">
            <p className="text-[12px] text-muted-foreground tabular-nums">
              <span className="font-semibold text-foreground/85">{charCount}</span>{" "}
              {charCount === 1 ? "character" : "characters"} selected
            </p>
            <Button size="sm" className="h-9 gap-1.5 px-3.5 font-medium" onClick={onQuote}>
              <Quote className="h-3.5 w-3.5" />
              Quote
            </Button>
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground/70 text-center py-1">
            Long-press the message to highlight a passage
          </p>
        )}
      </div>
    </div>
  )
}

function Divider() {
  return <Separator className="mx-3 my-1 bg-border/50" />
}

function DrawerActionItem({
  item,
  context,
  onClose,
  onAction,
}: {
  item: GroupedActionItem
  context: MessageActionContext
  onClose: () => void
  onAction: (action: MessageAction) => void
}) {
  if (item.kind === "single") {
    const action = item.action
    return (
      <>
        {action.separatorBefore && <Divider />}
        <DrawerActionPrimary action={action} context={context} onClose={onClose} onAction={onAction} />
      </>
    )
  }

  const { members } = item
  const primary = members[0]
  return (
    <>
      {primary.separatorBefore && <Divider />}
      <DrawerActionSplitRow members={members} context={context} onClose={onClose} onAction={onAction} />
    </>
  )
}

/** Single-action row body (used both standalone and as the left half of a split row). */
function DrawerActionPrimary({
  action,
  context,
  onClose,
  onAction,
  className,
}: {
  action: MessageAction
  context: MessageActionContext
  onClose: () => void
  onAction: (action: MessageAction) => void
  className?: string
}) {
  const Icon = action.icon
  const isDestructive = action.variant === "destructive"
  const href = action.getHref?.(context)

  const baseClassName = cn(
    "flex items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors",
    isDestructive ? "text-destructive active:bg-destructive/10" : "active:bg-muted/80"
  )
  const iconEl = (
    <Icon className={cn("h-[18px] w-[18px] shrink-0", isDestructive ? "text-destructive" : "text-muted-foreground")} />
  )

  if (href) {
    return (
      <Link to={href} className={cn(baseClassName, "rounded-lg w-full", className)} onClick={onClose}>
        {iconEl}
        <span>{resolveActionLabel(action, context)}</span>
      </Link>
    )
  }

  return (
    <button
      type="button"
      className={cn(baseClassName, "w-full rounded-lg", className)}
      onClick={() => onAction(action)}
    >
      {iconEl}
      <span>{resolveActionLabel(action, context)}</span>
    </button>
  )
}

/**
 * Split-row pattern (à la GitHub's merge button): the primary action is the
 * default tap target on the left; a chevron button on the right opens a small
 * dropdown listing ALL group members (primary first). Same data model as the
 * desktop context menu — `messageActions` declares the group via `groupId`
 * and `groupVisibleActions` collapses adjacent same-group entries into the
 * `{ members }` shape this row consumes; the renderer always shows
 * `members[0]` as the row's tap target and the full set in the dropdown.
 */
function DrawerActionSplitRow({
  members,
  context,
  onClose,
  onAction,
}: {
  members: MessageAction[]
  context: MessageActionContext
  onClose: () => void
  onAction: (action: MessageAction) => void
}) {
  const primary = members[0]
  return (
    <div className="flex items-stretch w-full rounded-lg overflow-hidden">
      <div className="flex-1 min-w-0">
        <DrawerActionPrimary
          action={primary}
          context={context}
          onClose={onClose}
          onAction={onAction}
          className="rounded-none rounded-l-lg"
        />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center justify-center w-10 shrink-0 border-l border-border/50 text-muted-foreground active:bg-muted/80 transition-colors rounded-r-lg"
            aria-label={`Other ${primary.groupId ?? "options"}`}
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} className="min-w-[220px]">
          {members.map((member, idx) => {
            const MemberIcon = member.icon
            const isPrimary = idx === 0
            return (
              <DropdownMenuItem
                key={member.id}
                className={cn("gap-2 cursor-pointer", isPrimary && "font-medium")}
                onSelect={() => {
                  onClose()
                  member.action?.(context)
                }}
              >
                <MemberIcon className="h-4 w-4 text-muted-foreground" />
                <span>{resolveActionLabel(member, context)}</span>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
