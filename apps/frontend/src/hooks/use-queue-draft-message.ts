import { useCallback } from "react"
import { usePendingMessages } from "@/contexts"
import { useUser } from "@/auth"
import { useWorkspaceUsers } from "@/stores/workspace-store"
import { db, sequenceToNum, type CachedStream, type PendingStreamCreation } from "@/db"
import { serializeToMarkdown } from "@threa/prosemirror"
import { StreamTypes, Visibilities, type JSONContent, type StreamEvent } from "@threa/types"
import { createDraftPanelId } from "@/contexts/panel-context"
import { optimisticReplyCountUpdate } from "@/sync/stream-sync"
import { getE2eSessionState } from "@/stores/e2e-session-store"
import { sealStreamMessage } from "@/lib/crypto/message-envelope"
import { resolveCurrentStreamKey } from "@/lib/crypto/stream-key-cache"
import { getAttachmentRef, type AttachmentRef } from "@/lib/crypto/attachment-crypto"
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
   */
  e2e?: { rootStreamId: string }
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
      // draft into the (server-sealed) stream. Mirrors the encrypted send path
      // in `use-stream-or-draft`. Bind the AAD to the encrypted root: the
      // promoted thread shares the root's SSK + generation, so it opens under
      // the thread id all the same (decryption resolves the key by the copied
      // wraps, not by re-deriving the AAD).
      let e2eFields: Awaited<ReturnType<typeof sealStreamMessage>> | undefined
      if (params.e2e) {
        const session = getE2eSessionState(params.workspaceId, currentUserId)
        if (session.status !== "unlocked" || !session.privateKey || !session.keyId) {
          throw new Error("Unlock encrypted scratchpads before sending")
        }
        let attachmentRefs: AttachmentRef[] | undefined
        if (input.attachmentIds && input.attachmentIds.length > 0) {
          attachmentRefs = input.attachmentIds.map((id) => {
            const ref = getAttachmentRef(id)
            if (!ref) {
              throw new Error("Re-attach the file before sending — its encryption key was lost on reload")
            }
            return ref
          })
        }
        const streamKey = await resolveCurrentStreamKey({
          workspaceId: params.workspaceId,
          streamId: params.e2e.rootStreamId,
          recipientKeyId: session.keyId,
          privateKey: session.privateKey,
        })
        if (!streamKey) {
          throw new Error("You don't have access to this encrypted scratchpad's key")
        }
        e2eFields = await sealStreamMessage({
          contentMarkdown,
          streamId: params.e2e.rootStreamId,
          messageId: clientId,
          senderId: currentUserId,
          ssk: streamKey.key,
          keyGeneration: streamKey.keyGeneration,
          attachmentRefs,
        })
        // Carry the refs on the optimistic payload so the sender sees their own
        // attachments render immediately (mirrors the encrypted send path).
        if (attachmentRefs && attachmentRefs.length > 0) {
          ;(optimisticEvent.payload as Record<string, unknown>).attachmentRefs = attachmentRefs
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
