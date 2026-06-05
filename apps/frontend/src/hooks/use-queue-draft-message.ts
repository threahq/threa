import { useCallback } from "react"
import { usePendingMessages } from "@/contexts"
import { useUser } from "@/auth"
import { useWorkspaceUsers } from "@/stores/workspace-store"
import { db, sequenceToNum, type CachedStream, type PendingStreamCreation } from "@/db"
import { serializeToMarkdown } from "@threa/prosemirror"
import { StreamTypes, Visibilities, type JSONContent, type StreamEvent } from "@threa/types"
import { createDraftPanelId } from "@/contexts/panel-context"
import { optimisticReplyCountUpdate } from "@/sync/stream-sync"
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
  /** The draft/synthetic streamId used for the optimistic event */
  streamId: string
  /** Stream creation metadata for the background queue */
  streamCreation: PendingStreamCreation
  /** The draft ID to clean up after promotion (may differ from streamId for threads) */
  draftId: string
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
 * Hook that provides a function to queue a draft message for background
 * processing. Writes an optimistic event to IDB and enqueues the message
 * + stream creation for the background queue.
 *
 * This abstracts the IDB writes so components don't need to import @/db directly.
 */
export function useQueueDraftMessage(workspaceId: string) {
  const user = useUser()
  const idbUsers = useWorkspaceUsers(workspaceId)
  const currentUserId = idbUsers.find((u) => u.workosUserId === user?.id)?.id ?? null
  const { markPending, notifyQueue } = usePendingMessages()

  const queueDraftMessage = useCallback(
    async (input: QueueDraftMessageInput, params: QueueDraftMessageParams) => {
      if (!currentUserId) {
        throw new Error("Cannot send message: user identity not resolved yet")
      }

      const clientId = generateClientId()
      const now = new Date().toISOString()
      const contentMarkdown = serializeToMarkdown(input.contentJson)
      const optimisticSequence = Date.now().toString()

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
      if (params.streamCreation.type === StreamTypes.SCRATCHPAD) {
        const draftScratchpad = await db.draftScratchpads.get(params.draftId)
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
        params.streamCreation.type === StreamTypes.THREAD &&
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
    },
    [currentUserId, markPending, notifyQueue]
  )

  return { queueDraftMessage, currentUserId }
}
