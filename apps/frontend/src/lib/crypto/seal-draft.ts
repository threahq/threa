import { serializeToMarkdown } from "@threa/prosemirror"
import type { JSONContent } from "@threa/types"
import { sealOutgoingMessage } from "./seal-send"
import { tryDecryptMessagePayload } from "./message-envelope"

/** The E2E triple persisted at rest in place of a draft's plaintext (E2EE-4). */
export interface SealedDraftFields {
  ciphertext: string
  envelope: unknown
  e2eVersion: number
}

/**
 * Seal a draft body to the stream's SSK so an encrypted-stream draft roams
 * across the author's devices without plaintext ever touching disk or wire
 * (E2EE-4). Reuses the message seal path (INV-35): the draft id binds the AAD in
 * the `messageId` slot exactly as a message id would, so a sealed draft is
 * indistinguishable on the wire from a sealed message and opens the same way.
 *
 * v1 seals the body only — attachments / context refs / slash commands on E2E
 * drafts are not yet sealed (they stay session-local, as they were before this
 * stage), so no `attachmentIds` are passed and the payload is bare markdown.
 *
 * Throws (locked session, missing SSK) the same way `sealOutgoingMessage` does;
 * the caller treats a throw as "can't persist right now" and keeps the content
 * in the composer for the session — drafts never surface a save error.
 */
export async function sealDraftContent(input: {
  workspaceId: string
  senderId: string
  /** The E2E stream whose current SSK seals the draft — the root for a thread. */
  streamId: string
  draftId: string
  contentJson: JSONContent
}): Promise<SealedDraftFields> {
  const { e2eFields } = await sealOutgoingMessage({
    workspaceId: input.workspaceId,
    senderId: input.senderId,
    streamId: input.streamId,
    messageId: input.draftId,
    contentMarkdown: serializeToMarkdown(input.contentJson),
  })
  return { ciphertext: e2eFields.ciphertext, envelope: e2eFields.envelope, e2eVersion: e2eFields.e2eVersion }
}

/**
 * Open a sealed draft body back into ProseMirror content for the composer.
 * Mirrors the inbound message decrypt: the AAD travels in the envelope, so no
 * draft id is needed here. Returns null when the session is locked, the viewer
 * isn't a recipient of the stream key, or the payload is malformed — the caller
 * then renders an empty composer until the session unlocks.
 */
export async function decryptDraftContent(input: {
  ciphertext: string
  envelope: unknown
  e2eVersion: number | null | undefined
  workspaceId: string
  /** The E2E stream whose SSK wraps open the draft — the root for a thread. */
  streamId: string
  privateKey: CryptoKey
  recipientKeyId: string
}): Promise<JSONContent | null> {
  const result = await tryDecryptMessagePayload(
    {
      contentMarkdown: "",
      ciphertext: input.ciphertext,
      envelope: input.envelope,
      e2eVersion: input.e2eVersion ?? undefined,
    },
    {
      privateKey: input.privateKey,
      recipientKeyId: input.recipientKeyId,
      workspaceId: input.workspaceId,
      streamId: input.streamId,
      rootStreamId: input.streamId,
    }
  )
  return result?.contentJson ?? null
}
