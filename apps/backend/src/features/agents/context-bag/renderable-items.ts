import type { Querier } from "../../../db"
import { LinkPreviewStatuses, type AttachmentSummary } from "@threahq/types"
import { AttachmentRepository } from "../../attachments"
import { LinkPreviewRepository, renderLinkPreviewContext } from "../../link-previews"
import type { Message } from "../../messaging"
import { resolveActorNames } from "../actor-names"
import { fingerprintContent, fingerprintManifest as fingerprintInputs } from "./fingerprint"
import type { RenderableMessage, SummaryInput } from "./types"

export interface HydratedItems {
  items: RenderableMessage[]
  inputs: SummaryInput[]
  fingerprint: string
}

/**
 * Turn resolved source messages into the renderable items + inputs manifest
 * every resolver returns: author names, attachment metadata, completed link
 * previews, per-message fingerprints. Shared so the resolvers render
 * byte-identical message blocks (prompt-cache stability) from one code path.
 */
export async function hydrateRenderableItems(
  db: Querier,
  workspaceId: string,
  messages: Message[]
): Promise<HydratedItems> {
  const authorIds = new Set(messages.map((m) => m.authorId))
  const messageIds = messages.map((m) => m.id)
  const [authorNames, attachmentsByMessage, linkPreviewsByMessage] = await Promise.all([
    resolveActorNames(db, workspaceId, authorIds),
    // Without this the focal message loses its attachments — the trace shows
    // only the text and the model has no idea anything was attached. The
    // renderer formats the metadata inline; full extraction content stays
    // behind the existing attachment tools.
    AttachmentRepository.findByMessageIds(db, messageIds),
    LinkPreviewRepository.findByMessageIds(db, workspaceId, messageIds),
  ])

  const items: RenderableMessage[] = messages.map((m) => {
    const messageAttachments = attachmentsByMessage.get(m.id)
    // Sort by id (ULID, time-ordered) so the rendered attachments line is
    // byte-identical across resolves — `findByMessageIds` doesn't ORDER BY,
    // so PG row order would otherwise drift and break prompt-cache reuse.
    const attachments: AttachmentSummary[] | undefined =
      messageAttachments && messageAttachments.length > 0
        ? [...messageAttachments]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((a) => ({
              id: a.id,
              filename: a.filename,
              mimeType: a.mimeType,
              sizeBytes: a.sizeBytes,
            }))
        : undefined
    const linkPreviews = (linkPreviewsByMessage.get(m.id) ?? []).filter(
      (preview) => preview.status === LinkPreviewStatuses.COMPLETED
    )
    return {
      messageId: m.id,
      authorId: m.authorId,
      authorName: authorNames.get(m.authorId) ?? "Unknown",
      contentMarkdown: m.contentMarkdown,
      createdAt: m.createdAt.toISOString(),
      editedAt: m.editedAt?.toISOString() ?? null,
      sequence: m.sequence,
      ...(attachments && { attachments }),
      ...(linkPreviews.length > 0 && { linkPreviews }),
    }
  })

  // Attachments are intentionally NOT folded into the fingerprint: they're
  // immutable after message creation, so adding them would expand the manifest
  // without ever changing the value.
  const inputs: SummaryInput[] = items.map((item) => ({
    messageId: item.messageId,
    contentFingerprint: fingerprintContent(item.contentMarkdown + renderLinkPreviewContext(item.linkPreviews ?? [])),
    editedAt: item.editedAt,
    deleted: false,
  }))

  return { items, inputs, fingerprint: fingerprintInputs(inputs) }
}
