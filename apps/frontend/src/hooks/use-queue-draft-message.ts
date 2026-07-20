import { useCallback } from "react"
import { usePendingMessages } from "@/contexts"
import { useUser } from "@/auth"
import { useWorkspaceUsers } from "@/stores/workspace-store"
import { db, sequenceToNum, type CachedStream, type PendingStreamCreation } from "@/db"
import { serializeToMarkdown } from "@threa/prosemirror"
import { StreamTypes, Visibilities, type ConversationDirective, type JSONContent, type StreamEvent } from "@threa/types"
import { createDraftPanelId } from "@/contexts/panel-context"
import { optimisticReplyCountUpdate } from "@/sync/stream-sync"
import { nextOptimisticSequence } from "@/lib/optimistic-sequence"
import { sealOutgoingMessage, type SealOutgoingMessageResult } from "@/lib/crypto/seal-send"
import { reviveStaleActorWraps } from "@/lib/crypto/stream-key-cache"
import { generateClientId } from "./use-stream-or-draft"
import type { AttachmentSummary } from "./create-optimistic-bootstrap"

export interface QueueDraftMessageInput {
  contentJson: JSONContent
  attachmentIds?: string[]
  attachments?: AttachmentSummary[]
}

export interface QueueDraftMessageParams {
  workspaceId: string
  /** The streamId the optimistic event is written under — a draft/synthetic id
   *  when `streamCreation` is set, or a real stream id for a send into one that
   *  already exists (a board reply attaching to an existing conversation). */
  streamId: string
  /** Stream creation metadata for the background queue. Omit to send into the
   *  existing `streamId` (no promotion). */
  streamCreation?: PendingStreamCreation
  /**
   * Conversation directive forwarded on send (see {@link ConversationDirective}).
   * `existing` also tags the optimistic event's payload with `conversationId` so
   * a board card can surface the pending reply under the right conversation
   * before the server echo lands. Omit to let the async extractor infer.
   */
  conversation?: ConversationDirective
  /** The draft ID to clean up after promotion (may differ from streamId for
   *  threads). Omit when there is no draft to clean up (an existing-stream send). */
  draftId?: string
  /**
   * Set when this draft lives under an end-to-end-encrypted root (a thread reply
   * in an encrypted scratchpad). The promoted stream inherits the root's SSK
   * server-side (INV-E1), so the body must be sealed here — a plaintext send to
   * the sealed stream is rejected by the backend's E2E gate. `rootStreamId` is
   * the encrypted root whose current SSK seals this message; the promoted thread
   * carries a copy of the same key + wraps, so it opens under the thread id too.
   * `hasActors` is true when the root has invited actors (the enclave / bots),
   * gating the best-effort heal-on-send.
   */
  e2e?: { rootStreamId: string; hasActors: boolean }
}

/**
 * Writes an optimistic event to IDB and enqueues the message for the background
 * queue, so components don't import @/db directly. Handles both the
 * stream-creation path (a scratchpad/thread draft promoted on first send) and a
 * plain send into an existing stream (a board reply, via the `conversation`
 * directive) — the queue drain forwards whichever fields are set. Returns the
 * generated `clientId` so the caller can correlate the optimistic event.
 */
