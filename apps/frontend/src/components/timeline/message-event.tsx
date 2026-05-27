import { type ReactNode, useRef, useEffect, useState, useMemo, useCallback } from "react"
import {
  isSentViaApi,
  type StreamEvent,
  type AttachmentSummary,
  type JSONContent,
  type LinkPreviewSummary,
  type ThreadSummary,
  type MovedFromProvenance,
} from "@threa/types"
import { toast } from "sonner"
import { enqueueOperation } from "@/sync/operation-queue"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { MarkdownContent, AttachmentProvider } from "@/components/ui/markdown-content"
import { MessageContextBadge } from "@/components/composer"
import { RelativeTime } from "@/components/relative-time"
import { ActorAvatar } from "@/components/actor-avatar"
import { usePendingMessages, usePanel, createDraftPanelId, useTrace, useMessageService } from "@/contexts"
import { useUserProfile } from "@/components/user-profile"
import { useFormattedDate } from "@/hooks/use-formatted-date"
import { useMessageMarkdownCopy } from "@/hooks/use-message-markdown-copy"
import { useDecryptedMessageContent, type DecryptedMessageContent } from "@/hooks/use-decrypted-message-content"
import { useEditLastMessage } from "./edit-last-message-context"
import {
  useActors,
  useMovedTombstone,
  useWorkspaceUserId,
  useMessageReactions,
  stripColons,
  reactionShortcodes,
  focusAtEnd,
  type MessageAgentActivity,
} from "@/hooks"
import { Quote, MessageSquareReply, Check } from "lucide-react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-mobile"
import { useLongPress } from "@/hooks/use-long-press"
import { AttachmentList } from "./attachment-list"
import { LinkPreviewList } from "./link-preview-list"
import { LinkPreviewProvider, useLinkPreviewContext } from "@/lib/markdown/link-preview-context"
import { MessageContextMenu } from "./message-context-menu"
import { SaveMessageButton } from "./save-message-button"
import { ReminderPickerSheet } from "./reminder-picker-sheet"
import { useSavedForMessage, useSaveMessage, useDeleteSaved } from "@/hooks/use-saved"
import { useDiscussWithAriadne } from "@/hooks/use-discuss-with-ariadne"
import { MessageActionDrawer } from "./message-action-drawer"
import { ThreadSlot } from "./thread-slot"
import { DeleteMessageDialog } from "./delete-message-dialog"
import { MessageEditForm } from "./message-edit-form"
import { UnsentMessageEditForm } from "./unsent-message-edit-form"
import { UnsentMessageActionDrawer } from "./unsent-message-action-drawer"
import { EditedIndicator } from "./edited-indicator"
import { MovedFromIndicator } from "./moved-from-indicator"
import { MovedMessagesDrawer } from "./moved-messages-drawer"
import { SavedIndicator } from "@/components/saved/saved-indicator"
import { MessageHistoryDialog } from "./message-history-dialog"
import { MessageReactions } from "./message-reactions"
import { ReactionEmojiPicker } from "./reaction-emoji-picker"
import { useQuoteReply } from "./quote-reply-context"
import { useSwipeAction } from "@/hooks/use-swipe-action"
import { useStreamFromStore } from "@/stores/stream-store"
import { queueShareHandoff } from "@/stores/share-handoff-store"
import { navigateAfterShareHandoff } from "@/lib/share-navigation"
import { ShareMessageModal } from "@/components/share/share-message-modal"
import { useIsOnline } from "@/components/layout/connection-status"
import type { BatchTimelineState } from "./event-list"
import { dispatchStartBatchSelect } from "@/lib/batch-selection-events"

const SLOW_SEND_THRESHOLD_MS = 5000

interface MessagePayload {
  messageId: string
  contentMarkdown: string
  contentJson?: JSONContent
  attachments?: AttachmentSummary[]
  linkPreviews?: LinkPreviewSummary[]
  replyCount?: number
  threadId?: string
  /**
   * Aggregated latest-reply preview + participants. Populated by bootstrap
   * enrichment for messages with ≥1 non-deleted reply. Consumed by ThreadCard.
   */
  threadSummary?: ThreadSummary
  sessionId?: string
  editedAt?: string
  sentVia?: string
  reactions?: Record<string, string[]>
  /**
   * Stamped onto the relocated `message_created` payload by the move flow.
   * Surfaces a small "moved from #X" indicator alongside the timestamp so
   * scrollers-by can see this message wasn't authored in this stream. We
   * keep only the most recent move — re-moves overwrite earlier provenance.
   */
  movedFrom?: MovedFromProvenance
}

interface MessageEventProps {
  event: StreamEvent
  workspaceId: string
  streamId: string
  /** This message is the thread parent shown at the top of the thread panel */
  isThreadParent?: boolean
  /** Whether to highlight this message (scroll into view and flash) */
  isHighlighted?: boolean
  /** Whether this message just arrived via socket (brief subtle indicator) */
  isNew?: boolean
  /** Active agent session triggered by this message */
  activity?: MessageAgentActivity
  /** Defer non-critical per-message hydration until coordinated reveal completes */
  deferSecondaryHydration?: boolean
  /**
   * When true, render as a same-author continuation: drop the header row,
   * show only the gutter micro-time and body. `MessageLayout` ignores this
   * in pending/failed/editing states so those always render with a full
   * header.
   */
  groupContinuation?: boolean
  /**
   * True when this is the first message in the stream. Anchors the
   * `<MessageContextBadge>` for bag-attached scratchpads — same UX pattern
   * as a file-attachment chip that lived on the composer pre-send and now
   * lives on the message that "carried" it.
   */
  isFirstMessage?: boolean
  batch?: BatchTimelineState
}

interface MessageLayoutProps {
  event: StreamEvent
  payload: MessagePayload
  workspaceId: string
  streamId: string
  actorName: string
  /** True when this is the first message in the stream — renders `<MessageContextBadge>` for bag-attached scratchpads. */
  isFirstMessage?: boolean
  /** Persona slug for SVG icon support (e.g., "ariadne") */
  /** User avatar image URL */
  statusIndicator: ReactNode
  /**
   * Inline action buttons rendered in the header row (pending/failed/editing
   * states). Suppressed on continuations, where the header row is collapsed.
   * Desktop hover actions for sent messages live in `hoverActions` instead.
   */
  actions?: ReactNode
  /**
   * Absolute-positioned hover toolbar for sent messages. Floated above the
   * message row so it works identically on heads and continuations without
   * competing with inline layout. Renderer hides on touch devices.
   */
  hoverActions?: ReactNode
  footer?: ReactNode
  children?: ReactNode
  containerClassName?: string
  isHighlighted?: boolean
  isNew?: boolean
  isEditing?: boolean
  /**
   * Render as a same-author continuation: no header row, 32px gutter column
   * holding a compact HH:mm stamp instead of the avatar. Ignored when the
   * layout is already in edit mode (the edit form needs its full column).
   */
  isGroupContinuation?: boolean
  containerRef?: React.RefObject<HTMLDivElement | null>
  deferSecondaryHydration?: boolean
  /** Touch event handlers for mobile long-press */
  touchHandlers?: {
    onTouchStart: (e: React.TouchEvent) => void
    onTouchEnd: () => void
    onTouchMove: (e: React.TouchEvent) => void
    onContextMenu: (e: React.MouseEvent) => void
  }
  /** Horizontal swipe offset for mobile swipe-to-quote (px, negative = left) */
  swipeOffset?: number
  /** Whether swipe has passed the threshold */
  swipeLocked?: boolean
  batch?: BatchTimelineState
}

