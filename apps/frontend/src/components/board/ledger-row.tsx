import { useCallback, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react"
import { Link, useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { ChevronUp, ChevronDown, ChevronRight, CornerDownRight, Paperclip, Link2, Pencil } from "lucide-react"
import { LabelableResourceTypes, LinkPreviewContentTypes } from "@threa/types"
import { MessageItem, type RenderableMessage } from "@/components/message/message-item"
import { actorRowTheme } from "@/components/message/actor-row-theme"
import { MessageContextMenu } from "@/components/timeline/message-context-menu"
import { MessageActionDrawer } from "@/components/timeline/message-action-drawer"
import { MessageHistoryDialog } from "@/components/timeline/message-history-dialog"
import { isGalleryPreviewableAttachment } from "@/components/timeline/attachment-list"
import { ReactionEmojiPicker } from "@/components/timeline/reaction-emoji-picker"
import { ReminderPickerSheet } from "@/components/timeline/reminder-picker-sheet"
import type { MessageActionContext } from "@/components/timeline/message-actions"
import { LabelPicker } from "@/components/labels/label-picker"
import { useMediaGallery } from "@/contexts"
import { useFormattedDate } from "@/hooks/use-formatted-date"
import { useLongPress } from "@/hooks/use-long-press"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { useTouchCapable } from "@/hooks/use-touch-capable"
import { useIsMobile } from "@/hooks/use-mobile"
import { useMessageReactions, stripColons, reactionShortcodes } from "@/hooks/use-message-reactions"
import { useSavedForMessage, useSaveMessage, useDeleteSaved } from "@/hooks/use-saved"
import { useSettleConversationMessage } from "@/hooks/use-conversations"
import { useBoardScopeDraftIndex, useBoardSubtopicDraftIndex } from "@/hooks"
import { boardBranchReplyDraftKey } from "@/lib/board/draft-keys"
import { leadLine, rowArtifacts } from "@/lib/board/ledger"
import { resolveInternalAppPath } from "@/lib/internal-url"
import { getInitials } from "@/lib/initials"
import { cn } from "@/lib/utils"

const TOMBSTONE_LEAD = "This message was deleted"
const EMPTY_LEAD = "(no text)"
/** Window after a long press in which the synthetic click it produces is ignored. */
const SYNTHETIC_CLICK_SUPPRESS_MS = 700

interface LedgerRowProps {
  workspaceId: string
  streamId: string
  message: RenderableMessage
  authorName: string
  currentUserId: string | null
  expanded: boolean
  onToggle: () => void
  /** Tints the row's left rail — the reader hasn't seen this one yet. */
  unread?: boolean
  /** Lead-line budget in characters (the user's ledger density preference). */
  leadLineLength: number
  conversationId: string
  conversationRootStreamId: string
  onNewSubtopic?: () => void
  onMoveToSubtopic?: () => void
  /** Nested-branch placement: the row indents and drops its own left rail width. */
  indent?: "branch"
}

/**
 * One ledger line: a message compressed to a single row — actor glyph, lead
 * line, artifact chips, time — that expands in place into the full
 * {@link MessageItem} (same body, same action surface, same reactions). The
 * collapsed row keeps the message's action surface through the SAME components
 * the timeline and card rows use (`MessageContextMenu` / `MessageActionDrawer`
 * over one `MessageActionContext`), so nothing is a ledger-only affordance.
 *
 * Expansion grows downward only — the header strip occupies the collapsed row's
 * own line — so nothing above the row moves (INV-21).
 */
export function LedgerRow({
  workspaceId,
  streamId,
  message,
  authorName,
  currentUserId,
  expanded,
  onToggle,
  unread,
  leadLineLength,
  conversationId,
  conversationRootStreamId,
  onNewSubtopic,
  onMoveToSubtopic,
  indent,
}: LedgerRowProps) {
  const { formatTime, formatFull } = useFormattedDate()
  const { openMedia } = useMediaGallery()
  const touchCapable = useTouchCapable()
  // One signal for both the menu trigger's visibility and the right-click branch
  // that anchors to it — matches the `sm:` breakpoint the cluster used to hide at.
  const narrow = useIsMobile()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [labelPickerOpen, setLabelPickerOpen] = useState(false)
  const [reminderSheetOpen, setReminderSheetOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)

  const theme = actorRowTheme(message.authorType)
  const tombstone = Boolean(message.deletedAt)
  const sentAt = useMemo(() => new Date(message.createdAt), [message.createdAt])
  const artifacts = rowArtifacts(message)
  // The URL behind `firstLinkLabel`. `rowArtifacts` returns the label only, so
  // the preview is re-selected here with its own predicate — keep the two in
  // step if the selection ever changes.
  const linkPreview = artifacts.firstLinkLabel
    ? (message.linkPreviews ?? []).find((p) => p.contentType !== LinkPreviewContentTypes.STREAM_LINK)
    : undefined
  const firstAttachment = message.attachments?.[0] ?? null
  const settling = Boolean(message.settling) && !tombstone

  const { toEmoji } = useWorkspaceEmoji(workspaceId)
  const lead = tombstone ? TOMBSTONE_LEAD : ledgerLead(message.contentMarkdown, leadLineLength, artifacts, toEmoji)

  // The whole collapsed row is one <button> (tap = expand, Enter/Space = expand),
  // so deferring to interactive descendants would kill long-press everywhere on
  // the row. Defer to real links only — the link chip keeps the browser's native
  // "Copy link" menu — and swallow the synthetic click that follows the hold so
  // the drawer doesn't also expand the row.
  // A time window, not a one-shot latch: an iOS hold that produces no synthetic
  // click (drawer dismissed, touchcancel, scroll-away) would leave a boolean
  // latched and swallow the next real tap.
  const suppressClicksUntilRef = useRef(0)
  const clickSuppressed = useCallback(() => Date.now() < suppressClicksUntilRef.current, [])
  const openDrawer = useCallback(() => {
    suppressClicksUntilRef.current = Date.now() + SYNTHETIC_CLICK_SUPPRESS_MS
    setDrawerOpen(true)
  }, [])
  const longPress = useLongPress({
    onLongPress: openDrawer,
    enabled: touchCapable && !tombstone,
    deferToNativeLinks: true,
  })
  const handleToggle = useCallback(() => {
    if (clickSuppressed()) return
    onToggle()
  }, [clickSuppressed, onToggle])

  // Reactions, save, reminder and label are the collapsed row's own state; every
  // other entry the menu shows is derived from the context below, exactly as on
  // the full row.
  const { toggleByEmoji } = useMessageReactions(workspaceId, message.id)
  const handleAddReaction = useCallback(
    (emoji: string) => toggleByEmoji(emoji, message.reactions, currentUserId),
    [toggleByEmoji, message.reactions, currentUserId]
  )
  const activeReactionShortcodes = useMemo(() => {
    if (!currentUserId) return new Set<string>()
    const active = new Set<string>()
    for (const [shortcode, userIds] of Object.entries(message.reactions)) {
      if (userIds.includes(currentUserId)) active.add(stripColons(shortcode))
    }
    return active
  }, [currentUserId, message.reactions])
  const allReactionShortcodes = useMemo(() => reactionShortcodes(message.reactions), [message.reactions])

  const savedForMessage = useSavedForMessage(workspaceId, message.id)
  const saveMessageMutation = useSaveMessage(workspaceId)
  const unsaveMessageMutation = useDeleteSaved(workspaceId)
  const isSaved = !!savedForMessage && savedForMessage.status === "saved"
  const handleToggleSave = useCallback(() => {
    if (saveMessageMutation.isPending || unsaveMessageMutation.isPending) return
    if (!savedForMessage || savedForMessage.status !== "saved") {
      saveMessageMutation.mutate(
        { messageId: message.id, conversationId },
        { onError: () => toast.error("Could not save message") }
      )
      return
    }
    unsaveMessageMutation.mutate(savedForMessage.id, { onError: () => toast.error("Could not remove saved item") })
  }, [savedForMessage, saveMessageMutation, unsaveMessageMutation, message.id, conversationId])

  // The settling pair, exactly as the full row derives it: wired only while the
  // row is still settling, and "Not this topic…" reuses the move picker rather
  // than adding a second entry for the same dialog (INV-35).
  const settleMessage = useSettleConversationMessage(workspaceId, conversationRootStreamId)
  const isSettling = Boolean(message.settling && conversationId)
  const handleKeepInConversation = useCallback(() => {
    if (settleMessage.isPending) return
    settleMessage.mutate(
      { messageId: message.id, conversationId },
      { onError: () => toast.error("Couldn't confirm the message. Please try again.") }
    )
  }, [settleMessage, conversationId, message.id])

  const menuContext: MessageActionContext = {
    contentMarkdown: message.contentMarkdown,
    actorType: message.authorType,
    authorId: message.authorId,
    currentUserId: currentUserId ?? undefined,
    isThreadParent: true,
    replyUrl: "",
    messageId: message.id,
    workspaceId,
    streamId,
    conversationId,
    reactions: message.reactions,
    editedAt: message.editedAt ?? undefined,
    // Defer so the closing menu/drawer doesn't fight the dialog open (as MessageItem).
    onShowHistory: () => setTimeout(() => setHistoryOpen(true), 0),
    onReact: handleAddReaction,
    onOpenFullPicker: () => setPickerOpen(true),
    isSaved,
    onToggleSave: handleToggleSave,
    onRequestReminder: () => setReminderSheetOpen(true),
    onLabelMessage: () => setLabelPickerOpen(true),
    onNewSubtopic,
    onMoveToSubtopic: isSettling ? undefined : onMoveToSubtopic,
    onKeepInConversation: isSettling ? handleKeepInConversation : undefined,
    onNotThisTopic: isSettling ? onMoveToSubtopic : undefined,
  }

  const overlays = tombstone ? null : (
    <>
      {touchCapable && (
        <MessageActionDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          context={menuContext}
          authorName={authorName}
        />
      )}
      {labelPickerOpen && (
        <LabelPicker
          workspaceId={workspaceId}
          resourceType={LabelableResourceTypes.MESSAGE}
          resourceId={message.id}
          open={labelPickerOpen}
          onOpenChange={setLabelPickerOpen}
        />
      )}
      {reminderSheetOpen && (
        <ReminderPickerSheet
          open={reminderSheetOpen}
          onOpenChange={setReminderSheetOpen}
          workspaceId={workspaceId}
          messageId={message.id}
          conversationId={conversationId}
          saved={savedForMessage ?? null}
        />
      )}
      {historyOpen && (
        <MessageHistoryDialog
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          messageId={message.id}
          workspaceId={workspaceId}
          messageCreatedAt={String(message.createdAt)}
          currentContent={{
            contentMarkdown: message.contentMarkdown,
            editedAt: message.editedAt ?? undefined,
          }}
        />
      )}
      {pickerOpen && (
        <ReactionEmojiPicker
          workspaceId={workspaceId}
          onSelect={handleAddReaction}
          activeShortcodes={activeReactionShortcodes}
          allReactionShortcodes={allReactionShortcodes}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
        />
      )}
    </>
  )

  const railClassName = cn(
    "border-l-2 pl-2",
    unread ? "border-destructive/70" : "border-muted-foreground/20",
    indent === "branch" && "ml-3"
  )

  const glyph = (
    <span
      aria-hidden
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-full bg-muted text-[9px] font-semibold",
        theme.nameClassName
      )}
    >
      {getInitials(authorName).slice(0, 1)}
    </span>
  )

  const time = (
    <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70" title={formatFull(sentAt)}>
      {formatTime(sentAt)}
    </span>
  )

  if (expanded) {
    // A colored actor (persona gold / bot green / system) colorizes the LEDGER
    // RAIL beside its body — the branch-rows idiom: its 2px border overlays the
    // wrapper's neutral rail at the same x (`-ml-2.5` = border + pl-2), content
    // re-padded (`pl-2`) so the avatar sits off the rail, and the row's own
    // inner accent stripe is suppressed (flush-against-the-avatar was the bug).
    // A user row stays plain, so the neutral rail shows through.
    const actorRail = theme.railClassName
    return (
      <div className={railClassName}>
        {/* Minimize strip: the collapsed row's own line, so the body grows below
            it and nothing above the row moves (INV-21). */}
        <div className="flex items-center gap-2 py-0.5">
          {glyph}
          {time}
          <button
            type="button"
            onClick={onToggle}
            aria-label="Collapse message"
            className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronUp className="size-3.5" />
          </button>
        </div>
        <MessageItem
          workspaceId={workspaceId}
          streamId={streamId}
          message={message}
          authorName={authorName}
          currentUserId={currentUserId}
          conversationId={conversationId}
          conversationRootStreamId={conversationRootStreamId}
          onNewSubtopic={onNewSubtopic}
          onMoveToSubtopic={onMoveToSubtopic}
          suppressRowAccent
          surfaceClassName={actorRail ? cn("bg-card border-l-2 pl-2", actorRail) : undefined}
          rowInsetClassName={actorRail ? "-ml-2.5" : undefined}
        />
      </div>
    )
  }

  return (
    <div
      data-ledger-row=""
      data-message-id={message.id}
      data-settling={settling ? "" : undefined}
      className={cn(
        "reveal-host group relative flex items-center gap-2 py-0.5 transition-opacity duration-300",
        railClassName,
        // Provisional placement wears the same texture as the full row: muted
        // content plus the always-mounted dashed rail below (INV-21).
        settling && "opacity-70"
      )}
      onContextMenu={
        tombstone
          ? undefined
          : (e) => {
              if (touchCapable) {
                longPress.handlers.onContextMenu(e)
                return
              }
              // The menu's trigger is the same cluster hidden below `sm`;
              // anchoring Radix to a zero-rect trigger would put the menu in the
              // corner, so narrow non-touch keeps the browser's native menu.
              if (narrow) return
              e.preventDefault()
              setMenuOpen(true)
            }
      }
      {...(touchCapable && !tombstone
        ? {
            onTouchStart: longPress.handlers.onTouchStart,
            onTouchMove: longPress.handlers.onTouchMove,
            onTouchEnd: longPress.handlers.onTouchEnd,
            onTouchCancel: longPress.handlers.onTouchCancel,
          }
        : {})}
    >
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 w-0 border-l-[2px] border-dashed transition-colors duration-300",
          settling ? "border-muted-foreground/40" : "border-transparent"
        )}
      />
      {settling && <span className="sr-only">Still settling — this message may move to another topic</span>}
      {tombstone ? (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {glyph}
          <span className="min-w-0 flex-1 truncate text-xs italic text-muted-foreground">{lead}</span>
        </div>
      ) : (
        // Text only — the chips beside it are their own controls, so the row's
        // expand button never nests an interactive element.
        <button
          type="button"
          onClick={handleToggle}
          aria-expanded={false}
          className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {glyph}
          <span className="sr-only">{authorName}: </span>
          <span className="min-w-0 flex-1 truncate text-xs text-foreground/85">{lead}</span>
        </button>
      )}
      {!tombstone && artifacts.attachmentCount > 0 && firstAttachment && (
        <button
          type="button"
          onClick={() => {
            // The hold that opened the drawer bubbled from this chip, so the
            // synthetic click that follows must open nothing at all — gallery
            // included, not just the expand.
            if (clickSuppressed()) return
            // The gallery lives in the expanded row's `AttachmentList` (the one
            // attachment-open path); expanding is what mounts it. A file the
            // gallery can't open (a zip, an installer) only expands — writing
            // `?media=` for it would leave a param nothing claims, which breaks
            // the NEXT gallery open's history.
            handleToggle()
            if (isGalleryPreviewableAttachment(firstAttachment)) openMedia(firstAttachment.id)
          }}
          aria-label={`Open ${artifacts.attachmentCount} attachment${artifacts.attachmentCount === 1 ? "" : "s"}`}
          className="flex shrink-0 items-center gap-0.5 rounded px-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <Paperclip className="size-3" />
          {artifacts.attachmentCount}
        </button>
      )}
      {!tombstone && linkPreview && artifacts.firstLinkLabel && (
        <LedgerLinkChip url={linkPreview.url} label={artifacts.firstLinkLabel} />
      )}
      {time}
      {!tombstone && (
        <div className={cn("reveal-actions-hover-only shrink-0", narrow ? "hidden" : "block")}>
          <MessageContextMenu context={menuContext} open={menuOpen} onOpenChange={setMenuOpen} />
        </div>
      )}
      {overlays}
    </div>
  )
}