export function useQueueDraftMessage(workspaceId: string) {
  const user = useUser()
  const idbUsers = useWorkspaceUsers(workspaceId)
  const currentUserId = idbUsers.find((u) => u.workosUserId === user?.id)?.id ?? null
  const { markPending, notifyQueue } = usePendingMessages()

  const queueDraftMessage = useCallback(
    async (input: QueueDraftMessageInput, params: QueueDraftMessageParams): Promise<{ clientId: string }> => {
      if (!currentUserId) {
        throw new Error("Cannot send message: user identity not resolved yet")
      }

      const clientId = generateClientId()
      const now = new Date().toISOString()
      const contentMarkdown = serializeToMarkdown(input.contentJson)
      const optimisticSequence = nextOptimisticSequence()

      const optimisticEvent: StreamEvent = {
        id: clientId,
        streamId: params.streamId,
        sequence: optimisticSequence,
        eventType: "message_created",
        payload: {
          messageId: clientId,
          contentMarkdown,
          // Carry the JSON content so the post-promotion server echo can seed the
          // decrypt cache from this optimistic row (stream-sync needs both
          // contentMarkdown + contentJson) — without it an encrypted thread reply
          // would flash the opaque placeholder for its own author.
          contentJson: input.contentJson,
          // Tag the optimistic reply with its target conversation so a board card
          // surfaces it under the right card before the server echo lands, and so
          // the sender's own flat-timeline provenance chip is stable across the
          // swap (see conversationTag — `existing` also carries the chip key the
          // server puts on the real payload). The row is swapped for the real event
          // on echo. `existing` names the conversation directly; `threadFromMessage`
          // (a lone post converting to a thread) joins its source conversation, so
          // the reply renders in place under the same card — no card swap
          // (board-view-design.md "Convert-to-thread, corrected").
          ...conversationTag(params.conversation),
          ...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {}),
        },
        actorId: currentUserId,
        actorType: "user",
        createdAt: now,
      }

      // When the draft lives under an E2E root, seal the body here (with the
      // owner's UIK held in memory) so the drain loop stays identity-agnostic —
      // it just forwards the precomputed ciphertext once it has promoted the
      // draft into the (server-sealed) stream. Shares `sealOutgoingMessage` with
      // the live send path (INV-35). Bind the AAD to the encrypted root: the
      // promoted thread shares the root's SSK + generation, so it opens under
      // the thread id all the same (decryption resolves the key by the copied
      // wraps, not by re-deriving the AAD).
      let e2eFields: SealOutgoingMessageResult["e2eFields"] | undefined
      if (params.e2e) {
        const sealed = await sealOutgoingMessage({
          workspaceId: params.workspaceId,
          senderId: currentUserId,
          streamId: params.e2e.rootStreamId,
          messageId: clientId,
          contentMarkdown,
          attachmentIds: input.attachmentIds,
        })
        e2eFields = sealed.e2eFields
        // Heal-on-send, best-effort: keep the root's actor wraps fresh so the
        // thread copies live wraps when the server seals it. Without this, an
        // enclave whose EIK rotated would have the first thread turn park
        // server-side; it self-heals on the next reply (the live send path
        // revives on the thread itself), so fire-and-forget is enough here.
        if (params.e2e.hasActors) {
          void reviveStaleActorWraps({
            workspaceId: params.workspaceId,
            streamId: params.e2e.rootStreamId,
            userId: currentUserId,
            ownerKeyId: sealed.owner.keyId,
            ownerPrivateKey: sealed.owner.privateKey,
          }).catch((err) => console.error("Failed to revive stale actor key wraps on encrypted thread send", err))
        }
        // Carry the refs on the optimistic payload so the sender sees their own
        // attachments render immediately (mirrors the encrypted send path).
        if (sealed.attachmentRefs && sealed.attachmentRefs.length > 0) {
          ;(optimisticEvent.payload as Record<string, unknown>).attachmentRefs = sealed.attachmentRefs
        }
      }

      markPending(clientId)

      await db.pendingMessages.add({
        clientId,
        workspaceId: params.workspaceId,
        streamId: params.streamId,
        content: contentMarkdown,
        contentFormat: "markdown",
        contentJson: input.contentJson,
        attachmentIds: input.attachmentIds,
        createdAt: Date.now(),
        retryCount: 0,
        streamCreation: params.streamCreation,
        conversation: params.conversation,
        draftId: params.draftId,
        ...(e2eFields
          ? { ciphertext: e2eFields.ciphertext, envelope: e2eFields.envelope, e2eVersion: e2eFields.e2eVersion }
          : {}),
      })

      await db.events.add({
        ...optimisticEvent,
        workspaceId: params.workspaceId,
        _sequenceNum: sequenceToNum(optimisticEvent.sequence),
        _clientId: clientId,
        _status: "pending",
        _cachedAt: Date.now(),
      })

      // Surface the committed draft in the sidebar and quick switcher so the
      // user can navigate back to it even before the real stream exists. The
      // promotion step will replace this entry with the server-assigned one.
      if (params.streamCreation?.type === StreamTypes.SCRATCHPAD) {
        const draftScratchpad = params.draftId ? await db.draftScratchpads.get(params.draftId) : undefined
        const optimisticStream: CachedStream = {
          id: params.streamId,
          workspaceId: params.workspaceId,
          type: StreamTypes.SCRATCHPAD,
          displayName: draftScratchpad?.displayName ?? params.streamCreation.displayName ?? null,
          slug: null,
          description: null,
          visibility: Visibilities.PRIVATE,
          parentStreamId: null,
          parentMessageId: null,
          rootStreamId: null,
          companionMode: params.streamCreation.companionMode ?? "on",
          companionPersonaId: null,
          createdBy: currentUserId,
          createdAt: draftScratchpad ? new Date(draftScratchpad.createdAt).toISOString() : now,
          updatedAt: now,
          archivedAt: null,
          lastMessagePreview: {
            authorId: currentUserId,
            authorType: "user",
            content: contentMarkdown,
            createdAt: now,
          },
          _cachedAt: Date.now(),
        }
        await db.streams.put(optimisticStream)
      }

      // For thread drafts, show a pending reply indicator on the parent message
      // by temporarily setting the parent's threadId to the draft panel ID and
      // bumping its replyCount. The promotion step swaps the threadId to the
      // real thread stream without re-incrementing.
      if (
        params.streamCreation?.type === StreamTypes.THREAD &&
        params.streamCreation.parentStreamId &&
        params.streamCreation.parentMessageId
      ) {
        const draftPanelId = createDraftPanelId(
          params.streamCreation.parentStreamId,
          params.streamCreation.parentMessageId
        )
        await optimisticReplyCountUpdate(
          params.streamCreation.parentStreamId,
          params.streamCreation.parentMessageId,
          draftPanelId
        ).catch(() => {})
      }

      notifyQueue()

      return { clientId }
    },
    [currentUserId, markPending, notifyQueue]
  )

  return { queueDraftMessage, currentUserId }
}

/** The conversation a board reply's optimistic event is tagged with, so the card
 *  surfaces it in place before the server echo. `existing` carries the id; a
 *  `threadFromMessage` convert joins its source conversation.
 *
 *  `existing` also stamps `declaredConversationId` — the same key the server puts
 *  on the real `message_created` payload — so the sender's own flat-timeline
 *  provenance chip (Mechanism C) renders on the optimistic row and stays put when
 *  the echo swaps in. A `threadFromMessage` reply is an opener the timeline chip
 *  ignores, so it tags the board card (`conversationId`) only. `newSubtopic` mints
 *  its child conversation server-side, so the id is unknown here — the optimistic
 *  reply renders in the new thread rail by `streamId` and the parent-card stub
 *  lands once the `conversation:created` echo caches the child (untagged, default). */
export function conversationTag(directive: ConversationDirective | undefined): {
  conversationId?: string
  declaredConversationId?: string
} {
  if (directive?.intent === "existing")
    return { conversationId: directive.conversationId, declaredConversationId: directive.conversationId }
  if (directive?.intent === "threadFromMessage") return { conversationId: directive.sourceConversationId }
  return {}
}
