import { serializeToMarkdown } from "@threa/prosemirror"
import type { JSONContent } from "@threa/types"
import type { AttachmentRef } from "@threa/crypto"
import { sealOutgoingMessage } from "./seal-send"

/** The E2E triple persisted at rest in place of a draft's plaintext (E2EE-4),
 * plus the markdown + attachment refs that were sealed (so callers can seed the
 * decrypt cache with the just-authored plaintext without re-decrypting). */
export interface SealedDraftFields {
  ciphertext: string
  envelope: unknown
  e2eVersion: number
  contentMarkdown: string
  /** Per-attachment key/iv/filename sealed into the body (Stage 4d). Empty when
   * the draft has no attachments. Plaintext only — never persisted at rest. */
  attachmentRefs: AttachmentRef[]
}

/**
 * Seal a draft body (and its attachments) to the stream's SSK so an
 * encrypted-stream draft roams across the author's devices without plaintext
 * ever touching disk or wire (E2EE-4). Reuses the message seal path (INV-35):
 * the draft id binds the AAD in the `messageId` slot exactly as a message id
 * would, so a sealed draft is indistinguishable on the wire from a sealed
 * message and opens the same way — decrypt-on-read goes through the shared
 * `decrypt-cache` (`tryDecryptMessagePayload`).
 *
 * Stage 4d seals attachments alongside the body: their per-file key/iv/filename
 * ride inside the SSK ciphertext (as `attachmentRefs`) exactly as a message's
 * do, so a roamed draft's attachments decrypt + send on the receiving device.
 * The plaintext attachment linkage never lands on disk or the wire — only the
 * opaque ciphertext does. (Context refs / slash commands remain session-local —
 * their own design, deferred.)
 *
 * Throws (locked session, missing SSK, an attachment key lost on reload) the
 * same way `sealOutgoingMessage` does; the caller treats a throw as "can't
 * persist right now" and keeps the content in the composer for the session —
 * drafts never surface a save error.
 */
export async function sealDraftContent(input: {
  workspaceId: string
  senderId: string
  /** The E2E stream whose current SSK seals the draft — the root for a thread. */
  streamId: string
  draftId: string
  contentJson: JSONContent
  /** Server ids of the draft's E2E attachments — sealed into the body (Stage 4d). */
  attachmentIds?: string[]
}): Promise<SealedDraftFields> {
  const contentMarkdown = serializeToMarkdown(input.contentJson)
  const { e2eFields, attachmentRefs } = await sealOutgoingMessage({
    workspaceId: input.workspaceId,
    senderId: input.senderId,
    streamId: input.streamId,
    messageId: input.draftId,
    contentMarkdown,
    attachmentIds: input.attachmentIds,
  })
  return {
    ciphertext: e2eFields.ciphertext,
    envelope: e2eFields.envelope,
    e2eVersion: e2eFields.e2eVersion,
    contentMarkdown,
    attachmentRefs: attachmentRefs ?? [],
  }
}