function focusVisibleZoneEditor(zone: HTMLElement | null, attempt = 0) {
  if (!zone) return

  const editor = Array.from(zone.querySelectorAll<HTMLElement>('[contenteditable="true"]'))
    .filter((element) => !element.closest("[data-inline-edit]"))
    .reduceRight<HTMLElement | null>((match, element) => {
      if (match) return match
      return element.getClientRects().length > 0 ? element : null
    }, null)

  if (editor) {
    focusAtEnd(editor)
    return
  }

  if (attempt >= 4) return
  requestAnimationFrame(() => focusVisibleZoneEditor(zone, attempt + 1))
}

/** Reads hovered link URL from context and passes to LinkPreviewList */
function MessageLinkPreviews({
  messageId,
  workspaceId,
  previews,
  hydrateFromApi,
}: {
  messageId: string
  workspaceId: string
  previews?: LinkPreviewSummary[]
  hydrateFromApi?: boolean
}) {
  const linkPreviewContext = useLinkPreviewContext()
  return (
    <LinkPreviewList
      messageId={messageId}
      workspaceId={workspaceId}
      previews={previews}
      hoveredUrl={linkPreviewContext?.hoveredLinkUrl}
      hydrateFromApi={hydrateFromApi}
    />
  )
}

/**
 * Per-actor-type row styling. Each entry is the single source of truth for
 * how a message from that actor type looks: the row accent gradient + inset
 * stripe, the author-name color, and an optional inline header badge.
 * Adding a new actor type means adding one entry here — no scattered
 * `isPersona && ... || isBot && ...` chains to keep in sync.
 */
interface ActorRowTheme {
  /** Row-level accent gradient + inset-stripe shadow; empty string = no accent. */
  rowAccent: string
  /** Color class applied to the author-name element. Empty = inherit. */
  nameClassName: string
  /** Optional inline pill rendered in the header row after the author name. */
  badge: ReactNode | null
}

const ACTOR_ROW_THEME: Record<NonNullable<StreamEvent["actorType"]>, ActorRowTheme> = {
  user: {
    rowAccent: "",
    nameClassName: "",
    badge: null,
  },
  persona: {
    rowAccent: "bg-gradient-to-r from-primary/[0.06] to-transparent shadow-[inset_3px_0_0_hsl(var(--primary))]",
    nameClassName: "text-primary",
    badge: null,
  },
  bot: {
    rowAccent: "bg-gradient-to-r from-emerald-500/[0.06] to-transparent shadow-[inset_3px_0_0_hsl(152_69%_41%)]",
    nameClassName: "text-emerald-600",
    badge: <span className="text-[10px] text-emerald-600/70 font-medium cursor-default">BOT</span>,
  },
  system: {
    rowAccent: "bg-gradient-to-r from-blue-500/[0.04] to-transparent shadow-[inset_3px_0_0_hsl(210_100%_55%)]",
    nameClassName: "text-blue-500",
    badge: null,
  },
}

/**
 * Avatar-as-toggle for batch-selection mode (Gmail Android pattern).
 *
 * The avatar is the leading slot for non-continuation rows; in batch mode it
 * doubles as the per-message selection control. To avoid a "cheap" stacked
 * look, we never blend layers via transparency — the avatar and the check
 * circle each toggle their own `display`, so only one is in the DOM flow at
 * any given (row-state, hover-state) combination. Three states:
 *
 * - rest (unselected, no group-hover) → avatar visible
 * - group-hover (unselected) → outline-only check circle (primary border on
 *   transparent fill — reads as "preview before you click")
 * - checked → solid primary fill with white check
 *
 * The hover→checked transition is a `bg/text-color` change on the same
 * element so it animates smoothly; the rest↔hover swap is instant (display
 * none/grid) which reads as snappy rather than draggy. The whole row still
 * toggles on click via `MessageLayout`'s `onClick`; this component is a
 * visual affordance, not its own button.
 */
function BatchSelectionAvatar({
  selected,
  actorId,
  actorType,
  workspaceId,
  alt,
}: {
  selected: boolean
  actorId: string | null | undefined
  actorType?: StreamEvent["actorType"]
  workspaceId: string
  alt: string
}) {
  // Wrapper has to match ActorAvatar size="md" exactly (h-8 w-8) — anything
  // bigger leaves a gap around the inner avatar and clips its corners. We
  // also intentionally don't add `rounded-full overflow-hidden` here: that
  // would force image avatars into circles, hiding the rounded-square shape
  // ActorAvatar actually uses for "md". The check overlay matches that
  // `rounded-[8px]` so rest↔selected is a clean color swap, not a shape
  // morph. Shadcn's AvatarFallback is `rounded-full` which makes initials
  // read as a circle inside the outer rounded square; we accept the small
  // visual difference between fallback (circle) and image (rounded square)
  // because that's the existing app-wide behavior, not something this
  // component should paper over.
  return (
    <div
      data-batch-control
      data-state={selected ? "checked" : "unchecked"}
      className="message-avatar relative h-8 w-8 shrink-0 select-none"
    >
      <div aria-hidden={selected} className={cn("absolute inset-0", selected ? "hidden" : "block group-hover:hidden")}>
        <ActorAvatar
          actorId={actorId ?? null}
          actorType={actorType ?? null}
          workspaceId={workspaceId}
          size="md"
          alt={alt}
        />
      </div>
      <div
        aria-hidden={!selected}
        className={cn(
          "absolute inset-0 place-content-center rounded-[8px] transition-colors duration-150",
          selected
            ? "grid bg-primary text-primary-foreground shadow-sm"
            : "hidden group-hover:grid border-2 border-primary bg-primary/5 text-primary"
        )}
      >
        <Check className="h-4 w-4" strokeWidth={3} />
      </div>
    </div>
  )
}

/** Render the batch-mode replacement for the leading slot, or the slot itself. */
function renderBatchLeading(
  batchEnabled: boolean,
  isContinuation: boolean,
  args: {
    selected: boolean
    actorId: string | null | undefined
    actorType?: StreamEvent["actorType"]
    workspaceId: string
    alt: string
    fallback: ReactNode
  }
): ReactNode {
  if (!batchEnabled) return args.fallback
  if (isContinuation) return <BatchSelectionDot selected={args.selected} />
  return (
    <BatchSelectionAvatar
      selected={args.selected}
      actorId={args.actorId}
      actorType={args.actorType}
      workspaceId={args.workspaceId}
      alt={args.alt}
    />
  )
}

/**
 * Selection dot for continuations — the "twist" on Gmail's avatar-as-toggle.
 *
 * Author-grouped continuations don't render an avatar (the head row carries
 * it), so there's nothing to morph into a checkmark. We instead render a
 * compact 14px outline circle inside the same `h-5 w-8` gutter that normally
 * holds the on-hover HH:MM micro-time. Same column width, same vertical
 * alignment, no row height change. Outline → primary on group-hover, filled
 * on selection. Sits flush right inside the gutter so it lines up vertically
 * with the head row's avatar above it, giving the column a consistent
 * "selection rail" while batch mode is active.
 */