/**
 * A whole sub-conversation compressed to one ledger line: the branch's name, how
 * many messages it holds, and the OUTCOME lead — the lead line of its LAST
 * message, which is what the reader wants from a branch they aren't in. Expands
 * in place into the branch's full rendering (rows, rails, overflow link, reply
 * affordance), same a11y contract as {@link LedgerRow}.
 */
export function LedgerBranchRow({
  workspaceId,
  title,
  conversationIds,
  messageIds,
  messageCount,
  lastMessage,
  leadLineLength,
  settling,
  onToggle,
}: {
  workspaceId: string
  title: string
  /** The branch's conversation id AND every descendant's — their tail reply draft
   *  scopes. Collapse hides the whole subtree, so the row speaks for all of it. */
  conversationIds: string[]
  /** The rendered message ids of the branch and its descendants — their sub-topic
   *  draft scopes. */
  messageIds: string[]
  messageCount: number
  /** The branch's newest locally-known message — the outcome lead. */
  lastMessage: RenderableMessage | null
  leadLineLength: number
  settling: boolean
  onToggle: () => void
}) {
  const { toEmoji } = useWorkspaceEmoji(workspaceId)
  // An unsent draft inside the branch (its tail reply, or a sub-topic gesture on
  // one of its messages) is invisible once the branch folds, so the collapsed row
  // carries the same Pencil marker `CollapsedComposerBar` uses. Presence only —
  // it never pins the branch open; tapping the row expands as normal.
  const scopeDrafts = useBoardScopeDraftIndex(workspaceId)
  const subtopicDrafts = useBoardSubtopicDraftIndex(workspaceId)
  const hasDraft =
    conversationIds.some((id) => scopeDrafts.has(boardBranchReplyDraftKey(id))) ||
    messageIds.some((id) => subtopicDrafts.has(id))
  let lead: string | null = null
  if (lastMessage) {
    lead = lastMessage.deletedAt
      ? TOMBSTONE_LEAD
      : ledgerLead(lastMessage.contentMarkdown, leadLineLength, rowArtifacts(lastMessage), toEmoji)
  }
  return (
    // `mt-3` and nothing else: the expanded BranchGroup's wrapper is the same, so
    // the branch's leading edge holds still across a collapse/expand toggle.
    <div className="mt-3" data-ledger-branch-row="" data-settling={settling ? "" : undefined}>
      {/* Outside the button: an `aria-label` overrides the element's content, so
          an sr-only span INSIDE it is never announced (as the message row does). */}
      {settling && <span className="sr-only">Still settling — messages here may move to another topic</span>}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={false}
        aria-label={`${title}, ${messageCount} ${messageCount === 1 ? "message" : "messages"}${
          settling ? ", still settling" : ""
        }${hasDraft ? ", unsent draft" : ""}`}
        className={cn(
          "relative flex w-full items-center gap-2 rounded border-l-2 border-muted-foreground/20 py-0.5 pl-2 text-left transition-opacity duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          settling && "opacity-70"
        )}
      >
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-y-0 left-0 w-0 border-l-[2px] border-dashed transition-colors duration-300",
            settling ? "border-muted-foreground/40" : "border-transparent"
          )}
        />
        <CornerDownRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="max-w-[45%] shrink truncate text-xs font-medium text-foreground/75">{title}</span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">{messageCount}</span>
        {lead && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{lead}</span>}
        {hasDraft && (
          <span
            aria-hidden
            data-branch-draft-chip=""
            className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground"
          >
            <Pencil className="size-3 shrink-0" />
            Draft
          </span>
        )}
      </button>
    </div>
  )
}

