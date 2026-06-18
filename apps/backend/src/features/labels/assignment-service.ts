import type { Pool, PoolClient } from "pg"
import {
  LabelableResourceTypes,
  LabelActorTypes,
  Visibilities,
  type LabelActor,
  type LabelAssignment,
  type LabelableResourceType,
} from "@threa/types"
import { withTransaction } from "../../db"
import { HttpError } from "../../lib/errors"
import { OutboxRepository } from "../../lib/outbox"
import { listAccessibleStreamIds } from "../streams"
import type { BotChannelService } from "../api-keys"
import { LabelRepository, LabelAssignmentRepository } from "./repository"

interface LabelAssignmentServiceDeps {
  pool: Pool
  botChannelService: BotChannelService
}

export interface AssignLabelParams {
  workspaceId: string
  actor: LabelActor
  labelId: string
  resourceType: LabelableResourceType
  resourceId: string
}

/**
 * Applies labels to arbitrary resources (streams today; messages/users/
 * attachments later). Assigning validates both the label and that the caller
 * can reach the target resource — a member only labels resources they can
 * access — so a new resource type must add its access rule (see
 * assertResourceAccess), which denies by default until it does.
 *
 * Assignment visibility tracks the label's: a private label is the creator's
 * own organizational layer, so its rows stay viewer-scoped (delivered to the
 * creator's user room). A public label is a *shared pool* — every member's
 * rows are visible to everyone who can reach the resource, so its assignment
 * events fan out to the resource's access scope (the stream room, reused from
 * stream notifications) and reads return the whole pool, access-filtered.
 */
export class LabelAssignmentService {
  private readonly pool: Pool
  private readonly botChannelService: BotChannelService

  constructor(deps: LabelAssignmentServiceDeps) {
    this.pool = deps.pool
    this.botChannelService = deps.botChannelService
  }

  /**
   * The viewer's full assignment set for bootstrap/list: the shared pool of
   * public-label assignments on resources they can access, plus their own
   * private-label rows. Stream rows are gated through the viewer's own access
   * model so a label on a channel they can no longer reach never resurfaces
   * (resource types without an access rule are dropped).
   *
   * A user's private rows are their own organizational layer and skip the gate
   * — a user always sees their own private labels regardless of current stream
   * access. A bot has no such standing layer: it reaches streams only through
   * channel grants, so its private rows are gated like its public ones, and a
   * revoked grant drops them too.
   */
  async listForViewer(workspaceId: string, actor: LabelActor): Promise<LabelAssignment[]> {
    const candidates = await LabelAssignmentRepository.listVisibleCandidates(this.pool, workspaceId, actor.id)

    const ungatedRows: LabelAssignment[] = []
    const gatedStreamRows: LabelAssignment[] = []
    for (const { labelVisibility, ...assignment } of candidates) {
      if (labelVisibility === Visibilities.PRIVATE && actor.type !== LabelActorTypes.BOT) {
        ungatedRows.push(assignment)
      } else if (assignment.resourceType === LabelableResourceTypes.STREAM) {
        gatedStreamRows.push(assignment)
      }
    }

    if (gatedStreamRows.length === 0) return ungatedRows

    const accessible = await this.accessibleStreamIds(
      workspaceId,
      actor,
      gatedStreamRows.map((a) => a.resourceId)
    )
    return [...ungatedRows, ...gatedStreamRows.filter((a) => accessible.has(a.resourceId))]
  }

  async assign(params: AssignLabelParams): Promise<LabelAssignment> {
    return withTransaction(this.pool, async (client) => {
      const label = await LabelRepository.findById(client, params.workspaceId, params.labelId)
      if (!label || label.archivedAt) {
        throw new HttpError("Label not found", { status: 404, code: "LABEL_NOT_FOUND" })
      }
      // You can apply any label you can see: your own private labels, or any
      // public label in the workspace. Someone else's private label is invisible
      // to you, so report not-found rather than leak its existence.
      if (label.visibility === Visibilities.PRIVATE && label.creatorUserId !== params.actor.id) {
        throw new HttpError("Label not found", { status: 404, code: "LABEL_NOT_FOUND" })
      }

      await this.assertResourceAccess(client, params)

      const assignment = await LabelAssignmentRepository.assign(client, {
        workspaceId: params.workspaceId,
        labelId: params.labelId,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        actorType: params.actor.type,
        userId: params.actor.id,
      })

      await OutboxRepository.insert(client, "label:assigned", {
        workspaceId: params.workspaceId,
        targetUserId: label.visibility === Visibilities.PUBLIC ? null : params.actor.id,
        assignment,
      })

      return assignment
    })
  }

  async unassign(params: AssignLabelParams): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const removed = await LabelAssignmentRepository.unassign(client, {
        workspaceId: params.workspaceId,
        labelId: params.labelId,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        userId: params.actor.id,
      })
      if (!removed) return

      // The label drives routing the same way it does on assign. A missing
      // label can't happen here — archive deletes its assignments in the same
      // transaction — but if it ever did, fall back to the user room.
      const label = await LabelRepository.findById(client, params.workspaceId, params.labelId)

      await OutboxRepository.insert(client, "label:unassigned", {
        workspaceId: params.workspaceId,
        targetUserId: label?.visibility === Visibilities.PUBLIC ? null : params.actor.id,
        labelId: params.labelId,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        userId: params.actor.id,
      })
    })
  }

  /**
   * A member may only label a resource they can reach. Mirrors listForViewer's
   * read-side access gate on the write path, so a member can't seed the shared
   * pool of a stream they can't access. Stream is the only labelable resource
   * type today; an unreachable stream — or any resource type without an access
   * rule yet — is reported as not-found rather than leaking whether it exists.
   * Unassign is intentionally not gated: it only removes the caller's own row.
   */
  private async assertResourceAccess(client: PoolClient, params: AssignLabelParams): Promise<void> {
    if (params.resourceType === LabelableResourceTypes.STREAM) {
      if (await this.canReachStream(client, params.actor, params.workspaceId, params.resourceId)) return
    }
    throw new HttpError("Resource not found", { status: 404, code: "RESOURCE_NOT_FOUND" })
  }

  /**
   * Single-resource reachability for the write gate — a point query per actor
   * model (a bot: one EXISTS on its grant; a user: membership/visibility). The
   * read gate uses the bulk {@link accessibleStreamIds} instead, since it filters
   * a whole candidate set at once.
   */
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

  /**
   * The subset of `candidateIds` the actor can reach, by the actor's own access
   * model: a user resolves through stream membership/visibility, a bot through
   * its channel grants. Backs the read gate (`listForViewer`), which filters a
   * whole candidate set; the write gate uses {@link canReachStream} for its
   * single-resource check.
   */
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