function BatchSelectionDot({ selected }: { selected: boolean }) {
  return (
    <div
      data-batch-control
      data-state={selected ? "checked" : "unchecked"}
      className="message-avatar-spacer flex h-5 w-8 shrink-0 select-none items-center justify-end pr-1.5"
    >
      <span
        aria-hidden={!selected}
        className={cn(
          "grid h-3.5 w-3.5 place-content-center rounded-full border transition-all duration-150",
          selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/30 bg-transparent group-hover:border-primary/60 group-hover:bg-primary/10"
        )}
      >
        {selected && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
      </span>
    </div>
  )
}

function MessageLayout({
  event,
  payload,
  workspaceId,
  streamId,
  actorName,
  statusIndicator,
  actions,
  hoverActions,
  footer,
  children,
  containerClassName,
  isHighlighted,
  isNew,
  isEditing,
  isGroupContinuation,
  isFirstMessage,
  containerRef,
  deferSecondaryHydration,
  touchHandlers,
  swipeOffset,
  swipeLocked,
  batch,
}: MessageLayoutProps) {
  const theme = ACTOR_ROW_THEME[event.actorType ?? "user"]
  // Users with a resolved actorId get a clickable name that opens their
  // profile; everything else (personas, bots, system, unknown) renders a
  // non-interactive span with the theme's color. This is the only remaining
  // behavioral branch — all of the styling branches live in the theme map.
  const hasInteractiveName = event.actorType === "user" && event.actorId != null
  const { openUserProfile } = useUserProfile()
  const { formatTime, formatFull } = useFormattedDate()

  // Edit mode needs the full content column (author row + status indicator) so the
  // edit form's buttons have somewhere coherent to sit. Force head layout even
  // when the grouping pass marked this row as a continuation.
  const renderAsContinuation = isGroupContinuation && !isEditing

  const hasSwipe = swipeOffset !== undefined && swipeOffset !== 0
  // Make a whole-message native copy lossless: scope the listener to the
  // rendered markdown body only. A `select-all + Ctrl+C` over the markdown
  // text writes `contentMarkdown` instead of the rendered text (which has
  // stripped the structural quote:/shared-message:/attachment: URLs the
  // composer needs to reconstruct nodes on paste). Selections that escape
  // the markdown (into the attachment list, link previews, or another
  // message) fall through to the browser default — partial copies still
  // behave normally and the AttachmentList isn't part of `contentMarkdown`
  // anyway.
  const copyRef = useMessageMarkdownCopy(payload.contentMarkdown)
  const messageBody = children ?? (
    <LinkPreviewProvider>
      <AttachmentProvider workspaceId={workspaceId} attachments={payload.attachments ?? []}>
        <div ref={copyRef}>
          <MarkdownContent
            content={payload.contentMarkdown}
            messageId={payload.messageId}
            className="text-sm leading-relaxed"
          />
        </div>
        {payload.attachments && payload.attachments.length > 0 && (
          <AttachmentList
            attachments={payload.attachments}
            workspaceId={workspaceId}
            deferHydration={deferSecondaryHydration}
          />
        )}
        {isFirstMessage && <MessageContextBadge workspaceId={workspaceId} streamId={streamId} />}
        <MessageLinkPreviews
          messageId={payload.messageId}
          workspaceId={workspaceId}
          previews={payload.linkPreviews}
          hydrateFromApi={!deferSecondaryHydration}
        />
      </AttachmentProvider>
    </LinkPreviewProvider>
  )

  const sentAt = new Date(event.createdAt)
  const gutterLabel = formatTime(sentAt)
  const gutterTitle = formatFull(sentAt)

  // Everything that differs between head and continuation layouts is derived
  // upfront in a single place: the leading column (avatar vs gutter time),
  // the header row (full author/status/actions row vs nothing), the vertical
  // padding, and the row-level a11y attributes. The JSX body below consumes
  // these named locals so there's no scattered `renderAsContinuation ? : `
  // checks to keep in sync when either shape changes.
  const leadingSlot: ReactNode = renderAsContinuation ? (
    <div
      className={cn(
        "message-avatar-spacer flex h-5 w-8 shrink-0 items-start justify-end pr-1",
        "font-mono text-[10px] tabular-nums leading-5 text-muted-foreground/0 group-hover:text-muted-foreground/60 transition-colors"
      )}
      aria-label={`sent at ${gutterLabel}`}
      title={gutterTitle}
    >
      {gutterLabel}
    </div>
  ) : (
    <ActorAvatar
      actorId={event.actorId}
      actorType={event.actorType}
      workspaceId={workspaceId}
      size="md"
      alt={actorName}
      className="message-avatar"
    />
  )

  const headerRow: ReactNode = renderAsContinuation ? null : (
    <div className="flex items-baseline gap-2 mb-0.5">
      {hasInteractiveName ? (
        <button
          type="button"
          onClick={() => openUserProfile(event.actorId!)}
          className="font-semibold text-sm hover:underline text-left"
        >
          {actorName}
        </button>
      ) : (
        <span className={cn("font-semibold text-sm", theme.nameClassName)}>{actorName}</span>
      )}
      {theme.badge}
      {payload.sentVia && isSentViaApi(payload.sentVia) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-[10px] text-muted-foreground/70 font-medium cursor-default">via API</span>
          </TooltipTrigger>
          <TooltipContent>Sent on behalf of this user by an API key</TooltipContent>
        </Tooltip>
      )}
      {statusIndicator}
      {actions}
    </div>
  )

  // Row-level a11y + data attributes. Continuations collapse the visible
  // author row, so surface the author for screen readers via the row's
  // accessible name; heads already have a visible author label.
  const rowAriaLabel = renderAsContinuation ? `Message from ${actorName}` : undefined
  const rowDataGroupContinuation = renderAsContinuation ? "true" : undefined
  // Heads keep a generous top pad to separate groups visually, but a tight
  // bottom pad so the gap from the head body to the first continuation body
  // matches the cont-to-cont gap (4px). Without this, heads with a follow-up
  // continuation got 12px+2px = 14px below them and the first message in a
  // group felt detached. Group separation is preserved by the next head's
  // pt-3 (2px + 12px = 14px between groups, consistent regardless of whether
  // the previous group ended with a head or a continuation).
  const rowVerticalPadding = renderAsContinuation ? "py-0.5" : "pt-3 pb-0.5"
  const isSelected = batch?.selectedMessageIds.has(payload.messageId) ?? false
  const isInvalidTarget = batch?.invalidTargetIds.has(payload.messageId) ?? false
  const isHoveredTarget = batch?.hoveredTargetId === payload.messageId
  const batchEnabled = batch?.enabled ?? false

  const handleBatchToggle = useCallback(
    (event: React.MouseEvent | React.KeyboardEvent) => {
      if (!batchEnabled) return
      event.preventDefault()
      event.stopPropagation()
      batch?.onToggleMessage(payload.messageId)
    },
    [batch, batchEnabled, payload.messageId]
  )

  const handleBatchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!batchEnabled) return
      if (event.key === "Enter" || event.key === " ") {
        handleBatchToggle(event)
      }
    },
    [batchEnabled, handleBatchToggle]
  )

  return (
    <div
      ref={containerRef}
      data-author-name={actorName}
      data-message-id={payload.messageId}
      data-batch-invalid-target={isInvalidTarget ? "true" : undefined}
      data-author-id={event.actorId ?? ""}
      data-actor-type={event.actorType ?? "user"}
      data-group-continuation={rowDataGroupContinuation}
      // `overflow-hidden` contains the mobile swipe-to-quote translate so the
      // message doesn't bleed out of its bounds. On desktop swipe is disabled
      // and the hover toolbar floats above the row via `bottom-[calc(100%-20px)]`
      // — clipping there would cut the toolbar in half (it has nowhere else to
      // sit on tight continuations). `sm:overflow-visible` releases the clip
      // at the desktop breakpoint.
      className={cn("relative overflow-hidden sm:overflow-visible", containerClassName)}
      aria-label={rowAriaLabel}
      // Batch mode turns the whole row into a toggle. Keyboard users get
      // role="button" + tabIndex so they can Tab to messages, and Enter/Space
      // fire the same handler the click path uses. aria-pressed mirrors the
      // selection state so SR users hear "pressed" / "not pressed".
      role={batchEnabled ? "button" : undefined}
      tabIndex={batchEnabled ? 0 : undefined}
      aria-pressed={batchEnabled ? isSelected : undefined}
      onKeyDown={batchEnabled ? handleBatchKeyDown : undefined}
      {...touchHandlers}
      onClick={batchEnabled ? handleBatchToggle : undefined}
    >
      {/* Swipe-to-quote reveal icon (behind the message) */}
      {hasSwipe && (
        <div className="absolute inset-y-0 right-0 flex items-center pr-4">
          <Quote className={cn("h-5 w-5 transition-colors", swipeLocked ? "text-primary" : "text-muted-foreground")} />
        </div>
      )}
      <div
        className={cn(
          // Opaque background so swipe-to-quote icon shows behind the message
          "message-item group relative flex gap-3 px-3 sm:px-6 bg-background",
          rowVerticalPadding,
          // Per-actor accent (gradient + inset stripe) — see ACTOR_ROW_THEME.
          theme.rowAccent,
          // Edit mode: pseudo-element background so no layout shift — applied
          // only when the row doesn't already have an actor-accent gradient to
          // avoid stacking two backgrounds.
          isEditing &&
            !theme.rowAccent &&
            "before:content-[''] before:absolute before:-top-4 before:-bottom-4 before:left-0 before:right-0 before:bg-primary/[0.04] before:-z-10",
          isHighlighted && "animate-highlight-flash",
          isNew && !isHighlighted && "animate-new-message-fade",
          batchEnabled && "cursor-pointer select-none touch-none",
          batchEnabled && isSelected && "bg-primary/[0.07] ring-1 ring-primary/45 ring-inset",
          batchEnabled && isInvalidTarget && "opacity-40 grayscale",
          batchEnabled && isHoveredTarget && "ring-2 ring-primary/60 ring-inset"
        )}
        style={hasSwipe ? { transform: `translateX(${swipeOffset}px)` } : undefined}
      >
        {renderBatchLeading(batchEnabled, !!renderAsContinuation, {
          selected: isSelected,
          actorId: event.actorId,
          actorType: event.actorType,
          workspaceId,
          alt: actorName,
          fallback: leadingSlot,
        })}
        <div
          // `inert` removes descendants from the tab order and from
          // pointer/click handling — `pointer-events-none` alone leaves
          // nested links/buttons keyboard-focusable, so a Tab in batch mode
          // would land inside the row instead of treating it as a single
          // selection target. Reactions and thread cards still render at
          // full size so row height stays stable.
          inert={batchEnabled || undefined}
          className={cn("message-content flex-1 min-w-0", batchEnabled && "pointer-events-none")}
        >
          {headerRow}
          {messageBody}
          {footer}
        </div>
        {hoverActions && (
          <div
            className={cn(
              // Floats at the top of the row so hover interactions on heads and
              // continuations share the same toolbar. The 20px upward overlap keeps
              // the toolbar readable on py-0.5 continuations without pushing past
              // the viewport — on heads (pt-3 pb-0.5) it sits just above the
              // header row.
              "pointer-events-none absolute right-4 z-10 hidden sm:block",
              "bottom-[calc(100%-20px)] opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
              // Keyboard users tabbing through the timeline land on the toolbar
              // buttons even while it's visually hidden (opacity-0 doesn't
              // remove descendants from the tab order, and `pointer-events-none`
              // only affects mouse/touch). Reveal on `focus-within` so the
              // focused control is visible.
              "focus-within:pointer-events-auto focus-within:opacity-100",
              "has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100",
              "transition-opacity",
              isEditing && "pointer-events-none opacity-0"
            )}
          >
            <div className="flex items-center gap-0.5 rounded-md border border-border/60 bg-popover/95 px-1 py-1 shadow-md backdrop-blur-sm">
              {hoverActions}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

interface MessageEventInnerProps {
  event: StreamEvent
  payload: MessagePayload
  workspaceId: string
  streamId: string
  actorName: string
  isThreadParent?: boolean
  isHighlighted?: boolean
  isNew?: boolean
  activity?: MessageAgentActivity
  deferSecondaryHydration?: boolean
  /**
   * See MessageEventProps.groupContinuation. Honored by SentMessageEvent and
   * PendingMessageEvent so the optimistic → confirmed transition on send
   * doesn't flip a mid-run message from head to continuation. Ignored by
   * FailedMessageEvent (keeps the "Failed to send" status + Retry/Edit/Delete
   * inline actions visible) and EditingMessageEvent (the edit form needs the
   * full content column).
   */
  groupContinuation?: boolean
  /** True when this is the first message in the stream — drives the context-bag attachment badge. */
  isFirstMessage?: boolean
  batch?: BatchTimelineState
}

/**
 * Produce a user-facing label for the share-to-parent / share-to-root menu
 * entry based on the target stream's type. Channels read naturally as
 * "#slug"; DMs and scratchpads get a generic label to avoid awkward
 * display-name phrasing ("Share to Untitled scratchpad" etc.) in slice 1.
 * Thread parents (only reachable from a nested thread) include the display
 * name so the user can tell the root + parent entries apart in the menu.
 */
function buildShareToStreamLabel(target: { type: string; displayName: string | null; slug: string | null }): string {
  if (target.type === "channel") {
    const tag = target.slug ? `#${target.slug}` : (target.displayName ?? "channel")
    return `Share to ${tag}`
  }
  if (target.type === "dm") return "Share to DM"
  if (target.type === "scratchpad") return "Share to scratchpad"
  // Thread parent — only reachable from a nested thread. Use the display name
  // when available so the user can tell the two entries apart in the menu.
  if (target.type === "thread") {
    const name = target.displayName ?? target.slug ?? "thread"
    return `Share to thread (${name})`
  }
  return "Share to parent"
}

function SentMessageEvent({
  event,
  payload,
  workspaceId,
  streamId,
  actorName,
  isThreadParent: isThreadParentProp,
  isHighlighted,
  isNew,
  activity,
  deferSecondaryHydration,
  groupContinuation,
  isFirstMessage,
  batch,
}: MessageEventInnerProps) {
  const { panelId, getPanelUrl } = usePanel()
  const messageService = useMessageService()
  const currentUserId = useWorkspaceUserId(workspaceId)
  const { getTraceUrl } = useTrace()
  const quoteReplyCtx = useQuoteReply()
  const navigate = useNavigate()
  const location = useLocation()
  const currentStream = useStreamFromStore(streamId)
  const parentStream = useStreamFromStore(currentStream?.parentStreamId ?? undefined)
  const rootStream = useStreamFromStore(currentStream?.rootStreamId ?? undefined)
  // For one-level threads, parent === root, so we only show the root entry to
  // avoid two identical menu items. For nested threads (parent is itself a
  // thread), we show both: root for the most useful target (the channel/dm/
  // scratchpad), parent for the intermediate thread when that's what the
  // user actually wants.
  const showParentEntry = parentStream && rootStream && parentStream.id !== rootStream.id
  const replyCount = payload.replyCount ?? 0
  const threadId = payload.threadId
  const containerRef = useRef<HTMLDivElement>(null)

  const [isEditing, setIsEditing] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [mobilePickerOpen, setMobilePickerOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [shareModalOpen, setShareModalOpen] = useState(false)
  const [moveDetailsOpen, setMoveDetailsOpen] = useState(false)
  // Hydrate the destination tombstone on demand for the per-message
  // "Show move details" action. Reactive — populates as soon as the row
  // lands in IDB (live socket apply or bootstrap).
  const movedTombstoneEvent = useMovedTombstone(payload.movedFrom?.moveTombstoneId)

  // Mobile: long-press opens action drawer instead of dropdown
  const isMobile = useIsMobile()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const openDrawer = useCallback(() => setDrawerOpen(true), [])
  const longPress = useLongPress({
    onLongPress: openDrawer,
    enabled: isMobile && !isEditing && !batch?.enabled,
    deferToNativeLinks: true,
  })

  // Mobile: swipe left to quote reply
  const handleSwipeQuote = useCallback(() => {
    const snippet = payload.contentMarkdown.trim()
    if (!snippet) return
    quoteReplyCtx?.triggerQuoteReply({
      messageId: payload.messageId,
      streamId,
      authorName: actorName,
      authorId: event.actorId ?? "",
      actorType: event.actorType ?? "user",
      snippet,
    })
  }, [quoteReplyCtx, payload.messageId, payload.contentMarkdown, streamId, actorName, event.actorId, event.actorType])
  const swipe = useSwipeAction({
    onSwipe: handleSwipeQuote,
    enabled: isMobile && !isEditing && !!quoteReplyCtx && !batch?.enabled,
  })

  const startEditing = useCallback(() => {
    setIsEditing(true)
  }, [])

  // Restore focus to the zone's editor after exiting inline edit mode.
  // On mobile the stream composer is hidden purely via CSS while MessageEditForm
  // keeps a `[data-inline-edit]` element mounted, so there is no extra flag to
  // reset here.
  const stopEditing = useCallback(() => {
    const zone = containerRef.current?.closest<HTMLElement>("[data-editor-zone]") ?? null
    setIsEditing(false)
    if (isMobile) return
    requestAnimationFrame(() => focusVisibleZoneEditor(zone))
  }, [isMobile])

  // Register this message's edit handler with the context so the composer's ArrowUp trigger
  // can imperatively open edit mode and scroll into view. Unregistered on unmount.
  const { registerMessage } = useEditLastMessage() ?? {}
  useEffect(() => {
    if (!registerMessage) return
    return registerMessage(payload.messageId, () => {
      containerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
      startEditing()
    })
  }, [payload.messageId, registerMessage, startEditing])

  // Scroll to this message when highlighted
  useEffect(() => {
    if (isHighlighted && containerRef.current) {
      containerRef.current.scrollIntoView({ behavior: "smooth", block: "center" })
    }
  }, [isHighlighted])

  // Create draft panel URL for messages that don't have a thread yet
  const draftPanelId = createDraftPanelId(streamId, payload.messageId)
  const draftPanelUrl = getPanelUrl(draftPanelId)

  // Thread card shown below the message body when a thread exists with replies.
  // Users without a thread start one via the hover toolbar or context menu —
  // the old always-visible "Reply in thread" footer link has been removed.
  // `activity.threadStreamId` lets us link to the real thread immediately when
  // an agent response is in flight, before the slower stream:created event.
  const effectiveThreadId = threadId ?? activity?.threadStreamId
  // Unified thread-slot: owns the gold left-line across pill → card so the
  // transition reads as a single thread extending downward, with a CSS
  // grow-in on first appearance and a grid-rows extension when the card
  // takes over. Suppressed when this message IS the thread parent (avoids
  // recursion on the thread panel's top-pinned parent).
  const threadSlot = !isThreadParentProp ? (
    <ThreadSlot
      activity={activity}
      replyCount={replyCount}
      threadHref={effectiveThreadId ? getPanelUrl(effectiveThreadId) : null}
      summary={payload.threadSummary}
      workspaceId={workspaceId}
    />
  ) : null

  const { toggleByEmoji } = useMessageReactions(workspaceId, payload.messageId)
  const handleAddReaction = useCallback(
    (emoji: string) => toggleByEmoji(emoji, payload.reactions ?? {}, currentUserId),
    [toggleByEmoji, payload.reactions, currentUserId]
  )

  const activeReactionShortcodes = useMemo(() => {
    if (!currentUserId || !payload.reactions) return new Set<string>()
    const active = new Set<string>()
    for (const [shortcode, userIds] of Object.entries(payload.reactions)) {
      if (userIds.includes(currentUserId)) {
        active.add(stripColons(shortcode))
      }
    }
    return active
  }, [currentUserId, payload.reactions])

  const allReactionShortcodes = useMemo(() => reactionShortcodes(payload.reactions), [payload.reactions])

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      await messageService.delete(workspaceId, payload.messageId)
      setDeleteDialogOpen(false)
    } catch {
      // Enqueue for retry when back online
      await enqueueOperation(workspaceId, "delete_message", { messageId: payload.messageId })
      setDeleteDialogOpen(false)
      toast.info("Delete queued — will complete when back online")
    } finally {
      setIsDeleting(false)
    }
  }

  const savedForMessage = useSavedForMessage(workspaceId, payload.messageId)
  const saveMessageMutation = useSaveMessage(workspaceId)
  const unsaveMessageMutation = useDeleteSaved(workspaceId)
  const isSaved = !!savedForMessage && savedForMessage.status === "saved"
  const [reminderSheetOpen, setReminderSheetOpen] = useState(false)

  const handleToggleSave = useCallback(() => {
    // Mirror the desktop hover-button: swallow double-taps while a mutation is
    // in flight and surface a toast on every outcome so the mobile drawer
    // gives the same feedback as the desktop bookmark button.
    if (saveMessageMutation.isPending || unsaveMessageMutation.isPending) return
    if (!savedForMessage) {
      saveMessageMutation.mutate(
        { messageId: payload.messageId },
        {
          onSuccess: () => toast.success("Saved for later"),
          onError: () => toast.error("Could not save message"),
        }
      )
      return
    }
    if (savedForMessage.status !== "saved") {
      saveMessageMutation.mutate(
        { messageId: payload.messageId },
        {
          onSuccess: () => toast.success("Moved back to Saved"),
          onError: () => toast.error("Could not restore saved item"),
        }
      )
      return
    }
    unsaveMessageMutation.mutate(savedForMessage.id, {
      onSuccess: () => toast.success("Removed from saved"),
      onError: () => toast.error("Could not remove saved item"),
    })
  }, [savedForMessage, saveMessageMutation, unsaveMessageMutation, payload.messageId])

  const handleRequestReminder = useCallback(() => setReminderSheetOpen(true), [])

  const startDiscussWithAriadne = useDiscussWithAriadne(workspaceId)
  const handleDiscussWithAriadne = useCallback(
    // `useDiscussWithAriadne` rethrows after toasting so the surrounding
    // mutation pipeline can see failures. The action menu invokes us
    // fire-and-forget without awaiting, so we swallow here to keep the
    // failure out of the unhandled-rejection log — the user already saw
    // the toast. INV-11: failing loud means the toast, not the console.
    () => {
      void startDiscussWithAriadne({ sourceStreamId: streamId, sourceMessageId: payload.messageId }).catch(() => {
        /* toast already surfaced inside the hook */
      })
    },
    [startDiscussWithAriadne, streamId, payload.messageId]
  )

  // Shared action context for both desktop dropdown and mobile drawer
  const actionContext = useMemo(
    () => ({
      contentMarkdown: payload.contentMarkdown,
      actorType: event.actorType,
      sessionId: payload.sessionId,
      isThreadParent: panelId === threadId || isThreadParentProp,
      replyUrl: effectiveThreadId ? getPanelUrl(effectiveThreadId) : draftPanelUrl,
      traceUrl:
        event.actorType === "persona" && payload.sessionId
          ? getTraceUrl(payload.sessionId, payload.messageId)
          : undefined,
      messageId: payload.messageId,
      workspaceId,
      streamId,
      authorId: event.actorId ?? undefined,
      currentUserId: currentUserId ?? undefined,
      editedAt: payload.editedAt,
      onEdit: startEditing,
      onDelete: () => setDeleteDialogOpen(true),
      // Deferred to next tick so the DropdownMenu/ActionDrawer fully unmounts
      // before the Dialog opens — Radix emits synthetic pointer events on menu
      // close that trigger the Dialog's "click outside" handler otherwise.
      onShowHistory: () => setTimeout(() => setHistoryOpen(true), 0),
      onReact: handleAddReaction,
      onOpenFullPicker: () => setMobilePickerOpen(true),
      reactions: payload.reactions,
      isSaved,
      onToggleSave: handleToggleSave,
      onRequestReminder: handleRequestReminder,
      onDiscussWithAriadne: handleDiscussWithAriadne,
      onQuoteReply: quoteReplyCtx
        ? () =>
            quoteReplyCtx.triggerQuoteReply({
              messageId: payload.messageId,
              streamId,
              authorName: actorName,
              authorId: event.actorId ?? "",
              actorType: event.actorType ?? "user",
              snippet: payload.contentMarkdown,
            })
        : undefined,
      onQuoteReplyWithSnippet: quoteReplyCtx
        ? (snippet: string) =>
            quoteReplyCtx.triggerQuoteReply({
              messageId: payload.messageId,
              streamId,
              authorName: actorName,
              authorId: event.actorId ?? "",
              actorType: event.actorType ?? "user",
              snippet,
            })
        : undefined,
      onShareToRoot: rootStream
        ? () => {
            queueShareHandoff(rootStream.id, {
              messageId: payload.messageId,
              streamId,
              authorName: actorName,
              authorId: event.actorId ?? "",
              actorType: event.actorType ?? "user",
            })
            navigateAfterShareHandoff({ workspaceId, targetStreamId: rootStream.id, location, navigate, isMobile })
          }
        : undefined,
      shareToRootLabel: rootStream ? buildShareToStreamLabel(rootStream) : undefined,
      onShareToParent:
        showParentEntry && parentStream
          ? () => {
              queueShareHandoff(parentStream.id, {
                messageId: payload.messageId,
                streamId,
                authorName: actorName,
                authorId: event.actorId ?? "",
                actorType: event.actorType ?? "user",
              })
              navigateAfterShareHandoff({
                workspaceId,
                targetStreamId: parentStream.id,
                location,
                navigate,
                isMobile,
              })
            }
          : undefined,
      shareToParentLabel: showParentEntry && parentStream ? buildShareToStreamLabel(parentStream) : undefined,
      onShare: () => setShareModalOpen(true),
      // Per-message entry into the batch-move flow. Hidden during batch
      // mode itself (the row's own checkbox handles that), on the thread
      // parent (moving the parent into its own thread is nonsensical),
      // and on archived streams to match the stream-header menu's gating.
      onMoveToThread:
        !batch?.enabled && !isThreadParentProp && !currentStream?.archivedAt
          ? () => dispatchStartBatchSelect(streamId, payload.messageId)
          : undefined,
      // Destination-side discovery for moved messages. The drawer only
      // renders once the tombstone hydrates from IDB, so gate the menu
      // entry on the full lookup rather than just the id — keeps the
      // user from clicking into a no-op while bootstrap is still in
      // flight.
      onShowMoveDetails: movedTombstoneEvent ? () => setTimeout(() => setMoveDetailsOpen(true), 0) : undefined,
    }),
    [
      payload.contentMarkdown,
      payload.sessionId,
      payload.messageId,
      payload.editedAt,
      payload.reactions,
      event.actorType,
      event.actorId,
      panelId,
      threadId,
      isThreadParentProp,
      effectiveThreadId,
      getPanelUrl,
      draftPanelUrl,
      getTraceUrl,
      currentUserId,
      workspaceId,
      streamId,
      startEditing,
      handleAddReaction,
      quoteReplyCtx,
      actorName,
      isSaved,
      handleToggleSave,
      handleRequestReminder,
      parentStream,
      rootStream,
      showParentEntry,
      navigate,
      location,
      isMobile,
      handleDiscussWithAriadne,
      batch?.enabled,
      currentStream?.archivedAt,
      movedTombstoneEvent,
    ]
  )

  // Reactions + thread card stay visible in batch mode so entering selection
  // mode doesn't change row height. They're rendered as `pointer-events-none`
  // (handled below) so the row's batch-toggle click handler still wins.
  let footerContent: ReactNode
  if (isEditing && !isMobile) {
    footerContent = undefined
  } else {
    footerContent = (
      <>
        {payload.reactions && Object.keys(payload.reactions).length > 0 && (
          <MessageReactions
            reactions={payload.reactions}
            workspaceId={workspaceId}
            messageId={payload.messageId}
            currentUserId={currentUserId}
          />
        )}
        {threadSlot}
      </>
    )
  }

  return (
    <>
      <MessageLayout
        event={event}
        payload={payload}
        workspaceId={workspaceId}
        streamId={streamId}
        actorName={actorName}
        isFirstMessage={isFirstMessage}
        statusIndicator={
          <>
            <RelativeTime date={event.createdAt} className="text-xs text-muted-foreground" />
            {payload.editedAt && (
              <EditedIndicator editedAt={payload.editedAt} onShowHistory={() => setHistoryOpen(true)} />
            )}
            {payload.movedFrom && (
              <MovedFromIndicator
                workspaceId={workspaceId}
                movedFrom={payload.movedFrom}
                onClick={movedTombstoneEvent ? () => setMoveDetailsOpen(true) : undefined}
              />
            )}
            <SavedIndicator saved={savedForMessage ?? null} />
          </>
        }
        isEditing={isEditing && !isMobile}
        isGroupContinuation={groupContinuation}
        hoverActions={
          batch?.enabled ? undefined : (
            // Desktop-only hover toolbar floated above the row. Mobile users reach
            // these actions via the long-press drawer (MessageActionDrawer).
            <>
              <ReactionEmojiPicker
                workspaceId={workspaceId}
                onSelect={handleAddReaction}
                activeShortcodes={activeReactionShortcodes}
                allReactionShortcodes={allReactionShortcodes}
              />
              <SaveMessageButton workspaceId={workspaceId} messageId={payload.messageId} />
              {actionContext.onQuoteReply && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground shrink-0 hover:text-foreground"
                      aria-label="Quote reply"
                      onClick={actionContext.onQuoteReply}
                    >
                      <Quote className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Quote reply</TooltipContent>
                </Tooltip>
              )}
              {/* Reply-in-thread sits adjacent to the overflow menu so it mirrors
                the top entry of the expanded context menu — the two thread
                actions read as one visual neighborhood. Kept visible even when
                the thread panel is already open (clicking is a harmless re-nav
                to the same panel) so the toolbar never shuffles buttons in and
                out as the user opens/closes the thread. */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    asChild
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground shrink-0 hover:text-foreground"
                  >
                    <Link to={actionContext.replyUrl} aria-label="Reply in thread">
                      <MessageSquareReply className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Reply in thread</TooltipContent>
              </Tooltip>
              <MessageContextMenu context={actionContext} />
            </>
          )
        }
        footer={footerContent}
        containerRef={containerRef}
        isHighlighted={isHighlighted}
        isNew={isNew}
        deferSecondaryHydration={deferSecondaryHydration}
        containerClassName={cn(
          "scroll-mt-12",
          isMobile && !isEditing && "select-none",
          longPress.isPressed && "opacity-70 transition-opacity duration-100"
        )}
        swipeOffset={isMobile ? swipe.offset : undefined}
        swipeLocked={isMobile ? swipe.isLocked : undefined}
        touchHandlers={
          isMobile && !batch?.enabled
            ? {
                onTouchStart: (e: React.TouchEvent) => {
                  longPress.handlers.onTouchStart(e)
                  swipe.handlers.onTouchStart(e)
                },
                onTouchEnd: () => {
                  longPress.handlers.onTouchEnd()
                  swipe.handlers.onTouchEnd()
                },
                onTouchMove: (e: React.TouchEvent) => {
                  longPress.handlers.onTouchMove(e)
                  swipe.handlers.onTouchMove(e)
                },
                onContextMenu: longPress.handlers.onContextMenu,
              }
            : undefined
        }
        batch={batch}
      >
        {/* Desktop: inline edit replaces message content. Mobile: drawer handles editing. */}
        {isEditing && !isMobile ? (
          <MessageEditForm
            messageId={payload.messageId}
            workspaceId={workspaceId}
            initialContentJson={payload.contentJson}
            onSave={stopEditing}
            onCancel={stopEditing}
            onDelete={() => {
              stopEditing()
              setDeleteDialogOpen(true)
            }}
          />
        ) : undefined}
      </MessageLayout>
      {/* Mobile: edit in a bottom-sheet drawer (avoids scroll/keyboard issues) */}
      {isEditing && isMobile && (
        <MessageEditForm
          messageId={payload.messageId}
          workspaceId={workspaceId}
          initialContentJson={payload.contentJson}
          onSave={stopEditing}
          onCancel={stopEditing}
          onDelete={() => {
            stopEditing()
            setDeleteDialogOpen(true)
          }}
          authorName={actorName}
        />
      )}
      {deleteDialogOpen && (
        <DeleteMessageDialog
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          onConfirm={handleDelete}
          isDeleting={isDeleting}
        />
      )}
      {historyOpen && (
        <MessageHistoryDialog
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          messageId={payload.messageId}
          workspaceId={workspaceId}
          messageCreatedAt={event.createdAt}
          currentContent={{
            contentMarkdown: payload.contentMarkdown,
            editedAt: payload.editedAt,
          }}
        />
      )}
      {shareModalOpen && (
        <ShareMessageModal
          open={shareModalOpen}
          onOpenChange={setShareModalOpen}
          workspaceId={workspaceId}
          attrs={{
            messageId: payload.messageId,
            streamId,
            authorName: actorName,
            authorId: event.actorId ?? "",
            actorType: event.actorType ?? "user",
          }}
        />
      )}
      {moveDetailsOpen && movedTombstoneEvent && (
        <MovedMessagesDrawer
          open={moveDetailsOpen}
          onOpenChange={setMoveDetailsOpen}
          event={movedTombstoneEvent}
          workspaceId={workspaceId}
        />
      )}
      {isMobile && (
        <MessageActionDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          context={actionContext}
          authorName={actorName}
        />
      )}
      {mobilePickerOpen && (
        <ReactionEmojiPicker
          workspaceId={workspaceId}
          onSelect={handleAddReaction}
          activeShortcodes={activeReactionShortcodes}
          allReactionShortcodes={allReactionShortcodes}
          open={mobilePickerOpen}
          onOpenChange={setMobilePickerOpen}
        />
      )}
      {reminderSheetOpen && (
        <ReminderPickerSheet
          open={reminderSheetOpen}
          onOpenChange={setReminderSheetOpen}
          workspaceId={workspaceId}
          messageId={payload.messageId}
          saved={savedForMessage ?? null}
        />
      )}
    </>
  )
}

function PendingMessageEvent({
  event,
  payload,
  workspaceId,
  streamId,
  actorName,
  deferSecondaryHydration,
  groupContinuation,
  isFirstMessage,
}: MessageEventInnerProps) {
  const { markEditing, deleteMessage } = usePendingMessages()
  const isOnline = useIsOnline()
  const isMobile = useIsMobile()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const openDrawer = useCallback(() => setDrawerOpen(true), [])
  const longPress = useLongPress({ onLongPress: openDrawer, enabled: isMobile, deferToNativeLinks: true })

  const [slowEnough, setSlowEnough] = useState(
    () => Date.now() - new Date(event.createdAt).getTime() >= SLOW_SEND_THRESHOLD_MS
  )
  useEffect(() => {
    if (slowEnough) return
    const remaining = SLOW_SEND_THRESHOLD_MS - (Date.now() - new Date(event.createdAt).getTime())
    if (remaining <= 0) {
      setSlowEnough(true)
      return
    }
    const id = window.setTimeout(() => setSlowEnough(true), remaining)
    return () => window.clearTimeout(id)
  }, [slowEnough, event.createdAt])

  const showPendingState = !isOnline || slowEnough

  return (
    <>
      <MessageLayout
        event={event}
        payload={payload}
        workspaceId={workspaceId}
        streamId={streamId}
        actorName={actorName}
        isFirstMessage={isFirstMessage}
        deferSecondaryHydration={deferSecondaryHydration}
        isGroupContinuation={groupContinuation}
        containerClassName={cn(
          showPendingState && "opacity-60",
          isMobile && "select-none",
          longPress.isPressed && "opacity-40 transition-opacity duration-100"
        )}
        touchHandlers={isMobile ? longPress.handlers : undefined}
        statusIndicator={
          showPendingState ? (
            <span className="text-xs text-muted-foreground opacity-0 animate-fade-in-delayed">
              {isOnline ? "Sending..." : "Waiting to send"}
            </span>
          ) : null
        }
        // Edit/Delete live in the floating hover toolbar — same slot sent
        // messages use — so the inline header height matches sent rows. Without
        // this, the h-6 buttons inflated the `items-baseline` header row of a
        // pending head, then collapsed when the message confirmed, shifting
        // surrounding rows by a few pixels at the moment of send. The hover
        // toolbar also renders for grouped continuations (where the header row
        // is collapsed), which the inline `actions` slot couldn't.
        hoverActions={
          <>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => void markEditing(event.id)}>
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-muted-foreground"
              onClick={() => void deleteMessage(event.id)}
            >
              Delete
            </Button>
          </>
        }
        footer={null}
      />
      {isMobile && (
        <UnsentMessageActionDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          contentMarkdown={payload.contentMarkdown}
          authorName={actorName}
          onEdit={() => void markEditing(event.id)}
          onDelete={() => void deleteMessage(event.id)}
        />
      )}
    </>
  )
}

function FailedMessageEvent({
  event,
  payload,
  workspaceId,
  streamId,
  actorName,
  deferSecondaryHydration,
  isFirstMessage,
}: MessageEventInnerProps) {
  const { retryMessage, markEditing, deleteMessage } = usePendingMessages()
  const isMobile = useIsMobile()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const openDrawer = useCallback(() => setDrawerOpen(true), [])
  const longPress = useLongPress({ onLongPress: openDrawer, enabled: isMobile, deferToNativeLinks: true })

  return (
    <>
      <MessageLayout
        event={event}
        payload={payload}
        workspaceId={workspaceId}
        streamId={streamId}
        actorName={actorName}
        isFirstMessage={isFirstMessage}
        deferSecondaryHydration={deferSecondaryHydration}
        containerClassName={cn(
          "border-l-2 border-destructive pl-2",
          isMobile && "select-none",
          longPress.isPressed && "opacity-70 transition-opacity duration-100"
        )}
        touchHandlers={isMobile ? longPress.handlers : undefined}
        statusIndicator={<span className="text-xs text-destructive">Failed to send</span>}
        actions={
          <div className="flex gap-1 mt-1 hidden sm:flex">
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => void retryMessage(event.id)}>
              Retry
            </Button>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => void markEditing(event.id)}>
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-muted-foreground"
              onClick={() => void deleteMessage(event.id)}
            >
              Delete
            </Button>
          </div>
        }
        footer={null}
      />
      {isMobile && (
        <UnsentMessageActionDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          contentMarkdown={payload.contentMarkdown}
          authorName={actorName}
          onRetry={() => void retryMessage(event.id)}
          onEdit={() => void markEditing(event.id)}
          onDelete={() => void deleteMessage(event.id)}
        />
      )}
    </>
  )
}