/** The collapsed lead, with the artifact-only and empty fallbacks. */
function ledgerLead(
  contentMarkdown: string,
  leadLineLength: number,
  artifacts: { attachmentCount: number },
  toEmoji?: (shortcode: string) => string | null
): string {
  const lead = leadLine(contentMarkdown, leadLineLength, toEmoji)
  if (lead) return lead
  if (artifacts.attachmentCount > 0) return `📎 ${artifacts.attachmentCount}`
  return EMPTY_LEAD
}

/**
 * The link artifact chip — a real anchor (so middle-click/copy-link work), with
 * same-origin targets routed through the router instead of a full page load
 * (the shared `resolveInternalAppPath` path).
 */
function LedgerLinkChip({ url, label }: { url: string; label: string }) {
  const navigate = useNavigate()
  const internalPath = resolveInternalAppPath(url)
  return (
    <a
      href={internalPath ?? url}
      {...(internalPath
        ? {
            onClick: (e: MouseEvent<HTMLAnchorElement>) => {
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
              e.preventDefault()
              navigate(internalPath)
            },
          }
        : { target: "_blank", rel: "noreferrer" })}
      className="flex max-w-[10rem] shrink-0 items-center gap-0.5 rounded px-1 text-[10px] text-muted-foreground no-underline transition-colors hover:text-foreground"
    >
      <Link2 className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </a>
  )
}

