import type { Pool, PoolClient } from "pg"
import {
  LabelableResourceTypes,
  LabelActorTypes,
  type Label,
  type LabelActor,
  type LabelAssignment,
  type LabelableResourceType,
} from "@threa/types"
import { generateSlug } from "@threa/backend-common"
import { withTransaction } from "../../db"
import { HttpError } from "../../lib/errors"
import { OutboxRepository } from "../../lib/outbox"
import { listAccessibleStreamIds } from "../streams"
import { MessageRepository } from "../messaging"
import type { BotChannelService } from "../api-keys"
import { LabelRepository, LabelAssignmentRepository } from "./repository"
import type { LabelService, UpsertLabelByNameParams } from "./service"

interface LabelAssignmentServiceDeps {
  pool: Pool
  labelService: LabelService
  botChannelService: BotChannelService
}

export interface AssignLabelParams {
  workspaceId: string
  actor: LabelActor
  labelId: string
  resourceType: LabelableResourceType
  resourceId: string
}

export interface AssignLabelByNameParams extends UpsertLabelByNameParams {
  resourceType: LabelableResourceType
  resourceId: string
}

/**
 * Applies labels to arbitrary resources (streams today; messages/users/
 * attachments later). Labels are private to their actor, so assignments are
 * owner-scoped: a row is the actor's own and reaches only their user room.
 * Assigning still validates that the actor can reach the target resource — a
 * member only labels resources they can access — so a new resource type must
 * add its access rule (see assertResourceAccess), which denies by default until
 * it does.
 */
export class LabelAssignmentService {
  private readonly pool: Pool
  private readonly labelService: LabelService
  private readonly botChannelService: BotChannelService

  constructor(deps: LabelAssignmentServiceDeps) {
    this.pool = deps.pool
    this.labelService = deps.labelService
    this.botChannelService = deps.botChannelService
  }

  /**
   * The actor's assignment set for bootstrap/list — their own rows, since labels
   * are owner-scoped. A user's rows are their own organizational layer and skip
   * the resource gate (a user always sees their own labels regardless of current
   * stream access). A bot has no such standing layer: it reaches streams only
   * through channel grants, so its rows are gated and a revoked grant drops them.
   */
  async listForViewer(workspaceId: string, actor: LabelActor): Promise<LabelAssignment[]> {
    const rows = await LabelAssignmentRepository.listForActor(this.pool, workspaceId, actor.id)
    if (actor.type !== LabelActorTypes.BOT) return rows

    const streamRows = rows.filter((a) => a.resourceType === LabelableResourceTypes.STREAM)
    if (streamRows.length === 0) return []
    const accessible = await this.accessibleStreamIds(
      workspaceId,
      actor,
      streamRows.map((a) => a.resourceId)
    )
    return streamRows.filter((a) => accessible.has(a.resourceId))
  }

  async assign(params: AssignLabelParams): Promise<LabelAssignment> {
    return withTransaction(this.pool, async (client) => {
      const label = await LabelRepository.findById(client, params.workspaceId, params.labelId)
      if (!label || label.archivedAt || label.creatorUserId !== params.actor.id) {
        // Someone else's label is invisible to you; report not-found rather than
        // leak its existence.
        throw new HttpError("Label not found", { status: 404, code: "LABEL_NOT_FOUND" })
      }

      await this.assertResourceAccess(client, params.actor, params.workspaceId, params.resourceType, params.resourceId)

      return this.assignWithin(client, label, params)
    })
  }

  /**
   * Apply a label identified by its text: find-or-create the actor's label for
   * `name`, then assign it — both in one transaction so the label and its chip
   * commit together. Returns the resolved label alongside the assignment.
   */
  async assignByName(params: AssignLabelByNameParams): Promise<{ label: Label; assignment: LabelAssignment }> {
    return withTransaction(this.pool, (client) => this.assignByNameInTransaction(client, params))
  }

  async assignByNameInTransaction(
    client: PoolClient,
    params: AssignLabelByNameParams
  ): Promise<{ label: Label; assignment: LabelAssignment }> {
    await this.assertResourceAccess(client, params.actor, params.workspaceId, params.resourceType, params.resourceId)

    const { label } = await this.labelService.upsertByNameWithin(client, params)
    const assignment = await this.assignWithin(client, label, {
      workspaceId: params.workspaceId,
      actor: params.actor,
      labelId: label.id,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
    })
    return { label, assignment }
  }

