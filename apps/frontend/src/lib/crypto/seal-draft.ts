import { serializeToMarkdown } from "@threa/prosemirror"
import type { JSONContent } from "@threa/types"
import { sealOutgoingMessage } from "./seal-send"

/** The E2E triple persisted at rest in place of a draft's plaintext (E2EE-4),
 * plus the markdown that was sealed (so callers can seed the decrypt cache with
 * the just-authored plaintext without re-serializing). */
export interface SealedDraftFields {
  ciphertext: string
  envelope: unknown
  e2eVersion: number
  contentMarkdown: string
}

/**
 * Seal a draft body to the stream's SSK so an encrypted-stream draft roams
 * across the author's devices without plaintext ever touching disk or wire
 * (E2EE-4). Reuses the message seal path (INV-35): the draft id binds the AAD in
 * the `messageId` slot exactly as a message id would, so a sealed draft is
 * indistinguishable on the wire from a sealed message and opens the same way —
 * decrypt-on-read goes through the shared `decrypt-cache` (`tryDecryptMessagePayload`).
 *
 * v1 seals the body only — attachments / context refs / slash commands on E2E
 * drafts are not yet sealed (they stay session-local), so no `attachmentIds` are
 * passed and the payload is bare markdown.
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
  const contentMarkdown = serializeToMarkdown(input.contentJson)
  const { e2eFields } = await sealOutgoingMessage({
    workspaceId: input.workspaceId,
    senderId: input.senderId,
    streamId: input.streamId,
    messageId: input.draftId,
    contentMarkdown,
  })
  return {
    ciphertext: e2eFields.ciphertext,
    envelope: e2eFields.envelope,
    e2eVersion: e2eFields.e2eVersion,
    contentMarkdown,
  }
}
