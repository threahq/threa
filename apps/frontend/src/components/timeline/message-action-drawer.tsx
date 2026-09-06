import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { AuthorType } from "@threahq/types"
import { ChevronLeft, Quote } from "lucide-react"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { useMessageReactions, stripColons, reactionShortcodes } from "@/hooks/use-message-reactions"
import { useActors } from "@/hooks"
import { getInitials } from "@/lib/initials"
import type { QuoteSelection } from "@/lib/quote-selection"
import { cn } from "@/lib/utils"
import { buildQuickEmojis } from "@/lib/emoji-picker"
import { ActionDrawerList } from "@/components/actions/action-drawer-list"
import {
  type MessageActionContext,
  type MessageAction,
  getVisibleActions,
  groupVisibleActions,
} from "./message-actions"
import { EmojiQuickBar } from "./emoji-quick-bar"
import { SelectionPill } from "./selection-pill"

function isSameRange(a: Range | null, b: Range): boolean {
  return (
    a !== null &&
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer &&
    a.endOffset === b.endOffset
  )
}

/** Quiet time after the last `selectionchange` before the pill is offered. */
const SELECTION_SETTLE_MS = 250

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
  const [selection, setSelection] = useState<QuoteSelection | null>(null)
  const [range, setRange] = useState<Range | null>(null)
  // A selection is only worth acting on once it stops moving: the pill would
  // otherwise chase every `selectionchange` tick of a handle drag, under the
  // very finger doing the dragging.
  const [settled, setSettled] = useState(false)
  const [touching, setTouching] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // A callback ref, so a sheet node swapped out mid-transition is replaced
  // rather than remembered. The pill portals into whatever this holds.
  const [sheet, setSheet] = useState<HTMLDivElement | null>(null)
  const pillInteractingRef = useRef(false)
  const rangeRef = useRef<Range | null>(null)
  rangeRef.current = range

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) setExpanded(false)
      onOpenChange(open)
    },
    [onOpenChange]
  )

  /**
   * Touching the pill is a press outside the selection, and dragging it drags a
   * new one, so by the time the finger lifts the highlight it acts on is gone.
   * Put it back, or the pill tears itself down between its own pointerup and
   * click. Releasing is idempotent because the finger can lift anywhere: the
   * pill reports its own pointerup, and the document listener below catches the
   * lifts and cancels that never reach it.
   */
  const releasePillGuard = useCallback(() => {
    if (!pillInteractingRef.current) return
    pillInteractingRef.current = false
    const stored = rangeRef.current
    if (!stored) return
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(stored)
  }, [])

  useEffect(() => {
    if (!expanded) {
      pillInteractingRef.current = false
      setSelection(null)
      setRange(null)
      setSettled(false)
      setTouching(false)
      return
    }

    let settleTimer: ReturnType<typeof setTimeout> | undefined
    const clear = () => {
      clearTimeout(settleTimer)
      setSelection(null)
      setRange(null)
      setSettled(false)
    }

    const handleSelectionChange = () => {
      // Pressing the pill is a tap on an overlay outside the selection, which
      // Chrome collapses. Holding what was already read keeps the button's own
      // click from tearing its owner down.
      if (pillInteractingRef.current) return

      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount) return clear()

      const text = sel.toString().trim()
      const contentEl = contentRef.current
      if (!text || !contentEl) return clear()

      const selected = sel.getRangeAt(0)
      if (!contentEl.contains(selected.startContainer) || !contentEl.contains(selected.endContainer)) return clear()

      // Putting the selection back after a press on the pill raises a
      // `selectionchange` of our own. Recognising it by identity is what keeps
      // the repair from reading as the reader starting over, which would hide
      // the pill for another settle and swallow the tap already in flight.
      if (isSameRange(rangeRef.current, selected)) return

      const prefix = contentEl.ownerDocument.createRange()
      prefix.selectNodeContents(contentEl)
      prefix.setEnd(selected.startContainer, selected.startOffset)
      setSelection({ text, prefixText: prefix.toString() })
      setRange(selected.cloneRange())
      setSettled(false)
      clearTimeout(settleTimer)
      settleTimer = setTimeout(() => setSettled(true), SELECTION_SETTLE_MS)
    }

    const handlePointerDown = () => {
      if (!pillInteractingRef.current) setTouching(true)
    }
    const handlePointerUp = () => {
      setTouching(false)
      releasePillGuard()
    }

    document.addEventListener("selectionchange", handleSelectionChange)
    document.addEventListener("pointerdown", handlePointerDown)
    document.addEventListener("pointerup", handlePointerUp)
    document.addEventListener("pointercancel", handlePointerUp)
    return () => {
      clearTimeout(settleTimer)
      document.removeEventListener("selectionchange", handleSelectionChange)
      document.removeEventListener("pointerdown", handlePointerDown)
      document.removeEventListener("pointerup", handlePointerUp)
      document.removeEventListener("pointercancel", handlePointerUp)
    }
  }, [expanded, releasePillGuard])

  const handleQuoteSelected = useCallback(() => {
    if (!selection || !context.onQuoteReplyWithSelection) return
    context.onQuoteReplyWithSelection(selection)
    window.getSelection()?.removeAllRanges()
    handleOpenChange(false)
  }, [selection, context, handleOpenChange])

  const handleShareSelected = useCallback(() => {
    if (!selection || !context.onShareWithSelection) return
    context.onShareWithSelection(selection)
    window.getSelection()?.removeAllRanges()
    handleOpenChange(false)
  }, [selection, context, handleOpenChange])

  const handleBack = useCallback(() => {
    window.getSelection()?.removeAllRanges()
    setExpanded(false)
  }, [])

  const handlePillInteracting = useCallback(
    (interacting: boolean) => {
      if (interacting) {
        pillInteractingRef.current = true
        return
      }
      releasePillGuard()
    },
    [releasePillGuard]
  )

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
      <DrawerContent ref={setSheet} className={cn(expanded ? "h-[95dvh]" : "max-h-[85dvh]")}>
        <DrawerTitle className="sr-only">{expanded ? "Select text to quote or share" : "Message actions"}</DrawerTitle>

        {expanded ? (
          <ExpandedQuoteView
            contentMarkdown={context.contentMarkdown}
            authorName={authorName}
            actorType={context.actorType}
            statusEmoji={authorStatus?.emoji ?? null}
            statusText={authorStatus?.text ?? null}
            selectedText={selection?.text ?? ""}
            pillRange={settled && !touching ? range : null}
            contentRef={contentRef}
            scrollRef={scrollRef}
            sheet={sheet}
            onBack={handleBack}
            onPillInteracting={handlePillInteracting}
            onQuote={handleQuoteSelected}
            onShare={context.onShareWithSelection ? handleShareSelected : undefined}
          />
        ) : (
          <>
            <div className="px-4 pt-1 pb-3">
              <button
                type="button"
                data-testid="expanded-quote-open"
                className={cn(
                  "group/preview relative w-full text-left rounded-xl bg-muted/60 px-3.5 py-2.5 disabled:opacity-100 disabled:cursor-default",
                  context.onQuoteReplyWithSelection && "active:bg-muted/80 transition-colors cursor-pointer"
                )}
                onClick={context.onQuoteReplyWithSelection ? () => setExpanded(true) : undefined}
                disabled={!context.onQuoteReplyWithSelection}
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
                <div className="text-sm text-foreground/80 line-clamp-2 leading-snug pr-6 max-h-[2.75rem] overflow-hidden">
                  <MarkdownContent content={context.contentMarkdown} />
                </div>
                {context.onQuoteReplyWithSelection && (
                  <Quote
                    aria-hidden="true"
                    className="absolute top-2.5 right-2.5 h-3.5 w-3.5 text-muted-foreground/40 group-active/preview:text-primary transition-colors"
                  />
                )}
              </button>
              {context.onQuoteReplyWithSelection && (
                <p className="text-[11px] text-muted-foreground/60 mt-1.5 px-1 flex items-center gap-1">
                  <span className="inline-block h-1 w-1 rounded-full bg-primary/60" />
                  Tap to highlight a passage
                </p>
              )}
            </div>

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

            <div
              data-vaul-no-drag
              className="flex-1 min-h-0 overflow-y-auto px-2 pb-[max(12px,env(safe-area-inset-bottom))]"
            >
              <ActionDrawerList
                items={groupedActions}
                context={context}
                onClose={() => handleOpenChange(false)}
                onAction={handleAction}
              />
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
  /** The settled selection the pill anchors to, or null while it is still moving. */
  pillRange: Range | null
  contentRef: React.RefObject<HTMLDivElement | null>
  scrollRef: React.RefObject<HTMLDivElement | null>
  sheet: HTMLDivElement | null
  onBack: () => void
  onPillInteracting: (interacting: boolean) => void
  onQuote: () => void
  onShare?: () => void
}

function ExpandedQuoteView({
  contentMarkdown,
  authorName,
  actorType,
  statusEmoji,
  statusText,
  selectedText,
  pillRange,
  contentRef,
  scrollRef,
  sheet,
  onBack,
  onPillInteracting,
  onQuote,
  onShare,
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
      <div className="relative flex items-center gap-1 px-2 pt-2 pb-3">
        <button
          type="button"
          className="flex items-center justify-center h-9 w-9 rounded-full text-muted-foreground active:bg-muted/80 transition-colors"
          aria-label="Back to actions"
          onClick={onBack}
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <h2
          data-testid="expanded-quote-title"
          className="text-[15px] font-semibold tracking-tight text-muted-foreground"
        >
          {charCount > 0 ? (
            <>
              <span className="tabular-nums text-foreground/85">{charCount}</span>{" "}
              {charCount === 1 ? "character" : "characters"} selected
            </>
          ) : (
            "Full message"
          )}
        </h2>
        <div className="absolute left-0 right-0 bottom-0 h-px bg-gradient-to-r from-transparent via-border/70 to-transparent" />
      </div>

      <div ref={scrollRef} data-vaul-no-drag className="flex-1 min-h-0 overflow-y-auto">
        <div className={cn("relative", accentClass)}>
          <div aria-hidden="true" className={watermarkClass}>
            &ldquo;
          </div>

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

          <div
            ref={contentRef}
            data-testid="expanded-quote-body"
            className="relative px-4 pb-6 select-text [-webkit-touch-callout:none] outline-none"
            tabIndex={-1}
          >
            <MarkdownContent content={contentMarkdown} className="text-sm leading-relaxed text-foreground" />
          </div>
        </div>
      </div>

      <SelectionPill
        range={pillRange}
        viewportRef={scrollRef}
        portalHost={sheet}
        onInteractingChange={onPillInteracting}
        onQuote={onQuote}
        onShare={onShare}
      />
    </div>
  )
}
