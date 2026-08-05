import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { toast } from "sonner"
import {
  ChevronLeft,
  Hash,
  FileEdit,
  User,
  MessageSquareText,
  Link2,
  Check,
  CircleCheck,
  ArrowDown,
  ArrowUp,
  X,
  type LucideIcon,
} from "lucide-react"
import {
  SidePanel,
  SidePanelHeader,
  SidePanelTitle,
  SidePanelClose,
  SidePanelContent,
} from "@/components/ui/side-panel"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Skeleton } from "@/components/ui/skeleton"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { MessageItem, type RenderableMessage } from "@/components/message/message-item"
import { buildBranchedBoardRows, injectBoardDayDividers, injectUnreadDivider } from "@/components/board/board-row-item"
import {
  BranchedBoardRows,
  BranchProvenanceRow,
  BRANCH_SETTLING_RAIL_CLASS,
  BRANCH_ACCENTED_SETTLING_RAIL_CLASS,
} from "@/components/board/branch-rows"
import { resolveBoardEventRows } from "@/lib/board/board-event-rows"
import { groupBranches, type BranchConversationView } from "@/lib/board/branch-grouping"
import {
  useConversationGraph,
  useStreamStructuralIndex,
  deriveBranchConversations,
  collectBranchThreadStreamIds,
  deriveBranchProvenance,
} from "@/hooks/use-conversation-graph"
import { useInlineBranchComposer, type ArmBranchTarget } from "@/components/board/use-inline-branch-composer"
import { useMoveToSubtopic } from "@/components/board/use-move-to-subtopic"
import { ConversationActionsMenu } from "@/components/conversations/conversation-actions-menu"
import { useBoardHiddenConversations } from "@/stores/board-exclusions-store"
import { useWorkspaceStreamReadStates, useWorkspaceUnreadState } from "@/stores/workspace-store"
import { cn } from "@/lib/utils"
import { actorRowTheme } from "@/components/message/actor-row-theme"
import { ConversationReadProvider, useConversationReadController } from "@/components/message/conversation-read-context"
import { useConversationAutoRead } from "@/components/message/use-conversation-auto-read"
import { DeletedMessageEvent } from "@/components/timeline/deleted-message-event"
import { MESSAGE_ROW_CONTINUATION_PADDING, MESSAGE_ROW_HEAD_PADDING } from "@/components/message/message-row-layout"
import { useConversationUnreadMarker } from "@/components/conversations/use-conversation-unread-marker"
import { RelativeTime } from "@/components/relative-time"
import { BoardReplyComposer, type ArmedReply } from "@/components/board/board-reply-composer"
import {
  FloatingComposerAnchorProvider,
  FloatingComposerShell,
  useFloatingComposerAnchor,
  useFloatingComposerHeight,
  FLOATING_COMPOSER_HEIGHT_VAR,
  conversationArchivedReason,
} from "@/components/composer"
import { QuoteReplyProvider } from "@/components/timeline/quote-reply-context"
import { TextSelectionQuote } from "@/components/timeline/text-selection-quote"
import { SidebarToggle } from "@/components/layout"
import { useActors, useVisibleStreams, useEffectiveArchived } from "@/hooks"
import { useStashParamDraftRow } from "@/hooks/use-stash-composer"
import { boardReplyDraftKey, boardBranchReplyDraftKey } from "@/lib/board/draft-keys"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useStreamName } from "@/hooks/use-stream-name"
import { usePanel, parseConversationPanel, useSidebar, useCoordinatedPhase, type CoordinatedPhase } from "@/contexts"
import { useStreamFromStore } from "@/stores/stream-store"
import { consumeConversationReplyOpen, subscribeConversationReplyOpen } from "@/stores/conversation-reply-open-store"
import { useConversationBoardPost, useSplitThread } from "@/hooks/use-conversations"
import { applySettlingAll, useBoardCardMessages } from "@/hooks/use-board-card-messages"
import { useConversationBackfill } from "@/hooks/use-conversation-backfill"
import { useScrollBehavior } from "@/hooks/use-scroll-behavior"
import { usePanelStreamSubscriptions } from "@/hooks/use-panel-stream-subscriptions"
import { buildConversationLink } from "@/lib/stream-links"
import type { BoardViewPost } from "@/hooks/use-stable-board-view"

const TYPE_GLYPH: Record<string, LucideIcon> = {
  channel: Hash,
  scratchpad: FileEdit,
  dm: User,
}

interface ConversationPanelProps {
  workspaceId: string
  onClose: () => void
}

/** How long the reveal waits on an unsettled input before painting rows without
 *  a "New" divider. A conversation spanning a never-read thread leg is never
 *  decidable at all (INV-62: no membership row, so neither bootstrap map carries
 *  it), so this is a real ceiling, not just a slow-network cushion. */
const REVEAL_TIMEOUT_MS = 1500

/** Head/continuation shape of the placeholder run, so the skeleton has the same
 *  grouped rhythm as a real conversation instead of four identical blocks. */
const SKELETON_ROWS: { continuation: boolean; width: string }[] = [
  { continuation: false, width: "w-11/12" },
  { continuation: true, width: "w-4/5" },
  { continuation: false, width: "w-3/4" },
  { continuation: true, width: "w-10/12" },
  { continuation: true, width: "w-2/3" },
]

/**
 * The panel's loading shape, rendered by the same component that renders the
 * rows and built from the same layout constants `MessageItem` uses
 * (`MESSAGE_ROW_*_PADDING`, the `md` avatar box, `gap-3`, and the column's own
 * `px-3 sm:px-6` break-out). Same geometry means the swap to real rows moves
 * nothing (INV-21) — the previous `p-4`/`gap-2` shape pushed the first row down
 * 16px and in 28px.
 */
