import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Reply } from "lucide-react"
import { StreamTypes } from "@threa/types"
import { useQueueDraftMessage } from "@/hooks/use-queue-draft-message"
import { useStashParamDraftRow } from "@/hooks"
import { parseBoardDraftKey } from "@/lib/board/draft-keys"
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
  | { kind: "new-subtopic"; streamId: string; messageId: string }
  | { kind: "branch-reply"; conversationId: string; threadStreamId: string }

const E2E_REPLY_MESSAGE = "Encrypted notes can't be replied to from the board yet — open the note to reply there."
const E2E_SUBTOPIC_MESSAGE = "Can't start a sub-topic in an encrypted note here."

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
 * The send seams are the declared, determinable gestures (board-view-design.md):
 * a branch reply queues `{ intent: "existing", conversationId }` into the
 * branch's thread; a new sub-topic queues `streamCreation` + `{ intent:
 * "newSubtopic" }`. Nothing is created until the user sends.
 */
export function useInlineBranchComposer(params: {
  workspaceId: string
  conversationId: string
  /** The parent conversation's server member ids — the branch fork candidates. */
  memberMessageIds: string[]
  index: StreamStructuralIndex
  graph: ConversationGraph
}): {
  branchStreamIds: string[]
  extraDraftPanelIds: string[]
  openComposer: OpenInlineComposer | null
  openNewSubtopic: (streamId: string, messageId: string) => void
  openBranchReply: (branch: BranchConversationView) => void
  renderAfterMessage: (messageId: string) => ReactNode
  renderBranchTail: (branch: BranchConversationView) => ReactNode
  /** Synthetic branch groups for in-flight sub-topic sends, resolved against the
   *  card's merged rail — so the just-sent message renders nested immediately,
   *  before the `conversation:created` echo hands rendering to the graph. */
  derivePendingBranches: (messagesById: Map<string, RenderableMessage>) => BranchConversationView[]
} {
  const { workspaceId, conversationId, memberMessageIds, index, graph } = params
  const { queueDraftMessage } = useQueueDraftMessage(workspaceId)
  const [openComposer, setOpenComposer] = useState<OpenInlineComposer | null>(null)
  // Draft panels of "new sub-topic" sends still in flight — kept subscribed until
  // their thread stream exists, so the optimistic message rides its draft rail
  // across the pre-promotion window (mirrors the lone-post convert-to-thread).
  const [pendingSubtopics, setPendingSubtopics] = useState<Array<{ streamId: string; messageId: string }>>([])

  const closeComposer = useCallback(() => setOpenComposer(null), [])
  const openNewSubtopic = useCallback(
    (streamId: string, messageId: string) => setOpenComposer({ kind: "new-subtopic", streamId, messageId }),
    []
  )
  const openBranchReply = useCallback(
    (branch: BranchConversationView) =>
      setOpenComposer({
        kind: "branch-reply",
        conversationId: branch.conversationId,
        threadStreamId: branch.threadStreamId,
      }),
    []
  )

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
    if (!stashTarget || consumedStashRef.current === stashTarget.draftId) return
    const parsed = parseBoardDraftKey(stashTarget.scope)
    if (!parsed || parsed.kind === "reply") return
    if (parsed.kind === "branch-reply") {
      const threadStreamId = graph.conversationById.get(parsed.conversationId)?.conversation.streamId
      if (!threadStreamId || !branchStreamIds.includes(threadStreamId)) return
      consumedStashRef.current = stashTarget.draftId
      setOpenComposer({ kind: "branch-reply", conversationId: parsed.conversationId, threadStreamId })
      return
    }
    if (graph.conversationIdByMemberMessageId.get(parsed.messageId) !== conversationId) return
    consumedStashRef.current = stashTarget.draftId
    setOpenComposer({ kind: "new-subtopic", streamId: parsed.streamId, messageId: parsed.messageId })
  }, [stashTarget, graph, branchStreamIds, conversationId])

  // A pending sub-topic is handed to the graph path only once BOTH its thread
  // stream exists (promotion) AND the child conversation is cached — dropping it
  // at thread creation alone would blank the message for the beat until the
  // `conversation:created` echo lands.
  const isGraphRendered = useCallback(
    (p: { messageId: string }) => {
      const threadId = index.threadsByParentMessageId.get(p.messageId)?.id
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
      const threadId = index.threadsByParentMessageId.get(p.messageId)?.id
      if (threadId) ids.add(threadId)
    }
    return [...ids]
  }, [openComposer, pendingSubtopics, index])

  const derivePendingBranches = useCallback(
    (messagesById: Map<string, RenderableMessage>): BranchConversationView[] => {
      const out: BranchConversationView[] = []
      for (const p of pendingSubtopics) {
        const draftPanelId = createDraftPanelId(p.streamId, p.messageId)
        const threadId = index.threadsByParentMessageId.get(p.messageId)?.id
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
        streamCreation: { type: StreamTypes.THREAD, parentStreamId: streamId, parentMessageId: messageId },
        draftId: draftPanelId,
        conversation: { intent: "newSubtopic" },
      })
    },
    [queueDraftMessage, workspaceId]
  )

  const submitNewSubtopic = useCallback(
    async (streamId: string, messageId: string, input: InlineComposerSubmit) => {
      await queueSubtopicSend(streamId, messageId, input)
      setPendingSubtopics((prev) => [...prev, { streamId, messageId }])
    },
    [queueSubtopicSend]
  )

  const pendingEntryFor = useCallback(
    (branch: BranchConversationView) =>
      branch.pending ? pendingSubtopics.find((p) => p.messageId === branch.forkMessageId) : undefined,
    [pendingSubtopics]
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
      await queueDraftMessage(input, {
        workspaceId,
        streamId: branch.threadStreamId,
        conversation: { intent: "existing", conversationId: branch.conversationId },
      })
    },
    [queueDraftMessage, workspaceId, pendingEntryFor, queueSubtopicSend]
  )

  const renderAfterMessage = useCallback(
    (messageId: string): ReactNode => {
      if (openComposer?.kind !== "new-subtopic" || openComposer.messageId !== messageId) return null
      const { streamId } = openComposer
      return (
        <InlineComposerForm
          workspaceId={workspaceId}
          streamId={streamId}
          memoAnchorStreamId={streamId}
          draftKey={boardSubtopicDraftKey(streamId, messageId)}
          placeholder="Start a sub-topic…"
          rejectE2e={E2E_SUBTOPIC_MESSAGE}
          onSubmit={(sendInput) => submitNewSubtopic(streamId, messageId, sendInput)}
          onClose={closeComposer}
        />
      )
    },
    [openComposer, workspaceId, submitNewSubtopic, closeComposer]
  )

  const renderBranchTail = useCallback(
    (branch: BranchConversationView): ReactNode => {
      if (openComposer?.kind === "branch-reply" && openComposer.conversationId === branch.conversationId) {
        // A pending branch's thread may not exist yet — host the composer on the
        // parent stream (mention context + E2E gate), like the opening gesture.
        const pendingEntry = pendingEntryFor(branch)
        const hostStreamId = pendingEntry?.streamId ?? branch.threadStreamId
        return (
          <InlineComposerForm
            workspaceId={workspaceId}
            streamId={hostStreamId}
            memoAnchorStreamId={hostStreamId}
            // A pending branch's conversation id is a synthetic draft-panel id
            // that dies when the echo lands — a draft keyed by it would orphan
            // at promotion. Key by the fork message (the sub-topic scope, the
            // one stable identity across the hand-off); the send routes through
            // the same converging sub-topic path either way.
            draftKey={
              pendingEntry
                ? boardSubtopicDraftKey(pendingEntry.streamId, pendingEntry.messageId)
                : boardBranchReplyDraftKey(branch.conversationId)
            }
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
            onSubmit={(sendInput) => submitBranchReply(branch, sendInput)}
            onClose={closeComposer}
          />
        )
      }
      return (
        <button
          type="button"
          onClick={() => openBranchReply(branch)}
          className="mt-3 flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <Reply className="h-3.5 w-3.5 shrink-0" />
          Reply
        </button>
      )
    },
    [openComposer, workspaceId, submitBranchReply, closeComposer, openBranchReply, pendingEntryFor]
  )

  return {
    branchStreamIds,
    extraDraftPanelIds,
    openComposer,
    openNewSubtopic,
    openBranchReply,
    renderAfterMessage,
    renderBranchTail,
    derivePendingBranches,
  }
}
