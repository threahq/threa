import { getE2eSessionState } from "@/stores/e2e-session-store"
import { resolveCurrentStreamKey } from "@/lib/crypto/stream-key-cache"
import { sealStreamMessage, type SealStreamMessageResult } from "@/lib/crypto/message-envelope"
import { getAttachmentRef, type AttachmentRef } from "@/lib/crypto/attachment-crypto"

export interface SealOutgoingMessageInput {
  workspaceId: string
  /** Author's workspace user id — bound into the AAD and used to resolve the session. */
  senderId: string
  /**
   * The E2E stream whose current SSK seals this message and whose id binds the
   * AAD. For a thread reply queued before the thread exists, pass the encrypted
   * *root*: the promoted thread inherits the same SSK + wraps, so it opens under
   * the thread id all the same (decryption resolves the key by the copied wraps,
   * not by re-deriving the AAD).
   */
  streamId: string
  /** The (client) message id — bound into the AAD. */
  messageId: string
  contentMarkdown: string
  attachmentIds?: string[]
}

export interface SealOutgoingMessageResult {
  e2eFields: SealStreamMessageResult
  /** Sealed attachment refs (key/iv/filename), if any — for the optimistic payload. */
  attachmentRefs?: AttachmentRef[]
  /** The unlocked owner identity used to seal — reuse it for heal-on-send. */
  owner: { keyId: string; privateKey: CryptoKey }
}

/**
 * Seal an outgoing message body (and its attachment refs) under a stream's SSK,
 * with the owner's UIK held in memory. Shared by the live send path
 * (`use-stream-or-draft`) and the draft-promotion path (`use-queue-draft-message`)
 * so the encrypt-before-enqueue rule lives on one path (INV-35). Throws loudly
 * (INV-11) when the session is locked, an attachment key was lost on reload, or
 * the caller isn't a recipient of the stream's current generation.
 */
export async function sealOutgoingMessage(input: SealOutgoingMessageInput): Promise<SealOutgoingMessageResult> {
  const session = getE2eSessionState(input.workspaceId, input.senderId)
  if (session.status !== "unlocked" || !session.privateKey || !session.keyId) {
    throw new Error("Unlock encrypted scratchpads before sending")
  }
  // Resolve each attachment's per-file key/iv (minted at upload) and seal them
  // into the payload. The key lives only in memory by design, so a reload
  // between upload and send drops it — fail loud rather than ship a row the
  // owner can never decrypt.
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
  // Seal under the stream's symmetric key (SSK, v2). The SSK is resolved from
  // the stream's wraps and unwrapped with the viewer's UIK — a viewer who isn't
  // a recipient of the current generation can't seal.
  const streamKey = await resolveCurrentStreamKey({
    workspaceId: input.workspaceId,
    streamId: input.streamId,
    recipientKeyId: session.keyId,
    privateKey: session.privateKey,
  })
  if (!streamKey) {
    throw new Error("You don't have access to this encrypted scratchpad's key")
  }
  const e2eFields = await sealStreamMessage({
    contentMarkdown: input.contentMarkdown,
    streamId: input.streamId,
    messageId: input.messageId,
    senderId: input.senderId,
    ssk: streamKey.key,
    keyGeneration: streamKey.keyGeneration,
    attachmentRefs,
  })
  return { e2eFields, attachmentRefs, owner: { keyId: session.keyId, privateKey: session.privateKey } }
}
