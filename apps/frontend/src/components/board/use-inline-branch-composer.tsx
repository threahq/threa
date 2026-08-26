import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { CornerDownRight } from "lucide-react"
import { StreamTypes } from "@threa/types"
import { useQueueDraftMessage } from "@/hooks/use-queue-draft-message"
import { useBoardSubtopicDraftIndex, useScopeDraftPreview, useStashParamDraftRow } from "@/hooks"
import type { SubtopicDraftEntry } from "@/hooks"
import { rescopeScopeDrafts } from "@/hooks/use-draft-message"
import { parseBoardDraftKey } from "@/lib/board/draft-keys"
import { effectiveConversationTitle } from "@/lib/conversations/title"
import { CollapsedComposerBar } from "@/components/composer/collapsed-composer-bar"
import { createDraftPanelId } from "@/contexts"
import { collectBranchThreadStreamIds } from "@/hooks/use-conversation-graph"
import { InlineComposerForm, type InlineComposerSubmit } from "@/components/board/board-inline-composer"
import { boardBranchReplyDraftKey, boardSubtopicDraftKey } from "@/lib/board/draft-keys"
import type { BranchConversationView } from "@/lib/board/branch-grouping"
import type { ConversationGraph, StreamStructuralIndex } from "@/hooks/use-conversation-graph"
import type { RenderableMessage } from "@/components/message/message-item"

/** The single inline composer a conversation surface has open (one per surface —
 *  opening another closes the first). Either a "new sub-topic" gesture under a
 *  message row, or a reply at a nested branch's tail. */
export type OpenInlineComposer =
  | { kind: "new-subtopic"; streamId: string; messageId: string; restoreStashedId?: string | null }
  | { kind: "branch-reply"; conversationId: string; threadStreamId: string; restoreStashedId?: string | null }

const E2E_REPLY_MESSAGE = "Encrypted notes can't be replied to from the board yet — open the note to reply there."
const E2E_SUBTOPIC_MESSAGE = "Can't start a sub-topic in an encrypted note here."

/**
 * The collapsed branch-tail affordance: the shared collapsed-composer bar
 * (timeline parity), preceded by the `CornerDownRight` sub-conversation arrow
 * kept OUTSIDE the bar so the affordance still reads as a reply INTO the branch
 * (round-4 discoverability). With an unsent draft it shows the draft's first
 * line; otherwise the "Reply…" placeholder. `onOpen` receives the stash row to
 * check out when the advertised draft isn't loaded on this device.
 */
function BranchTailAffordance({
  workspaceId,
  scope,
  onOpen,
}: {
  workspaceId: string
  scope: string
  onOpen: (restoreStashedId: string | null) => void
}) {
  const draft = useScopeDraftPreview(workspaceId, scope)
  return (
    <div className="mt-3 flex items-center gap-2">
      <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <CollapsedComposerBar
        className="flex-1"
        draft={draft}
        placeholder="Reply…"
        onClick={() => onOpen(draft && !draft.isCheckedOut ? draft.draftId : null)}
      />
    </div>
  )
}

/**
 * Marks a message row whose "new sub-topic" gesture holds an unsent draft while
 * that composer is unmounted: the `CornerDownRight` branch arrow + the same
 * collapsed-composer bar the branch tail uses (one presentation for a
 * sub-conversation draft whether or not the branch has materialized — Kris
 * 2026-07-13), clickable to reopen the gesture with the draft in it. Rendered
 * only while NO branch exists under the message; once one materializes, the
 * draft is rescoped onto its tail (see the migration effect in the hook) so this
 * and the branch never show together.
 */
function SubtopicDraftIndicator({
  entry,
  onOpen,
}: {
  entry: SubtopicDraftEntry
  onOpen: (restoreStashedId: string | null) => void
}) {
  return (
    <div className="mt-2 flex items-center gap-2">
      <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <CollapsedComposerBar
        className="flex-1"
        draft={entry}
        placeholder="Reply…"
        onClick={() => onOpen(entry.isCheckedOut ? null : entry.draftId)}
      />
    </div>
  )
}

