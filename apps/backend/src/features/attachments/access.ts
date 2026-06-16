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