/**
 * A non-message ledger line (agent session, memo capture, call…): hair-thin,
 * muted, tighter than a message row so the eye skips it unless it's looking.
 * Purely presentational — the surface supplies the icon, label and meta.
 */
export function LedgerEventRow({
  icon,
  label,
  meta,
  href,
  onOpen,
  onToggle,
  expanded,
}: {
  icon: ReactNode
  label: string
  meta?: string
  /** The kind's own detail target — the row navigates instead of toggling (INV-40). */
  href?: string
  /** Opens the kind's in-place preview (a dialog) instead of navigating. */
  onOpen?: () => void
  onToggle?: () => void
  expanded?: boolean
}) {
  const content = (
    <>
      <span aria-hidden className="flex size-3 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="min-w-0 truncate">{label}</span>
      {meta && <span className="shrink-0 text-muted-foreground/70">· {meta}</span>}
    </>
  )
  // The text stays hair-thin (`text-xs`); an interactive row grows only its
  // PADDING, so its hit area matches a message ledger row's instead of the ~18px
  // a `py-px` line leaves for a thumb.
  const className = "flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground"
  const interactive = cn(className, "py-0.5")
  if (href)
    return (
      <Link to={href} className={cn(interactive, "no-underline transition-colors hover:text-foreground")}>
        {content}
      </Link>
    )
  if (onOpen)
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="dialog"
        className={cn(interactive, "transition-colors hover:text-foreground")}
      >
        {content}
      </button>
    )
  if (!onToggle) return <div className={cn(className, "py-px")}>{content}</div>
  return (
    <button type="button" onClick={onToggle} aria-expanded={expanded ?? false} className={interactive}>
      {content}
    </button>
  )
}