/**
 * The inline reply + "new sub-topic" composers a conversation surface (board card
 * / conversation panel) hosts, plus the branch-thread rail bookkeeping they need
 * — extracted so both surfaces share one implementation (INV-35, Kris dogfood
 * ruling 2026-07-05: replying happens inline on the card, never bouncing into a
 * thread/panel view).
 *
 * Called BEFORE the surface's `useBoardCardMessages` so its outputs
 * (`branchStreamIds`, `extraDraftPanelIds`) feed that hook's extra rails:
 *
 *  - **`branchStreamIds`** — every branch thread the card renders nested (graph
 *    only), subscribed as EXTRA rails so their bodies load without gating.
 *  - **`extraDraftPanelIds`** — the draft-panel rail of an open/pending "new
 *    sub-topic" send, kept until its thread materializes so the optimistic
 *    message doesn't blink out before the `conversation:created` echo.
 *
 * The send seams are the declared, determinable gestures:
 * a branch reply queues `{ intent: "existing", conversationId }` into the
 * branch's thread; a new sub-topic queues `streamCreation` + `{ intent:
 * "newSubtopic" }`. Nothing is created until the user sends.
 */
/** A materialized sub-conversation a docked composer can be armed to reply into. */
export interface ArmBranchTarget {
  conversationId: string
  threadStreamId: string
  title: string
}