function ConversationRowsSkeleton() {
  return (
    <div aria-hidden>
      {SKELETON_ROWS.map((row, i) => (
        <div key={i} className="-mx-3 sm:-mx-6">
          <div
            className={cn(
              "flex items-start gap-3 px-3 sm:px-6",
              row.continuation ? MESSAGE_ROW_CONTINUATION_PADDING : MESSAGE_ROW_HEAD_PADDING
            )}
          >
            {row.continuation ? (
              <div className="h-8 w-8 shrink-0" />
            ) : (
              <Skeleton className="h-8 w-8 shrink-0 rounded-[8px]" />
            )}
            <div className="min-w-0 flex-1">
              {!row.continuation && (
                <div className="mb-0.5 flex items-baseline gap-2">
                  <Skeleton className="h-5 w-28" />
                </div>
              )}
              <Skeleton className={cn("h-[22px]", row.width)} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

interface ConversationPanelHeaderProps {
  workspaceId: string
  conversationId: string | null
  post: BoardViewPost | null
  /** The panel's coordinated phase — the header lands with the rows, never before. */
  phase: CoordinatedPhase
  isMobile: boolean
  hostStreamType: string | undefined
  locator: string
  isHidden: boolean
  copyDone: boolean
  onCopyLink: () => void
  onClose: () => void
}

/**
 * The panel header. Rendered by the body once a conversation is open, so its
 * title/glyph/actions flip on the exact same `phase` value as the message
 * column — one commit, no stepped reveal. Until then the row holds its footprint
 * at a fixed height (INV-21).
 */
function ConversationPanelHeader({
  workspaceId,
  conversationId,
  post,
  phase,
  isMobile,
  hostStreamType,
  locator,
  isHidden,
  copyDone,
  onCopyLink,
  onClose,
}: ConversationPanelHeaderProps) {
  const ContextGlyph = (hostStreamType && TYPE_GLYPH[hostStreamType]) || MessageSquareText
  const revealed = phase === "ready" && post !== null
  return (
    <SidePanelHeader>
      {isMobile && <SidebarToggle location="page" />}
      <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose}>
        <ChevronLeft className="h-4 w-4" />
        <span className="sr-only">Back</span>
      </Button>
      {/* Nothing here paints before the column does: the glyph, the topic and the
          stream locator all resolve with the rows, and rendering their fallbacks
          first made the header show a generic icon over the literal word
          "Conversation" and then swap. */}
      <SidePanelTitle className="flex min-w-0 flex-1 items-center gap-1.5">
        {revealed ? (
          <>
            <ContextGlyph className="h-4 w-4 shrink-0 text-muted-foreground" />
            {post.conversation.status === "resolved" && (
              <CircleCheck className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="Resolved" />
            )}
            {/* The topic is the conversation's identity — show it when set, falling
                back to the stream locator (the pre-topic behavior). */}
            <span className={cn("truncate", post.conversation.status === "resolved" && "text-muted-foreground")}>
              {post.conversation.topicSummary ?? locator}
            </span>
            <RelativeTime
              date={post.conversation.lastActivityAt}
              terse
              className="ml-1 shrink-0 text-xs font-normal text-muted-foreground"
            />
          </>
        ) : (
          <>
            <div className="h-4 w-4 shrink-0" />
            {phase === "skeleton" && <Skeleton className="h-4 w-40 max-w-full" />}
          </>
        )}
      </SidePanelTitle>
      {revealed ? (
        <ConversationActionsMenu
          workspaceId={workspaceId}
          conversationId={post.conversation.id}
          streamId={post.conversation.streamId}
          topicSummary={post.conversation.topicSummary}
          status={post.conversation.status}
          isHidden={isHidden}
          triggerClassName="shrink-0"
        />
      ) : (
        <div className="h-8 w-8 shrink-0" />
      )}
      {conversationId && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={copyDone ? "Link copied" : "Copy link to conversation"}
              onClick={onCopyLink}
            >
              {copyDone ? <Check className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{copyDone ? "Copied" : "Copy link"}</TooltipContent>
        </Tooltip>
      )}
      {!isMobile && <SidePanelClose onClose={onClose} />}
    </SidePanelHeader>
  )
}

/**
 * A single conversation opened in the side panel (Mechanism B,
 * board-view-design.md) — a projection peer to a thread, keyed by `?panel=conv:<id>`.
 * Reads the conversation flattened-chronological across its root + threads (one
 * root), live off the same `db.events` rail the board card and timeline ride, and
 * replies scoped to it via the recency-biased board-reply path. No stream is
 * mutated and access is the conversation's single root check (enforced when the
 * by-id post is fetched, INV-62) — the panel adds no per-message gating.
 */
export function ConversationPanel({ workspaceId, onClose }: ConversationPanelProps) {
  const { isMobile } = useSidebar()
  // The composer anchor lives here, above the body, because the body itself
  // reads the anchor context (`useFloatingComposerAnchor`) — it can host the
  // element but not the provider.
  const [floatingAnchorEl, setFloatingAnchorEl] = useState<HTMLElement | null>(null)
  const { panelId } = usePanel()
  const conversationId = panelId ? parseConversationPanel(panelId) : null
  const { post, notFound, loadFailed, refetch } = useConversationBoardPost(workspaceId, conversationId)
  // Both ends the load: a 404 verdict and a failed request are equally terminal
  // here (`retry: false`), and the empty state below names both.
  const unopenable = notFound || loadFailed
  // Hidden set — the panel is reachable for a hidden conversation (deep-link,
  // search, Saved), so it offers "Unhide" when the open one is hidden.
  const hiddenConversations = useBoardHiddenConversations(workspaceId)

  // "Reply in conversation" opened this panel with the intent to reply, not just
  // read — pick up its one-shot signal (queued before this panel mounted, or
  // arriving while it's already open for the same conversation) and land the user
  // in the composer. A monotonic nonce, not a boolean, so a repeat request while
  // the panel is already open re-opens the composer after a manual collapse.
  // Stays 0 on a plain deep-link/"Show in conversation" open (no queued request).
  const [openReplySignal, setOpenReplySignal] = useState(0)
  useEffect(() => {
    if (!conversationId) return
    const bump = () => {
      if (consumeConversationReplyOpen(conversationId)) setOpenReplySignal((n) => n + 1)
    }
    bump()
    return subscribeConversationReplyOpen(conversationId, bump)
  }, [conversationId])

  // A drafts-explorer deep link (`?panel=conv:<id>&stash=<draftId>`): the docked
  // footer composer is always mounted, and its own `useStashComposer` URL effect
  // consumes the restore and strips the param — this bump only FOCUSES the
  // footer so the restored draft is where the user is looking. Ownership-checked
  // so a foreign scope's param (e.g. a thread draft on the same route) is left
  // for its own host. The test is the deep-linked row's own scope — the same
  // claim boundary the footer's restore uses — not pile membership, which is now
  // landing-site-wide and would focus this footer for a draft belonging to the
  // timeline composer.
  const stashParamRow = useStashParamDraftRow(workspaceId)
  const stashParam = stashParamRow?.draftId ?? null
  const replyScope = conversationId ? boardReplyDraftKey(conversationId) : undefined
  const stashOpenedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!stashParam || stashOpenedRef.current === stashParam) return
    if (!replyScope || stashParamRow?.scope !== replyScope) return
    // Already checked out here — the deep link has nothing left to restore, so
    // revisiting the URL must not pop the composer open again.
    if (stashParamRow.isLoadedForScope) return
    stashOpenedRef.current = stashParam
    setOpenReplySignal((n) => n + 1)
  }, [stashParam, stashParamRow?.scope, stashParamRow?.isLoadedForScope, replyScope])

  // Keep the conversation's streams (root + threads) caught up + joined while the
  // panel is open, so the rail is live and offline-first. Its own SyncEngine slot,
  // so it composes with the board feed rather than clobbering it. The nested
  // branch conversations' threads are folded in too — the panel renders their
  // bodies inline, so they must sync like any other rendered stream.
  const conversationGraph = useConversationGraph(workspaceId)
  const structuralIndex = useStreamStructuralIndex(workspaceId)
  const panelStreamIds = useMemo(() => {
    if (!post) return []
    const branchIds = collectBranchThreadStreamIds({
      conversationId: post.conversation.id,
      memberMessageIds: post.conversation.messageIds,
      index: structuralIndex,
      graph: conversationGraph,
    })
    return [...new Set([post.conversation.streamId, ...(post.streamIds ?? []), ...branchIds])]
  }, [post, structuralIndex, conversationGraph])
  usePanelStreamSubscriptions(panelStreamIds)
  // The panel's streams aren't in the URL (`?panel=conv:…`), so the SW's push
  // suppression can only know they're on screen if we register them here.
  useVisibleStreams(panelStreamIds)

  // Escape closes the panel, matching StreamPanel — the two are peers in the same
  // slot, so the keyboard affordance should be consistent. Skip when the event was
  // already handled (the reply composer's own Escape collapses the editor first) or
  // when focus is in a text field, so closing the panel never eats a composer Escape.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      const active = document.activeElement as HTMLElement | null
      if (active?.closest('[contenteditable="true"], input, textarea')) return
      onClose()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  // Header "Copy link" confirms in place — the icon swaps to a checkmark for a
  // beat (same footprint, no shift per INV-21) rather than a toast, because a
  // persistent header button is an on-screen anchor (INV-63; mirrors the
  // image-gallery toolbar). Only the anchorless callers (the mod+Shift+L
  // shortcut, the message-menu item) keep `copyConversationLink`'s toast.
  const [copyDone, setCopyDone] = useState(false)
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (copyResetRef.current) clearTimeout(copyResetRef.current)
    },
    []
  )
  const handleCopyLink = useCallback(async () => {
    if (!conversationId) return
    try {
      await navigator.clipboard.writeText(buildConversationLink(workspaceId, conversationId))
      setCopyDone(true)
      if (copyResetRef.current) clearTimeout(copyResetRef.current)
      copyResetRef.current = setTimeout(() => setCopyDone(false), 1200)
    } catch {
      toast.error("Failed to copy link")
    }
  }, [conversationId, workspaceId])

  const anchorStreamId = post?.conversation.streamId
  const hostStream = useStreamFromStore(anchorStreamId)
  const hostStreamType = hostStream?.type
  const locator = useStreamName(workspaceId, anchorStreamId ?? "", "generic") ?? "Conversation"
  // Archived conversations are read-only (INV-62): the anchor stream's own
  // state, else the root it inherits from, else the board post's cold-load
  // verdict (kept live by `setBoardRootArchived`).
  const archived = useEffectiveArchived({
    stream: hostStream,
    rootStreamId: hostStream?.rootStreamId ?? null,
    fallbackRootArchived: post?.rootArchived === true,
  })
  const archivedReason = conversationArchivedReason(archived)

  // The pre-`post` half of the same machine: blank while the fetch is young, the
  // panel's own skeleton once it is genuinely slow. The latch is what lets the
  // body pick the skeleton up where this left it — without it, the body mounting
  // at its own "loading" phase would blank a skeleton the user is already
  // looking at.
  // `unopenable` is terminal with `post` still null, so readiness has to include it —
  // otherwise the phase latches at "skeleton" and the header shimmers forever above
  // a resolved empty state.
  const shellPhase = useCoordinatedPhase({ isLoading: !post && !unopenable, isReady: !!post || unopenable })
  const skeletonShownRef = useRef<{ conversationId: string | null; shown: boolean }>({ conversationId, shown: false })
  if (skeletonShownRef.current.conversationId !== conversationId) {
    skeletonShownRef.current = { conversationId, shown: false }
  }
  if (shellPhase === "skeleton") skeletonShownRef.current.shown = true

  const headerProps = {
    workspaceId,
    conversationId,
    hostStreamType,
    locator,
    isMobile,
    copyDone,
    onCopyLink: () => void handleCopyLink(),
    onClose,
  }

  if (post) {
    return (
      <SidePanel data-editor-zone="panel">
        <FloatingComposerAnchorProvider el={floatingAnchorEl}>
          <ConversationPanelBody
            workspaceId={workspaceId}
            post={post}
            hostStreamType={hostStreamType}
            archivedReason={archivedReason}
            openReplySignal={openReplySignal}
            contentRef={setFloatingAnchorEl}
            skeletonAlreadyVisible={skeletonShownRef.current.shown}
            header={{ ...headerProps, post, isHidden: hiddenConversations.has(post.conversation.id) }}
          />
        </FloatingComposerAnchorProvider>
      </SidePanel>
    )
  }

  let body: React.ReactNode = shellPhase === "skeleton" ? <ConversationRowsSkeleton /> : null
  if (unopenable) {
    body = (
      <Empty className="min-h-[16rem] border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageSquareText />
          </EmptyMedia>
          <EmptyTitle>Couldn't open this conversation</EmptyTitle>
          {/* The state covers both a transient load failure (retry helps) and a
              gone/merged/access-lost conversation (retry won't) — so the copy names
              both rather than asserting one, keeping "Try again" honest. */}
          <EmptyDescription>
            It may have moved or been merged, you may have lost access, or there was a problem loading it.
          </EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="mt-2">
          Try again
        </Button>
      </Empty>
    )
  }

  return (
    <SidePanel data-editor-zone="panel">
      <ConversationPanelHeader {...headerProps} post={null} isHidden={false} phase={shellPhase} />
      <SidePanelContent className="relative flex flex-col">
        {/* The column's padding, so the placeholder rows sit exactly where the
            real ones will. */}
        <div className="min-h-0 flex-1 overflow-y-auto pt-4">
          <div className="mx-auto w-full min-w-0 max-w-[800px] px-3 sm:px-6">{body}</div>
        </div>
      </SidePanelContent>
    </SidePanel>
  )
}