export interface LedgerEventDescriptor {
  key: string
  icon: ReactNode
  label: string
  meta?: string
  href?: string
  onOpen?: () => void
}

/**
 * A coalesced run of events (the `coalesceLedgerItems` grouping): one thin
 * summary row that expands in place into the individual rows and re-coalesces
 * on a second tap.
 *
 * Expansion is the surface's state, not the group's: the card holds one ledger
 * expansion set for message leads, branches and event groups alike, so it
 * resets on conversation switch with them.
 */
export function LedgerEventGroup({
  events,
  expanded,
  onToggle,
}: {
  events: LedgerEventDescriptor[]
  expanded: boolean
  onToggle: () => void
}) {
  const toggle = onToggle
  if (expanded) {
    // The summary row stays: an expanded row carries its OWN tap affordance (a
    // capture's memo link, a session's trace), so the way back has to be a
    // control of its own rather than "tap any row".
    return (
      <div>
        <LedgerEventRow
          icon={<ChevronDown className="size-3" />}
          label={`${events.length} events`}
          onToggle={toggle}
          expanded
        />
        {events.map((event) => (
          <LedgerEventRow
            key={event.key}
            icon={event.icon}
            label={event.label}
            meta={event.meta}
            href={event.href}
            onOpen={event.onOpen}
          />
        ))}
      </div>
    )
  }
  return (
    <LedgerEventRow
      icon={<ChevronRight className="size-3" />}
      label={`${events.length} events — ${events.map((e) => e.label).join(" · ")}`}
      onToggle={toggle}
      expanded={false}
    />
  )
}