function EditingMessageEvent({
  event,
  payload,
  workspaceId,
  streamId,
  actorName,
  deferSecondaryHydration,
  isFirstMessage,
}: MessageEventInnerProps) {
  const isMobile = useIsMobile()
  const containerRef = useRef<HTMLDivElement>(null)

  const stopEditing = useCallback(() => {
    const zone = containerRef.current?.closest<HTMLElement>("[data-editor-zone]") ?? null
    if (isMobile) return
    requestAnimationFrame(() => focusVisibleZoneEditor(zone))
  }, [isMobile])

  return (
    <>
      <MessageLayout
        event={event}
        payload={payload}
        workspaceId={workspaceId}
        streamId={streamId}
        actorName={actorName}
        isFirstMessage={isFirstMessage}
        deferSecondaryHydration={deferSecondaryHydration}
        isEditing={!isMobile}
        containerRef={containerRef}
        statusIndicator={<span className="text-xs text-muted-foreground">Editing unsent message</span>}
      >
        {!isMobile ? (
          <UnsentMessageEditForm messageId={event.id} initialContentJson={payload.contentJson} onDone={stopEditing} />
        ) : undefined}
      </MessageLayout>
      {isMobile && (
        <UnsentMessageEditForm
          messageId={event.id}
          initialContentJson={payload.contentJson}
          onDone={stopEditing}
          authorName={actorName}
        />
      )}
    </>
  )
}