interface ConversationPanelBodyProps {
  workspaceId: string
  post: BoardViewPost
  hostStreamType: string | undefined
  /** Set when the conversation is archived: the composer and the branch affordances
   *  are replaced by this notice (read-only, INV-62). */
  archivedReason: string | undefined
  /** Bumped each time the panel is opened via "Reply in conversation" — opens the composer. */
  openReplySignal: number
  /** Rendered here, not by the parent, so it flips on the same `phase` the rows do. */
  header: Omit<ConversationPanelHeaderProps, "phase">
  /** Publishes the scroll container as the mobile floating-composer anchor. */
  contentRef: (el: HTMLElement | null) => void
  /** The shell already painted the skeleton — pick it up rather than blanking. */
  skeletonAlreadyVisible: boolean
}

/**
 * The panel's header, message column and scoped composer. Always renders the
 * FULL conversation (the panel is permanently "expanded"): the live rail from
 * {@link useBoardCardMessages} for opening + recent + the viewer's pending
 * replies, backfilled with the complete ordered list when the local rail is
 * incomplete — the same merge the board card runs on expand.
 */
function ConversationPanelBody({
  workspaceId,
  post,
  hostStreamType,
  archivedReason,
  openReplySignal,
  header,
  contentRef,
  skeletonAlreadyVisible,
}: ConversationPanelBodyProps) {
  const { getActorName } = useActors(workspaceId)
  const currentUserId = useWorkspaceUserId(workspaceId)
  const splitThread = useSplitThread(workspaceId)
  const { conversation } = post
  // Per-row read state + the mark-read/unread actions for this conversation's
  // rows (docs/sparse-read-overlay-design.md). The panel has no unread dot, so
  // only the provider value is used.
  const {
    value: conversationReadValue,
    markReadSilently,
    setExplicitUnreadListener,
    getReadTruth,
  } = useConversationReadController(workspaceId, conversation.id, conversation.streamId, currentUserId)
  // Deep-link target from `?m=` — the row to scroll to + flash. Shared with the
  // host page's `m` param, but only the conversation panel reads it here (the
  // board page, the panel's host for a conversation link, ignores it), so a
  // shared conversation link lands on the right message without a competing
  // main-view highlight.
  const [searchParams] = useSearchParams()
  const highlightMessageId = searchParams.get("m")

  // The docked footer composer arms to a sub-conversation instead of mounting a
  // mid-flow editor: replying in the panel always happens at the bottom dock
  // (Kris's composer ruling). `armBranch` sets the target; the footer switches
  // scope/routing and shows the dismissible strip. `focusSeq` re-focuses the
  // footer on arm and on a "Reply in conversation" open (`openReplySignal`).
  const [armed, setArmed] = useState<{ target: ArmBranchTarget; restoreStashedId: string | null; seq: number } | null>(
    null
  )
  const armSeqRef = useRef(0)
  const [focusSeq, setFocusSeq] = useState(0)
  const armBranch = useCallback((target: ArmBranchTarget, restoreStashedId: string | null) => {
    armSeqRef.current += 1
    setArmed({ target, restoreStashedId, seq: armSeqRef.current })
    setFocusSeq((n) => n + 1)
  }, [])
  const prevOpenReplyRef = useRef(openReplySignal)
  useEffect(() => {
    if (openReplySignal === prevOpenReplyRef.current) return
    prevOpenReplyRef.current = openReplySignal
    setFocusSeq((n) => n + 1)
  }, [openReplySignal])

  // Shared graph + structural index, needed before the rail hook: the inline
  // branch composer derives the branch thread streams (and pending sub-topic
  // draft rails) the panel subscribes to as extra rails.
  const conversationGraph = useConversationGraph(workspaceId)
  const structuralIndex = useStreamStructuralIndex(workspaceId)
  const inlineComposer = useInlineBranchComposer({
    workspaceId,
    conversationId: conversation.id,
    memberMessageIds: conversation.messageIds,
    index: structuralIndex,
    graph: conversationGraph,
    onArmBranchReply: armBranch,
    archived: !!archivedReason,
  })
  const { derivePendingBranches, queueExistingBranchReply } = inlineComposer

  const armedReply: ArmedReply | undefined = armed
    ? {
        draftKey: boardBranchReplyDraftKey(armed.target.conversationId),
        title: armed.target.title,
        scheduleTarget: { streamId: armed.target.threadStreamId, conversationId: armed.target.conversationId },
        restoreStashedId: armed.restoreStashedId,
        restoreSignal: armed.seq,
        onSubmit: (input) => queueExistingBranchReply(armed.target.conversationId, armed.target.threadStreamId, input),
        onCancel: () => {
          setArmed(null)
          // The × unmounts with the strip — refocus the composer so "back to the
          // standard composer" means the user just keeps typing (arm/cancel symmetry).
          setFocusSeq((n) => n + 1)
        },
      }
    : undefined

  const {
    openingMessage,
    replies: railReplies,
    totalReplies,
    pendingReplies,
    source,
    events: railEvents,
    messagesById,
    taggedByConversation,
    settlingIds,
    knownMessageIds,
    railCoversMembership,
  } = useBoardCardMessages(post, hostStreamType, {
    branchStreamIds: inlineComposer.branchStreamIds,
    extraDraftPanelIds: inlineComposer.extraDraftPanelIds,
  })

  // Backfill the full window when the local rail is missing older replies (or the
  // stream isn't synced yet); the live rail shows immediately, this only fills the
  // gap when online. Mirrors board-card's expand path.
  const incompleteLocally = source === "projection" || railReplies.length < totalReplies
  // Same gate as the card: rail coverage only, and the panel is permanently open.
  const {
    data: allMessages,
    isError: backfillFailed,
    refetch: refetchMessages,
  } = useConversationBackfill(workspaceId, conversation.id, {
    enabled: true,
    railCoversMembership,
    memberIds: conversation.messageIds,
    knownMessageIds,
  })

  const replies: RenderableMessage[] = railReplies
  // Merge the viewer's own just-sent replies (deduped), then sort by time — a
  // pending reply can be older than a confirmed one.
  const seenReplyIds = new Set(replies.map((m) => m.id))
  // Same as the board card: the backfill bypasses the hook's settling stamp, so
  // the merged list goes through the shared helper (already-marked rows return
  // by identity).
  const displayedReplies = applySettlingAll(
    [...replies, ...pendingReplies.filter((m) => !seenReplyIds.has(m.id))].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    ),
    settlingIds
  )
  const loadingMore = incompleteLocally && !allMessages && !backfillFailed

  const all = openingMessage ? [openingMessage, ...displayedReplies] : displayedReplies
  // A tombstone is render-only: it never participates in read state (auto-read or
  // the unread marker). It has no `data-message-id` row to scroll to, so anchoring
  // the marker on one would draw a divider that never scrolls (R6).
  const readableRows = all.filter((m) => !m.deletedAt)

  // Agent traces / memo captures / follow-ups on this conversation, interleaved
  // into the message rows. Render-only (STREAM_ROW_SPEC `bumps: false`) — kept out
  // of the read-state arrays (they are not members). A session shows iff its
  // invoking message is a conversation member.
  const memberMessageIds = useMemo(() => {
    const set = new Set<string>(conversation.messageIds)
    for (const message of all) set.add(message.id)
    return set
  }, [conversation.messageIds, all])
  const eventRows = useMemo(
    () => resolveBoardEventRows(railEvents, { conversationId: conversation.id, memberMessageIds, currentUserId }),
    [railEvents, conversation.id, memberMessageIds, currentUserId]
  )

  // Per-thread-boundary grouping — same derivation as the board card (the panel
  // is the always-expanded peer). Overflow rows link into the thread's own stream
  // panel here rather than back to this conversation.
  const { getPanelUrl } = usePanel()
  const occupiedStreamIds = useMemo(() => {
    const set = new Set<string>([conversation.streamId])
    for (const message of all) if (message.streamId) set.add(message.streamId)
    return set
  }, [conversation.streamId, all])
  // A nested branch's bodies resolve through the panel's merged rail — its server
  // `messageIds` unioned with the rows tagged with its id (a just-sent branch
  // reply rides the tag through its echo window). The panel is always expanded,
  // so every locally-available branch message shows; only unsynced members count
  // toward the "N more replies" link.
  const resolveBranchMessages = useCallback(
    (branchConversationId: string, branchMemberIds: string[]) => {
      const rows: RenderableMessage[] = []
      const seen = new Set<string>()
      for (const id of branchMemberIds) {
        const message = messagesById.get(id)
        if (!message) continue
        rows.push(message)
        seen.add(id)
      }
      for (const tagged of taggedByConversation.get(branchConversationId) ?? []) {
        if (!seen.has(tagged.id)) rows.push(tagged)
      }
      rows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      const knownTotal = Math.max(branchMemberIds.length, rows.length)
      return { messages: rows, hiddenCount: Math.max(0, knownTotal - rows.length) }
    },
    [messagesById, taggedByConversation]
  )
  const branchesByForkMessageId = useMemo(() => {
    const branches = deriveBranchConversations({
      conversationId: conversation.id,
      memberMessageIds: conversation.messageIds,
      index: structuralIndex,
      graph: conversationGraph,
      resolveMessages: resolveBranchMessages,
      excludeThreadStreamIds: occupiedStreamIds,
    })
    const byFork = new Map<string, BranchConversationView[]>()
    for (const branch of branches) {
      const list = byFork.get(branch.forkMessageId)
      if (list) list.push(branch)
      else byFork.set(branch.forkMessageId, [branch])
    }
    // In-flight sub-topic sends render as synthetic pending branches until the
    // graph takes over (one thread per fork, so a graph-covered fork wins).
    for (const branch of derivePendingBranches(messagesById)) {
      if (!byFork.has(branch.forkMessageId)) byFork.set(branch.forkMessageId, [branch])
    }
    return byFork
  }, [
    conversation.id,
    conversation.messageIds,
    structuralIndex,
    conversationGraph,
    resolveBranchMessages,
    occupiedStreamIds,
    derivePendingBranches,
    messagesById,
  ])
  const provenance = useMemo(
    () =>
      deriveBranchProvenance({
        conversationId: conversation.id,
        anchorStreamId: conversation.streamId,
        index: structuralIndex,
        graph: conversationGraph,
      }),
    [conversation.id, conversation.streamId, structuralIndex, conversationGraph]
  )
  // The panel's read state resolves with the workspace unread bootstrap AND the
  // per-stream frontiers the derivation actually consumes: a row whose leg has
  // no frontier yet derives as `ungated`, so latching before every spanned
  // stream can be decided would anchor the marker below the true first unread —
  // and the latch is one-way, so it would never correct.
  const unreadState = useWorkspaceUnreadState(workspaceId)
  const streamReadStates = useWorkspaceStreamReadStates(workspaceId)
  const readStateResolved = useMemo(() => {
    if (unreadState === undefined) return false
    const decidable = new Set(streamReadStates.map((row) => row.streamId))
    for (const [streamId, count] of Object.entries(unreadState.unreadCounts ?? {})) {
      if (count === 0) decidable.add(streamId)
    }
    for (const message of readableRows) {
      if (!decidable.has(message.streamId ?? conversation.streamId)) return false
    }
    return true
  }, [unreadState, streamReadStates, readableRows, conversation.streamId])
  // One reveal, not three: the header, the rail and the read state paint
  // together, never staggered. But the panel is a timeline (Kris's ruling,
  // 2026-08-01): cached rows render immediately and the server backfill fills
  // in behind them — `loadingMore` only holds the reveal when there is nothing
  // local to show, so a slow network never blanks a warm conversation. The
  // read-state wait stays in the gate (the divider belongs in the first frame,
  // and it resolves from IDB on a warm device).
  //
  // Either input can also fail to settle. `readStateResolved` is the known one:
  // the bootstrap builds BOTH `unreadCounts` and `streamReadState` from stream
  // MEMBERSHIPS, and a thread gets no `stream_members` row (INV-62), so a
  // conversation spanning a never-read thread leg holds a row decidable by
  // neither map, and no read event ever writes one. Gating on it unbounded would
  // hold a blank panel forever, so the wait is bounded across every input: the
  // divider (or a still-syncing leg) is worth a beat, never the whole panel.
  const panelLoading = (loadingMore && all.length === 0) || !readStateResolved
  const [revealTimedOut, setRevealTimedOut] = useState(false)
  useEffect(() => {
    setRevealTimedOut(false)
    if (!panelLoading) return
    const timer = setTimeout(() => setRevealTimedOut(true), REVEAL_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [conversation.id, panelLoading])
  // Latched in render, not in an effect: a latch that flips a commit later is
  // what made the header and the rows land on separate frames. Reset on a
  // conversation switch so the next one gets its own gate.
  const revealedRef = useRef<{ conversationId: string; revealed: boolean }>({
    conversationId: conversation.id,
    revealed: false,
  })
  if (revealedRef.current.conversationId !== conversation.id) {
    revealedRef.current = { conversationId: conversation.id, revealed: false }
  }
  if (!panelLoading || revealTimedOut) revealedRef.current.revealed = true
  const revealed = revealedRef.current.revealed
  // The shared coordinated-loading machine (INV-35): blank while the open is
  // young, a skeleton only once it is genuinely slow, content when revealed.
  const ownPhase = useCoordinatedPhase({ isLoading: !revealed, isReady: revealed })
  const stillLoadingPhase: CoordinatedPhase = ownPhase === "skeleton" || skeletonAlreadyVisible ? "skeleton" : "loading"
  const phase: CoordinatedPhase = revealed ? "ready" : stillLoadingPhase

  // Rows first, marker second: the marker may only anchor on a message that
  // actually gets a row (a message inside a depth-collapsed spanning subtree has
  // none, so a divider there would draw nothing and scroll nowhere).
  const baseRows = injectBoardDayDividers(
    buildBranchedBoardRows(
      groupBranches(all, { streams: structuralIndex.streamsById, conversation: { streamId: conversation.streamId } }),
      eventRows,
      branchesByForkMessageId,
      openingMessage?.id
    )
  )
  const renderedMessageIds = new Set<string>()
  for (const row of baseRows) if (row.kind === "message") renderedMessageIds.add(row.message.id)
  const { markerMessageId, unreadCount, isDimmed, dismiss } = useConversationUnreadMarker({
    conversationId: conversation.id,
    rows: readableRows,
    rootStreamId: conversation.streamId,
    rowState: conversationReadValue.state,
    currentUserId,
    readStateResolved,
    renderedMessageIds,
  })
  // Set while this conversation holds an unread marker: the composer's opening
  // re-pin must not force the tail out from under the marker's scroll (which
  // lands first, so a "pending" flag would already be clear by then).
  const markerHeldRef = useRef(false)
  const rows = injectUnreadDivider(baseRows, markerMessageId, isDimmed)
  // "Move to sub-topic" re-file — same gesture as the board card (membership move
  // within one root; the hook hides the action when a row has nowhere to go).
  const moveToSubtopic = useMoveToSubtopic({
    workspaceId,
    conversation,
    branchesByForkMessageId,
    hasSettlingRows: settlingIds.size > 0,
  })
  const renderMessage = (message: RenderableMessage, continuation: boolean) => {
    // Each row renders against its own stream so reactions and the permalink
    // target where the message actually lives (one root, many streams); fall
    // back to the anchor.
    const rowStreamId = message.streamId ?? conversation.streamId
    // Hide "New sub-topic" once a thread already exists under the message (a
    // populated thread would mix membership — "Split this thread" is the gesture
    // there, adjustment D).
    if (message.deletedAt) return <DeletedMessageEvent key={message.id} />
    const canBranch = !structuralIndex.threadsByAnchorId.has(message.id)
    return (
      <MessageItem
        key={message.id}
        workspaceId={workspaceId}
        streamId={rowStreamId}
        message={message}
        authorName={getActorName(message.authorId, message.authorType)}
        currentUserId={currentUserId}
        continuation={continuation}
        conversationId={conversation.id}
        conversationRootStreamId={conversation.streamId}
        isHighlighted={message.id === highlightMessageId}
        // Break the row out of the column's padding and re-pad it, so an actor
        // accent fills to the column edges (the stream-view look) with content
        // aligned — matching the board card and timeline.
        surfaceClassName="bg-background px-3 sm:px-6"
        rowInsetClassName="-mx-3 sm:-mx-6"
        onNewSubtopic={
          canBranch && !archivedReason ? () => inlineComposer.openNewSubtopic(rowStreamId, message.id) : undefined
        }
        onMoveToSubtopic={
          archivedReason ? undefined : moveToSubtopic.moveHandlerFor(message.id, conversation.id, message.settling)
        }
      />
    )
  }
  // A nested branch's rows are OUTSIDE this conversation: render-only (null read
  // provider — no mark-read/unread here) and identified as the CHILD conversation
  // so copy-link opens its panel. Same shape as the board card's.
  const renderBranchMessage = (branch: BranchConversationView, message: RenderableMessage, continuation: boolean) => {
    const canBranch = !structuralIndex.threadsByAnchorId.has(message.id)
    // Per-message spine color (persona gold / bot green / system) overlaying the
    // branch's neutral rail at that row; a user row stays plain so the neutral
    // grouping rail shows. See the board card's renderBranchMessage.
    const rail = actorRowTheme(message.authorType).railClassName
    return (
      <ConversationReadProvider value={null}>
        <MessageItem
          workspaceId={workspaceId}
          streamId={message.streamId ?? branch.threadStreamId}
          message={message}
          authorName={getActorName(message.authorId, message.authorType)}
          currentUserId={currentUserId}
          continuation={continuation}
          conversationId={branch.conversationId}
          conversationRootStreamId={branch.threadStreamId}
          surfaceClassName={rail ? cn("bg-background border-l-2 px-2 sm:px-3", rail) : "bg-background"}
          rowInsetClassName={rail ? "-mx-2.5 sm:-mx-3.5" : undefined}
          settlingRailClassName={rail ? BRANCH_ACCENTED_SETTLING_RAIL_CLASS : BRANCH_SETTLING_RAIL_CLASS}
          suppressRowAccent
          onNewSubtopic={
            canBranch && !archivedReason
              ? () => inlineComposer.openNewSubtopic(message.streamId ?? branch.threadStreamId, message.id)
              : undefined
          }
          onMoveToSubtopic={
            branch.pending || archivedReason
              ? undefined
              : moveToSubtopic.moveHandlerFor(message.id, branch.conversationId, message.settling)
          }
        />
      </ConversationReadProvider>
    )
  }
  // The conversation's most-recently-active stream — the latest reply's own stream
  // (a thread under the root), so a continuation follows the conversation there
  // instead of re-interleaving the channel (board-view-design.md). Falls back to
  // the conversation's anchor, NOT the opening message's stream (a thread post's
  // opener lives in the parent stream).
  const lastActiveStreamId = displayedReplies.at(-1)?.streamId ?? conversation.streamId

  // Scopes text-selection quoting to this panel's message list.
  const listRef = useRef<HTMLDivElement>(null)

  // True while any of the panel's composers (footer reply, branch tail, new
  // sub-topic) floats in the mobile pill over this panel.
  const anchor = useFloatingComposerAnchor()
  const anchorEl = anchor?.el ?? null
  const floatingComposerOpen = anchor?.claimantId != null

  const { scrollContainerRef, handleScroll, isScrolledFarFromBottom, scrollToBottom, disableAutoScroll } =
    useScrollBehavior({
      // The hook pins once: it must fire on the first frame that has rows, so
      // "loading" is "no rows on screen yet" — not the backfill's status (rows
      // now reveal while it is in flight; keying on it would spend the pin
      // late, yanking a panel the viewer already sees) and not `revealed` alone
      // (the reveal-timeout path mounts with zero rows, and the pin would land
      // against an empty container).
      isLoading: !revealed || rows.length === 0,
      itemCount: rows.length,
      resetKey: conversation.id,
      // Only treat the user as "at the bottom" when they are essentially flush, so
      // a small scroll-up to reference an older reply while typing is not snapped
      // back when the composer grows (thread-path parity).
      bottomThreshold: 4,
      skipInitialScroll: highlightMessageId != null || markerMessageId != null,
    })
  // Both consumers of `listRef` (text-selection quoting, viewport auto-read) are
  // keyed to the scroller node, so the two refs name the same element.
  const attachListRef = useCallback(
    (node: HTMLDivElement | null) => {
      listRef.current = node
      scrollContainerRef.current = node
    },
    [scrollContainerRef]
  )

  // The pill is absolutely positioned, so its growth changes only the scroller's
  // padding-bottom — the scroller's own ResizeObserver never sees it. Re-pin from
  // the published height instead: forced pre-paint on the first measurement (the
  // opening anchor correction), and follow-flag-respecting afterwards so a user
  // scrolled up to read history is not yanked to the tail.
  const scrollToBottomRef = useRef(scrollToBottom)
  scrollToBottomRef.current = scrollToBottom
  const handleComposerHeightChange = useCallback(
    (_px: number, opts: { initial: boolean }) => {
      // Only the OPENING force-scroll defers to the panel's opening anchor (a
      // `?m=` row, or an unread marker held until dismissed): a child layout
      // effect runs before the parent's marker effect, so on a first-commit
      // latch this fires first and the guard is what saves the marker's scroll.
      // The runtime re-pin is unconditional — it is the un-forced call, which
      // no-ops unless the user is already at the bottom, so the tail can't slide
      // behind a growing composer.
      if (opts.initial) {
        if (highlightMessageId != null || markerHeldRef.current) return
        scrollToBottomRef.current({ force: true })
      } else {
        requestAnimationFrame(() => scrollToBottomRef.current())
      }
    },
    [highlightMessageId]
  )
  const shellRef = useFloatingComposerHeight({
    anchorEl,
    ownerId: "panel-root",
    active: !floatingComposerOpen && anchorEl != null,
    onHeightChange: handleComposerHeightChange,
  })

  // Viewport auto-read: every rendered row is eligible. While older replies are
  // still backfilling, the cutoff through a rendered row also covers the not-
  // yet-fetched middle — deliberate, same as the board card: reading the
  // conversation's visible tail reads it up to there.
  const autoReadRows = readableRows
  useConversationAutoRead({
    containerRef: listRef,
    messages: autoReadRows,
    rootStreamId: conversation.streamId,
    rowState: conversationReadValue.state,
    markRead: markReadSilently,
    registerExplicitUnread: setExplicitUnreadListener,
    getReadTruth,
  })

  const findMarkerRow = useCallback(() => {
    const container = listRef.current
    if (!container || !markerMessageId) return null
    return container.querySelector<HTMLElement>(`[data-message-id="${markerMessageId}"]`)
  }, [markerMessageId])
  const scrollToMarker = useCallback(() => {
    const row = findMarkerRow()
    if (!row) return false
    disableAutoScroll()
    row.scrollIntoView({ block: "start" })
    return true
  }, [findMarkerRow, disableAutoScroll])

  // Open at the first unread instead of the tail. Runs on every render until it
  // lands: the one-shot is consumed ONLY once a scroll actually happened, so a
  // render where the marker's row is not in the DOM yet (rows still loading)
  // leaves it armed rather than parking the panel at the bottom with a divider
  // the user was never taken to. `?m=` wins — its own row scroll is the intent.
  // The body is not keyed on the conversation, so it survives a switch: the
  // one-shot is reset here in render on conversation change, never inferred from
  // the key differing — a switch away and back re-latches the same message id,
  // and a ref still holding it would leave the revisit scrolling nowhere at all.
  const scrolledMarkerRef = useRef<{ conversationId: string; key: string | null }>({
    conversationId: conversation.id,
    key: null,
  })
  if (scrolledMarkerRef.current.conversationId !== conversation.id) {
    scrolledMarkerRef.current = { conversationId: conversation.id, key: null }
  }
  markerHeldRef.current = markerMessageId != null
  const markerScrollKey = markerMessageId
  useEffect(() => {
    if (highlightMessageId != null || markerScrollKey == null) return
    if (scrolledMarkerRef.current.key === markerScrollKey) return
    if (scrollToMarker()) scrolledMarkerRef.current.key = markerScrollKey
  })

  // The banner shows only while the divider has left the top of the viewport.
  const [markerAboveViewport, setMarkerAboveViewport] = useState(false)
  const syncMarkerPosition = useCallback(() => {
    const container = listRef.current
    const row = findMarkerRow()
    setMarkerAboveViewport(
      container != null && row != null && row.getBoundingClientRect().top < container.getBoundingClientRect().top
    )
  }, [findMarkerRow])
  useEffect(syncMarkerPosition)
  const handleListScroll = useCallback(() => {
    handleScroll()
    syncMarkerPosition()
  }, [handleScroll, syncMarkerPosition])

  return (
    // Quote reply from a row routes into this conversation's reply composer.
    <ConversationReadProvider value={conversationReadValue}>
      <ConversationPanelHeader {...header} phase={phase} />
      {/* `relative` + the anchor: on mobile an open reply/branch composer portals
          to this container's bottom as the shared floating pill (same as the
          stream page) instead of sitting in the scrolled flow. */}
      <SidePanelContent ref={contentRef} className="relative flex flex-col">
        <QuoteReplyProvider disabled={!!archivedReason}>
          {/* Desktop text-selection → floating "Quote" button, scoped to this list. */}
          {!archivedReason && <TextSelectionQuote streamId={conversation.streamId} containerRef={listRef} />}
          {moveToSubtopic.moveDialog}
          <div
            ref={attachListRef}
            onScroll={handleListScroll}
            // pt-4 reserves headroom for the first row's hover toolbar, which floats
            // ~14px above its row (MessageItem's float-above chip). Without it the
            // scroll container's top edge clips the first message's toolbar — the
            // stream timeline reserves the same room via its header spacer.
            className="min-h-0 flex-1 overflow-y-auto pt-4"
            // pb-3 baseline, plus room for the floating composer pill so the
            // conversation tail can scroll above it.
            style={{ paddingBottom: `calc(var(${FLOATING_COMPOSER_HEIGHT_VAR}, 0px) + 0.75rem)` }}
          >
            <div className="mx-auto w-full min-w-0 max-w-[800px] px-3 sm:px-6">
              {phase === "skeleton" && <ConversationRowsSkeleton />}
              {revealed && provenance && (
                <BranchProvenanceRow conversationId={provenance.parentConversationId} title={provenance.title} />
              )}
              {revealed && (
                <BranchedBoardRows
                  rows={rows}
                  workspaceId={workspaceId}
                  renderMessage={renderMessage}
                  continueThreadTo={(streamId) => getPanelUrl(streamId)}
                  onSplitThread={(threadStreamId) =>
                    splitThread.mutate({ conversationId: conversation.id, threadStreamId })
                  }
                  renderBranchMessage={renderBranchMessage}
                  renderBranchTail={archivedReason ? undefined : inlineComposer.renderBranchTail}
                  renderAfterMessage={archivedReason ? undefined : inlineComposer.renderAfterMessage}
                  onRedirectSession={() => setFocusSeq((n) => n + 1)}
                />
              )}
              {revealed && loadingMore && (
                <span className="mt-3 block text-xs text-muted-foreground">Loading messages…</span>
              )}
              {backfillFailed && (
                <button
                  type="button"
                  onClick={() => void refetchMessages()}
                  className="mt-3 block w-fit text-xs text-destructive underline underline-offset-2"
                >
                  Couldn't load the full conversation. Retry.
                </button>
              )}
            </div>
          </div>
          {markerMessageId != null && markerAboveViewport && unreadCount > 0 && (
            // Same affordance as the timeline's, in the same place: below the
            // header, clear of the top-center chrome.
            <div
              className="pointer-events-none absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5"
              style={{ top: "3.5rem" }}
            >
              <Button
                variant="secondary"
                size="sm"
                className="pointer-events-auto gap-1.5 shadow-lg"
                onClick={() => scrollToMarker()}
              >
                <ArrowUp className="h-3.5 w-3.5" />
                {unreadCount} new message{unreadCount === 1 ? "" : "s"}
              </Button>
              {/* Drop the marker and tail the live bottom without scrolling up.
                Read state is not written here — the panel is read-only over it
                (INV-62); auto-read handles rows as they enter the viewport. */}
              <Button
                variant="secondary"
                size="icon"
                className="pointer-events-auto h-9 w-9 shadow-lg"
                onClick={() => {
                  dismiss()
                  scrollToBottom({ force: true })
                }}
                aria-label="Dismiss unread marker"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}
          {isScrolledFarFromBottom && (
            <div
              className="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2"
              style={{ bottom: `calc(var(${FLOATING_COMPOSER_HEIGHT_VAR}, 0px) + 0.5rem)` }}
            >
              <Button
                variant="secondary"
                size="sm"
                className="pointer-events-auto gap-1.5 shadow-lg"
                onClick={() => scrollToBottom({ force: true })}
              >
                <ArrowDown className="h-3.5 w-3.5" />
                Jump to latest
              </Button>
            </div>
          )}
          {/* Hidden while a mobile composer floats over the panel (the pill replaces
            the footer's affordance; a second bottom bar under it would double up).
            `hidden`, not unmount — the reply composer inside must stay mounted to
            keep its portal, draft, and open state alive. */}
          <FloatingComposerShell ref={shellRef} hidden={floatingComposerOpen}>
            <BoardReplyComposer
              workspaceId={workspaceId}
              post={post}
              hostStreamType={hostStreamType}
              lastActiveStreamId={lastActiveStreamId}
              openReplySignal={focusSeq}
              // The panel is a dedicated conversation view — the composer is docked
              // at the footer on both platforms (mobile shows MessageComposer's own
              // collapsed bar), never a resting button. `armedReply` retargets it to
              // a sub-conversation when a branch reply is armed.
              alwaysDocked
              armedReply={armedReply}
              disabled={!!archivedReason}
              disabledReason={archivedReason}
            />
          </FloatingComposerShell>
        </QuoteReplyProvider>
      </SidePanelContent>
    </ConversationReadProvider>
  )
}