export function useInlineBranchComposer(params: {
  workspaceId: string
  conversationId: string
  /** The parent conversation's server member ids — the branch fork candidates. */
  memberMessageIds: string[]
  index: StreamStructuralIndex
  graph: ConversationGraph
  /**
   * Panel arming: when set, a non-pending branch's Reply arms the surface's
   * docked footer composer at that target instead of mounting a mid-flow inline
   * form (Kris's composer ruling — the panel is a dedicated conversation view,
   * so replies dock at the bottom). Board cards omit it and keep the inline
   * model. Pending branches always stay inline (no real conversation id to arm).
   */
  onArmBranchReply?: (target: ArmBranchTarget, restoreStashedId: string | null) => void
  /**
   * The surface is read-only (archived conversation/root — INV-62): it renders no
   * inline composers, so an open one is dropped here rather than stranded — the
   * form that would have called `onClose` is already unmounted, and a stranded
   * `openComposer` keeps a dead draft-panel rail subscribed, force-pins its
   * branch, and blocks the sub-topic-draft rescope effect. A `?stash=` deep link
   * is likewise neither opened nor consumed, so it stays retryable elsewhere.
   */
  archived?: boolean
}): {
  branchStreamIds: string[]
  extraDraftPanelIds: string[]
  openComposer: OpenInlineComposer | null
  openNewSubtopic: (streamId: string, messageId: string) => void
  openBranchReply: (branch: BranchConversationView) => void
  /** Send a reply into an already-materialized branch (the armed docked path). */
  queueExistingBranchReply: (
    conversationId: string,
    threadStreamId: string,
    input: InlineComposerSubmit
  ) => Promise<void>
  renderAfterMessage: (messageId: string) => ReactNode
  renderBranchTail: (branch: BranchConversationView) => ReactNode
  /** Synthetic branch groups for in-flight sub-topic sends, resolved against the
   *  card's merged rail — so the just-sent message renders nested immediately,
   *  before the `conversation:created` echo hands rendering to the graph. */
  derivePendingBranches: (messagesById: Map<string, RenderableMessage>) => BranchConversationView[]
} {
  const { workspaceId, conversationId, memberMessageIds, index, graph, onArmBranchReply, archived = false } = params
  const { queueDraftMessage } = useQueueDraftMessage(workspaceId)
  const [openComposer, setOpenComposer] = useState<OpenInlineComposer | null>(null)
  // Draft panels of "new sub-topic" sends still in flight — kept subscribed until
  // their thread stream exists, so the optimistic message rides its draft rail
  // across the pre-promotion window (mirrors the lone-post convert-to-thread).
  const [pendingSubtopics, setPendingSubtopics] = useState<Array<{ streamId: string; messageId: string }>>([])

  const closeComposer = useCallback(() => setOpenComposer(null), [])

  useEffect(() => {
    if (archived) setOpenComposer(null)
  }, [archived])

  const openNewSubtopic = useCallback(
    (streamId: string, messageId: string, restoreStashedId: string | null = null) =>
      setOpenComposer({ kind: "new-subtopic", streamId, messageId, restoreStashedId }),
    []
  )
  const openBranchReply = useCallback(
    (branch: BranchConversationView, restoreStashedId: string | null = null) =>
      setOpenComposer({
        kind: "branch-reply",
        conversationId: branch.conversationId,
        threadStreamId: branch.threadStreamId,
        restoreStashedId,
      }),
    []
  )

  // Unsent sub-topic drafts by fork message id — marks the rows whose gesture
  // composer is unmounted but holds a draft (rendered by `renderAfterMessage`).
  const subtopicDraftIndex = useBoardSubtopicDraftIndex(workspaceId)

  // A "new sub-topic" draft is a reply into a branch that doesn't exist yet;
  // the moment the branch materializes they are the same target, so the draft
  // follows it onto the branch scope (loaded pointer and stash siblings alike,
  // server-mirrored). Without this a stash from before the branch existed
  // lingers as a second "create a sub-conversation" affordance NEXT TO the
  // branch it was for (Kris's screenshots, 2026-07-13). Skipped while this
  // surface has an inline composer open — a live editor's flushes would race
  // the move; the effect re-fires once it closes (or another surface, both are
  // idempotent: the rescope no-ops on rows already moved).
  useEffect(() => {
    if (openComposer !== null) return
    for (const entry of subtopicDraftIndex.values()) {
      const thread = index.threadsByAnchorId.get(entry.messageId)
      if (!thread) continue
      const branchPost = graph.conversationByAnchorStreamId.get(thread.id)
      if (!branchPost) continue
      void rescopeScopeDrafts(workspaceId, entry.scope, boardBranchReplyDraftKey(branchPost.id))
    }
  }, [subtopicDraftIndex, index, graph, workspaceId, openComposer])

  const memberKey = memberMessageIds.join(",")
  const branchStreamIds = useMemo(
    () => collectBranchThreadStreamIds({ conversationId, memberMessageIds, index, graph }),
    // memberMessageIds captured via memberKey (stable string, not the array ref).
    [conversationId, memberKey, index, graph]
  )

  // A drafts-explorer deep link (`?stash=<draftId>`) targeting a branch-tail or
  // new-sub-topic draft lands with those composers unmounted (they exist only
  // while their gesture is open), so this surface opens the right one when the
  // named draft's scope belongs to a branch/member of THIS conversation —
  // ownership is structural (the branch threads this surface renders / the
  // fork message's owning conversation), since sub-topic conversations carry no
  // `parentConversationId`. The mounted form's own `useStashComposer` then
  // restores the row and strips the param; the panel's bottom reply handles
  // `board:reply:*` the same way.
  const stashTarget = useStashParamDraftRow(workspaceId)
  const consumedStashRef = useRef<string | null>(null)
  useEffect(() => {
    if (archived) return
    if (!stashTarget || consumedStashRef.current === stashTarget.draftId) return
    const parsed = parseBoardDraftKey(stashTarget.scope)
    if (!parsed || parsed.kind === "reply") return
    if (parsed.kind === "branch-reply") {
      const branchPost = graph.conversationById.get(parsed.conversationId)
      const threadStreamId = branchPost?.conversation.streamId
      if (!threadStreamId || !branchStreamIds.includes(threadStreamId)) return
      consumedStashRef.current = stashTarget.draftId
      // Panel: arm the docked footer at the branch (with restore); board card
      // opens the inline branch composer.
      if (onArmBranchReply) {
        onArmBranchReply(
          {
            conversationId: parsed.conversationId,
            threadStreamId,
            title:
              effectiveConversationTitle(
                branchPost.conversation,
                [...index.threadsByAnchorId.values()].find((stream) => stream.id === threadStreamId)
              ) ?? "sub-topic",
          },
          stashTarget.draftId
        )
        return
      }
      setOpenComposer({ kind: "branch-reply", conversationId: parsed.conversationId, threadStreamId })
      return
    }
    if (graph.conversationIdByMemberMessageId.get(parsed.messageId) !== conversationId) return
    consumedStashRef.current = stashTarget.draftId
    setOpenComposer({ kind: "new-subtopic", streamId: parsed.streamId, messageId: parsed.messageId })
  }, [stashTarget, graph, branchStreamIds, conversationId, onArmBranchReply, archived])

  // The composer's own pending→graph hand-off: a pending branch is keyed by the
  // synthetic draft-panel id, so once the graph replaces it with the real child
  // an untouched `openComposer` matches no rendered branch — `renderBranchTail`
  // unmounts the live editor and the branch's pin drops. Re-key it onto the real
  // conversation/thread. Declared BEFORE the drop effect below so the pending
  // entry it reads is still registered on the commit that materializes.
  useEffect(() => {
    if (openComposer?.kind !== "branch-reply") return
    const openConversationId = openComposer.conversationId
    const pending = pendingSubtopics.find((p) => createDraftPanelId(p.streamId, p.messageId) === openConversationId)
    if (!pending) return
    const threadId = index.threadsByAnchorId.get(pending.messageId)?.id
    if (!threadId) return
    const childPost = graph.conversationByAnchorStreamId.get(threadId)
    if (!childPost) return
    setOpenComposer((current) =>
      current?.kind === "branch-reply" && current.conversationId === openConversationId
        ? { ...current, conversationId: childPost.id, threadStreamId: threadId }
        : current
    )
  }, [openComposer, pendingSubtopics, index, graph])

  // A pending sub-topic is handed to the graph path only once BOTH its thread
  // stream exists (promotion) AND the child conversation is cached — dropping it
  // at thread creation alone would blank the message for the beat until the
  // `conversation:created` echo lands.
  const isGraphRendered = useCallback(
    (p: { messageId: string }) => {
      const threadId = index.threadsByAnchorId.get(p.messageId)?.id
      return !!threadId && graph.conversationByAnchorStreamId.has(threadId)
    },
    [index, graph]
  )
  useEffect(() => {
    setPendingSubtopics((prev) => {
      const next = prev.filter((p) => !isGraphRendered(p))
      return next.length === prev.length ? prev : next
    })
  }, [isGraphRendered])

  const extraDraftPanelIds = useMemo(() => {
    const ids = new Set<string>()
    if (openComposer?.kind === "new-subtopic")
      ids.add(createDraftPanelId(openComposer.streamId, openComposer.messageId))
    for (const p of pendingSubtopics) {
      // Both rails: the optimistic row starts on the draft panel and is swapped
      // onto the real thread stream at promotion — subscribe across the hand-off.
      ids.add(createDraftPanelId(p.streamId, p.messageId))
      const threadId = index.threadsByAnchorId.get(p.messageId)?.id
      if (threadId) ids.add(threadId)
    }
    return [...ids]
  }, [openComposer, pendingSubtopics, index])

  const derivePendingBranches = useCallback(
    (messagesById: Map<string, RenderableMessage>): BranchConversationView[] => {
      const out: BranchConversationView[] = []
      for (const p of pendingSubtopics) {
        const draftPanelId = createDraftPanelId(p.streamId, p.messageId)
        const threadId = index.threadsByAnchorId.get(p.messageId)?.id
        const rows: RenderableMessage[] = []
        for (const message of messagesById.values()) {
          if (message.streamId === draftPanelId || (threadId && message.streamId === threadId)) rows.push(message)
        }
        if (rows.length === 0) continue
        rows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        out.push({
          conversationId: draftPanelId,
          threadStreamId: threadId ?? draftPanelId,
          forkMessageId: p.messageId,
          title: "New sub-topic",
          displayDepth: 1,
          overflow: false,
          messages: rows,
          memberMessageIds: rows.map((m) => m.id),
          hiddenCount: 0,
          children: [],
          pending: true,
        })
      }
      return out
    },
    [pendingSubtopics, index]
  )

  // The declared sub-topic send, shared by the opening gesture and a reply on a
  // still-pending branch: the thread find-or-creates (`insertThreadOrFind`) and
  // the conversation mints-or-attaches (INV-20), so repeated sends through this
  // path converge on one child no matter which echo lands first.
  const queueSubtopicSend = useCallback(
    async (streamId: string, messageId: string, input: InlineComposerSubmit) => {
      const draftPanelId = createDraftPanelId(streamId, messageId)
      await queueDraftMessage(input, {
        workspaceId,
        streamId: draftPanelId,
        streamCreation: { type: StreamTypes.THREAD, parentStreamId: streamId, parentAnchorId: messageId },
        draftId: draftPanelId,
        conversation: { intent: "newSubtopic" },
      })
    },
    [queueDraftMessage, workspaceId]
  )

  const submitNewSubtopic = useCallback(
    async (streamId: string, messageId: string, input: InlineComposerSubmit) => {
      // Register BEFORE sending: the send publishes its optimistic row in the
      // sending tick, and `derivePendingBranches` renders rows only for a
      // registered entry (one with no rows renders nothing, so the rollback below
      // never flashes an empty group).
      setPendingSubtopics((prev) =>
        prev.some((p) => p.streamId === streamId && p.messageId === messageId)
          ? prev
          : [...prev, { streamId, messageId }]
      )
      try {
        await queueSubtopicSend(streamId, messageId, input)
      } catch (err) {
        setPendingSubtopics((prev) => prev.filter((p) => !(p.streamId === streamId && p.messageId === messageId)))
        throw err
      }
    },
    [queueSubtopicSend]
  )

  const pendingEntryFor = useCallback(
    (branch: BranchConversationView) =>
      branch.pending ? pendingSubtopics.find((p) => p.messageId === branch.forkMessageId) : undefined,
    [pendingSubtopics]
  )

  const queueExistingBranchReply = useCallback(
    async (branchConversationId: string, threadStreamId: string, input: InlineComposerSubmit) => {
      await queueDraftMessage(input, {
        workspaceId,
        streamId: threadStreamId,
        conversation: { intent: "existing", conversationId: branchConversationId },
      })
    },
    [queueDraftMessage, workspaceId]
  )

  const submitBranchReply = useCallback(
    async (branch: BranchConversationView, input: InlineComposerSubmit) => {
      // A pending branch's child conversation id isn't known yet (its echo
      // hasn't landed — possibly never will on a dropped socket), so an
      // `existing` directive has nothing real to name. Route through the
      // sub-topic path instead; it converges on the same child.
      const pendingEntry = pendingEntryFor(branch)
      if (pendingEntry) {
        await queueSubtopicSend(pendingEntry.streamId, pendingEntry.messageId, input)
        return
      }
      await queueExistingBranchReply(branch.conversationId, branch.threadStreamId, input)
    },
    [queueExistingBranchReply, pendingEntryFor, queueSubtopicSend]
  )

  const renderAfterMessage = useCallback(
    (messageId: string): ReactNode => {
      if (openComposer?.kind === "new-subtopic" && openComposer.messageId === messageId) {
        const { streamId } = openComposer
        return (
          <InlineComposerForm
            workspaceId={workspaceId}
            streamId={streamId}
            memoAnchorStreamId={streamId}
            draftKey={boardSubtopicDraftKey(streamId, messageId)}
            placeholder="Start a sub-topic…"
            rejectE2e={E2E_SUBTOPIC_MESSAGE}
            commandConversationId={conversationId}
            restoreStashedIdOnMount={openComposer.restoreStashedId ?? null}
            onSubmit={(sendInput) => submitNewSubtopic(streamId, messageId, sendInput)}
            onClose={closeComposer}
          />
        )
      }
      const entry = subtopicDraftIndex.get(messageId)
      if (entry) {
        // A materialized branch owns this draft (the migration effect is moving
        // it onto the tail); never render the "create a sub-conversation"
        // affordance next to the sub-conversation it was for.
        const thread = index.threadsByAnchorId.get(messageId)
        const materialized = thread !== undefined && graph.conversationByAnchorStreamId.has(thread.id)
        if (materialized) return null
        return (
          <SubtopicDraftIndicator
            entry={entry}
            onOpen={(restoreStashedId) => openNewSubtopic(entry.streamId, messageId, restoreStashedId)}
          />
        )
      }
      return null
    },
    [openComposer, workspaceId, submitNewSubtopic, closeComposer, subtopicDraftIndex, openNewSubtopic, index, graph]
  )

  const renderBranchTail = useCallback(
    (branch: BranchConversationView): ReactNode => {
      // A pending branch's conversation id is a synthetic draft-panel id that
      // dies when the echo lands — a draft keyed by it would orphan at
      // promotion. Key by the fork message (the sub-topic scope, the one
      // stable identity across the hand-off); the send routes through the same
      // converging sub-topic path either way. The collapsed affordance
      // advertises the same scope so preview and hydrate can't diverge.
      const pendingEntry = pendingEntryFor(branch)
      const tailDraftKey = pendingEntry
        ? boardSubtopicDraftKey(pendingEntry.streamId, pendingEntry.messageId)
        : boardBranchReplyDraftKey(branch.conversationId)
      if (openComposer?.kind === "branch-reply" && openComposer.conversationId === branch.conversationId) {
        // A pending branch's thread may not exist yet — host the composer on the
        // parent stream (mention context + E2E gate), like the opening gesture.
        const hostStreamId = pendingEntry?.streamId ?? branch.threadStreamId
        return (
          <InlineComposerForm
            workspaceId={workspaceId}
            streamId={hostStreamId}
            memoAnchorStreamId={hostStreamId}
            draftKey={tailDraftKey}
            placeholder="Reply…"
            // A pending branch's `title` is the "New sub-topic" placeholder (the
            // real topic isn't extracted until the echo), so name the target
            // generically rather than echoing the placeholder back.
            contextChip={branch.pending ? "Replying in this sub-topic" : `Replying in ${branch.title}`}
            rejectE2e={E2E_REPLY_MESSAGE}
            // A pending branch's conversation id is a synthetic draft-panel id
            // (no real target until the echo lands), so scheduling waits for it.
            scheduleTarget={
              branch.pending ? undefined : { streamId: branch.threadStreamId, conversationId: branch.conversationId }
            }
            // The PARENT conversation, not the branch: command chips render via
            // resolveBoardEventRows, which only the parent card/panel runs — a
            // child-stamped chip would land on no visible surface.
            commandConversationId={conversationId}
            restoreStashedIdOnMount={openComposer.restoreStashedId ?? null}
            onSubmit={(sendInput) => submitBranchReply(branch, sendInput)}
            onClose={closeComposer}
          />
        )
      }
      // Panel: a materialized branch arms the docked footer composer; the board
      // card (no `onArmBranchReply`) and any pending branch open inline.
      const canArm = onArmBranchReply && !branch.pending
      return (
        <BranchTailAffordance
          workspaceId={workspaceId}
          scope={tailDraftKey}
          onOpen={(restoreStashedId) =>
            canArm
              ? onArmBranchReply(
                  { conversationId: branch.conversationId, threadStreamId: branch.threadStreamId, title: branch.title },
                  restoreStashedId
                )
              : openBranchReply(branch, restoreStashedId)
          }
        />
      )
    },
    [openComposer, workspaceId, submitBranchReply, closeComposer, openBranchReply, pendingEntryFor, onArmBranchReply]
  )

  return {
    branchStreamIds,
    extraDraftPanelIds,
    openComposer,
    openNewSubtopic,
    openBranchReply,
    queueExistingBranchReply,
    renderAfterMessage,
    renderBranchTail,
    derivePendingBranches,
  }
}
