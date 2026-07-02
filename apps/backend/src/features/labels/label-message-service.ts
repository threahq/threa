import type { Pool } from "pg"
import {
  LabelActorTypes,
  LabelableResourceTypes,
  type AttachmentSummary,
  type LabelActor,
  type LabeledMessage,
  type LinkPreviewSummary,
} from "@threa/types"
import { MessageRepository, type Message } from "../messaging"
import { AttachmentRepository, toAttachmentSummary } from "../attachments"
import { LinkPreviewRepository, toLinkPreviewSummary } from "../link-previews"
import { listAccessibleStreamIds } from "../streams"
import type { BotChannelService } from "../api-keys"
import { LabelAssignmentRepository } from "./repository"

interface LabelMessageServiceDeps {
  pool: Pool
  botChannelService: BotChannelService
}

/**
 * Reads the messages an actor has filed under a label, hydrated for the label
 * landing page's Messages section. Labeled messages span streams, so each row
 * carries its own `streamId` (to render context + open in place). The read is
 * re-gated on stream access: a message the actor can no longer reach is dropped,
 * even though their owner-scoped assignment row still exists.
 */
export class LabelMessageService {
  private readonly pool: Pool
  private readonly botChannelService: BotChannelService

  constructor(deps: LabelMessageServiceDeps) {
    this.pool = deps.pool
    this.botChannelService = deps.botChannelService
  }

  async listLabeledMessages(workspaceId: string, actor: LabelActor, labelId: string): Promise<LabeledMessage[]> {
    const assignments = await LabelAssignmentRepository.listForLabelAndResourceType(this.pool, {
      workspaceId,
      actorId: actor.id,
      labelId,
      resourceType: LabelableResourceTypes.MESSAGE,
    })
    const messageIds = assignments.map((a) => a.resourceId)
    if (messageIds.length === 0) return []

    const byId = await MessageRepository.findByIds(this.pool, messageIds)
    // Preserve the newest-stowed-first order of the assignments; drop ids that
    // resolved to nothing and messages deleted after they were labeled.
    const ordered = messageIds.map((id) => byId.get(id)).filter((m): m is Message => Boolean(m) && !m!.deletedAt)
    if (ordered.length === 0) return []

    // Re-check reachability: access can change after labeling, and a message
    // inherits its stream's access (thread→root resolves in the shared helper).
    const streamIds = [...new Set(ordered.map((m) => m.streamId))]
    const accessible = await this.accessibleStreamIds(workspaceId, actor, streamIds)
    const visible = ordered.filter((m) => accessible.has(m.streamId))
    if (visible.length === 0) return []

    const ids = visible.map((m) => m.id)
    const [attachmentsByMessage, linkPreviewsByMessage] = await Promise.all([
      AttachmentRepository.findByMessageIds(this.pool, ids),
      LinkPreviewRepository.findByMessageIds(this.pool, workspaceId, ids),
    ])

    return visible.map((message) => {
      const attachments = (attachmentsByMessage.get(message.id) ?? []).map(toAttachmentSummary)
      const linkPreviews = (linkPreviewsByMessage.get(message.id) ?? [])
        .filter((p) => p.status === "completed")
        .map((p, i) => toLinkPreviewSummary(p, i))
      return toLabeledMessage(message, attachments, linkPreviews)
    })
  }

  private async accessibleStreamIds(
    workspaceId: string,
    actor: LabelActor,
    candidateIds: string[]
  ): Promise<Set<string>> {
    if (actor.type === LabelActorTypes.BOT) {
      const granted = new Set(await this.botChannelService.getAccessibleStreamIdsForBot(workspaceId, actor.id))
      return new Set(candidateIds.filter((id) => granted.has(id)))
    }
    return listAccessibleStreamIds(this.pool, workspaceId, actor.id, candidateIds)
  }
}

/** Project a hydrated message down to the label-view rendering shape. */
function toLabeledMessage(
  message: Message,
  attachments: AttachmentSummary[],
  linkPreviews: LinkPreviewSummary[]
): LabeledMessage {
  return {
    id: message.id,
    streamId: message.streamId,
    authorId: message.authorId,
    authorType: message.authorType,
    contentMarkdown: message.contentMarkdown,
    reactions: message.reactions,
    attachments,
    linkPreviews,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
  }
}