function makePlaceholderJson(text: string): JSONContent {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }
}

function applyDecryptedContent(payload: MessagePayload, decrypted: DecryptedMessageContent): MessagePayload {
  switch (decrypted.status) {
    case "plaintext":
      return payload
    case "decrypted":
      return { ...payload, contentMarkdown: decrypted.contentMarkdown, contentJson: decrypted.contentJson }
    case "locked": {
      const text = "🔒 Locked — unlock to view"
      return { ...payload, contentMarkdown: text, contentJson: makePlaceholderJson(text) }
    }
    case "pending": {
      const text = "🔒 Decrypting…"
      return { ...payload, contentMarkdown: text, contentJson: makePlaceholderJson(text) }
    }
    case "failed": {
      const text = "🔒 Decryption failed"
      return { ...payload, contentMarkdown: text, contentJson: makePlaceholderJson(text) }
    }
  }
}

export function MessageEvent({
  event,
  workspaceId,
  streamId,
  isThreadParent,
  isHighlighted,
  isNew,
  activity,
  deferSecondaryHydration = false,
  groupContinuation = false,
  isFirstMessage = false,
  batch,
}: MessageEventProps) {
  const rawPayload = event.payload as MessagePayload
  const currentUserId = useWorkspaceUserId(workspaceId)
  const decrypted = useDecryptedMessageContent(event, workspaceId, currentUserId)
  const payload = useMemo(() => applyDecryptedContent(rawPayload, decrypted), [rawPayload, decrypted])
  const { getStatus } = usePendingMessages()
  const { getActorName } = useActors(workspaceId)
  const status = getStatus(event.id)

  const actorName = getActorName(event.actorId, event.actorType)

  switch (status) {
    // Pending/failed/editing rows aren't selectable (they don't have a
    // canonical server-side messageId yet), so the timeline never enters
    // batch-target visuals on them. Don't thread `batch` through — it would
    // only suggest these rows participate in selection when they don't.
    case "pending":
      return (
        <PendingMessageEvent
          event={event}
          payload={payload}
          workspaceId={workspaceId}
          streamId={streamId}
          actorName={actorName}
          isThreadParent={isThreadParent}
          deferSecondaryHydration={deferSecondaryHydration}
          groupContinuation={groupContinuation}
          isFirstMessage={isFirstMessage}
        />
      )
    case "failed":
      return (
        <FailedMessageEvent
          event={event}
          payload={payload}
          workspaceId={workspaceId}
          streamId={streamId}
          actorName={actorName}
          isThreadParent={isThreadParent}
          deferSecondaryHydration={deferSecondaryHydration}
          isFirstMessage={isFirstMessage}
        />
      )
    case "editing":
      return (
        <EditingMessageEvent
          event={event}
          payload={payload}
          workspaceId={workspaceId}
          streamId={streamId}
          actorName={actorName}
          deferSecondaryHydration={deferSecondaryHydration}
          isFirstMessage={isFirstMessage}
        />
      )
    default:
      return (
        <SentMessageEvent
          event={event}
          payload={payload}
          workspaceId={workspaceId}
          streamId={streamId}
          actorName={actorName}
          isThreadParent={isThreadParent}
          isHighlighted={isHighlighted}
          isNew={isNew}
          activity={activity}
          deferSecondaryHydration={deferSecondaryHydration}
          groupContinuation={groupContinuation}
          isFirstMessage={isFirstMessage}
          batch={batch}
        />
      )
  }
}