  private async assignWithin(client: PoolClient, label: Label, params: AssignLabelParams): Promise<LabelAssignment> {
    const assignment = await LabelAssignmentRepository.assign(client, {
      workspaceId: params.workspaceId,
      labelId: label.id,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      actorType: params.actor.type,
      userId: params.actor.id,
    })

    await OutboxRepository.insert(client, "label:assigned", {
      workspaceId: params.workspaceId,
      targetUserId: params.actor.id,
      assignment,
    })

    return assignment
  }

  async unassign(params: AssignLabelParams): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await this.unassignWithin(client, params)
    })
  }

  /** Remove a label by its text — resolves the actor's label for `name` first. */
  async unassignByName(params: {
    workspaceId: string
    actor: LabelActor
    name: string
    resourceType: LabelableResourceType
    resourceId: string
  }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const trimmedName = params.name.trim()
      if (trimmedName.length === 0) {
        throw new HttpError("Label name is required", { status: 400, code: "VALIDATION_ERROR" })
      }
      const slug = generateSlug(trimmedName) || "label"
      const label = await LabelRepository.findByOwnerSlug(client, params.workspaceId, params.actor.id, slug)
      if (!label) {
        throw new HttpError("Label not found", { status: 404, code: "LABEL_NOT_FOUND" })
      }
      await this.unassignWithin(client, {
        workspaceId: params.workspaceId,
        actor: params.actor,
        labelId: label.id,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
      })
    })
  }

  private async unassignWithin(client: PoolClient, params: AssignLabelParams): Promise<void> {
    const removed = await LabelAssignmentRepository.unassign(client, {
      workspaceId: params.workspaceId,
      labelId: params.labelId,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      userId: params.actor.id,
    })
    if (!removed) return

    await OutboxRepository.insert(client, "label:unassigned", {
      workspaceId: params.workspaceId,
      targetUserId: params.actor.id,
      labelId: params.labelId,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      userId: params.actor.id,
    })
  }

  /**
   * A member may only label a resource they can reach. Mirrors listForViewer's
   * access model on the write path. Each labelable resource type resolves to a
   * stream and gates on the actor's reachability of it (a message inherits its
   * stream's access, threads inherit their root — INV-62); a resource type
   * without an access rule yet, or an unreachable one, is reported as not-found
   * rather than leaking whether it exists. Unassign is intentionally not gated:
   * it only removes the caller's own row.
   */
  private async assertResourceAccess(
    client: PoolClient,
    actor: LabelActor,
    workspaceId: string,
    resourceType: LabelableResourceType,
    resourceId: string
  ): Promise<void> {
    if (resourceType === LabelableResourceTypes.STREAM) {
      if (await this.canReachStream(client, actor, workspaceId, resourceId)) return
    } else if (resourceType === LabelableResourceTypes.MESSAGE) {
      if (await this.canReachMessage(client, actor, workspaceId, resourceId)) return
    }
    throw new HttpError("Resource not found", { status: 404, code: "RESOURCE_NOT_FOUND" })
  }

  /**
   * A message is reachable when its owning stream is — labeling a message is
   * gated by stream access (thread→root inheritance and public-channel reads
   * resolve inside {@link canReachStream}).
   */
  private async canReachMessage(
    client: PoolClient,
    actor: LabelActor,
    workspaceId: string,
    messageId: string
  ): Promise<boolean> {
    const streamId = (await MessageRepository.findStreamIdsByIds(client, [messageId])).get(messageId)
    if (!streamId) return false
    return this.canReachStream(client, actor, workspaceId, streamId)
  }

  private async canReachStream(
    client: PoolClient,
    actor: LabelActor,
    workspaceId: string,
    streamId: string
  ): Promise<boolean> {
    if (actor.type === LabelActorTypes.BOT) {
      return this.botChannelService.isStreamAccessibleForBot(workspaceId, actor.id, streamId)
    }
    const accessible = await listAccessibleStreamIds(client, workspaceId, actor.id, [streamId])
    return accessible.has(streamId)
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
