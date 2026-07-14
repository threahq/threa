import type { Querier } from "../../db"
import { SharedMessageRepository } from "../messaging"
import { AttachmentReferenceRepository } from "./reference-repository"
import type { Attachment } from "./repository"

/**
 * Fallback "can this viewer read this attachment?" chain — share grants
 * and inline references — used after a direct stream-access check has
 * failed. Shared by the download-URL handler and the create-message
 * validator after their respective stream-access fast paths.
 *
 * Order (cheapest first):
 *   1. The owning message has been shared into a stream the viewer can read.
 *   2. The attachment is referenced inline from a message in a stream the
 *      viewer can read — the `attachment_references` projection that
 *      makes copy-paste resends and Ariadne re-surfacings work.
 *
 * `db` accepts both `Pool` and `PoolClient` so callers can route the
 * check inside an existing transaction or against the pool directly.
 */
export async function isAttachmentReadableViaShareOrReference(
  db: Querier,
  attachment: Pick<Attachment, "id" | "messageId">,
  workspaceId: string,
  userId: string
): Promise<boolean> {
  if (attachment.messageId) {
    const granted = await SharedMessageRepository.listSourcesGrantedToViewer(db, workspaceId, userId, [
      attachment.messageId,
    ])
    if (granted.has(attachment.messageId)) return true
  }
  return AttachmentReferenceRepository.hasViewerAccessByReference(db, workspaceId, userId, attachment.id)
}

/**
 * An UNBOUND attachment (no `stream_id`) is private to its uploader: no stream
 * gates it, so only the uploader may read it. Returns `true` when the caller
 * must be BLOCKED — a foreign user reading someone else's pending/persona-owned
 * upload. A legacy row with no `uploaded_by` (predates the column) has no owner
 * to match, so it is blocked for everyone rather than readable by anyone —
 * fail-closed. Bound attachments (stream set) are gated by stream access
 * upstream and never reach this check. Shared by the download/content handlers
 * and the persona copy-on-attach readability gate (one definition, INV-35).
 */
export function unboundAttachmentBlockedForCaller(
  attachment: Pick<Attachment, "streamId" | "uploadedBy">,
  userId: string
): boolean {
  return !attachment.streamId && attachment.uploadedBy !== userId
}
