import type { Pool, PoolClient } from "pg"
import { LabelableResourceTypes, Visibilities, type LabelAssignment, type LabelableResourceType } from "@threa/types"
import { withTransaction } from "../../db"
import { HttpError } from "../../lib/errors"
import { OutboxRepository } from "../../lib/outbox"
import { listAccessibleStreamIds } from "../streams"
import { LabelRepository, LabelAssignmentRepository } from "./repository"

interface LabelAssignmentServiceDeps {
  pool: Pool
}

export interface AssignLabelParams {
  workspaceId: string
  userId: string
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

  constructor(deps: LabelAssignmentServiceDeps) {
    this.pool = deps.pool
  }

  /**
   * The viewer's full assignment set for bootstrap/list: the shared pool of
   * public-label assignments on resources they can access, plus their own
   * private-label rows. Every public stream row — including ones the viewer
   * applied themselves — is gated through the canonical stream-access helper,
   * so a public label on a channel the viewer can no longer reach never
   * resurfaces (resource types without an access rule are dropped). Private
   * rows are the viewer's own organizational layer and skip the resource gate.
   */
  async listForViewer(workspaceId: string, userId: string): Promise<LabelAssignment[]> {
    const candidates = await LabelAssignmentRepository.listVisibleCandidates(this.pool, workspaceId, userId)

    const ownPrivateRows: LabelAssignment[] = []
    const publicStreamRows: LabelAssignment[] = []
    for (const { labelVisibility, ...assignment } of candidates) {
      if (labelVisibility === Visibilities.PRIVATE) ownPrivateRows.push(assignment)
      else if (assignment.resourceType === LabelableResourceTypes.STREAM) publicStreamRows.push(assignment)
    }

    if (publicStreamRows.length === 0) return ownPrivateRows

    const accessible = await listAccessibleStreamIds(
      this.pool,
      workspaceId,
      userId,
      publicStreamRows.map((a) => a.resourceId)
    )
    return [...ownPrivateRows, ...publicStreamRows.filter((a) => accessible.has(a.resourceId))]
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
      if (label.visibility === Visibilities.PRIVATE && label.creatorUserId !== params.userId) {
        throw new HttpError("Label not found", { status: 404, code: "LABEL_NOT_FOUND" })
      }

      await this.assertResourceAccess(client, params)

      const assignment = await LabelAssignmentRepository.assign(client, {
        workspaceId: params.workspaceId,
        labelId: params.labelId,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        userId: params.userId,
      })

      await OutboxRepository.insert(client, "label:assigned", {
        workspaceId: params.workspaceId,
        targetUserId: label.visibility === Visibilities.PUBLIC ? null : params.userId,
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
        userId: params.userId,
      })
      if (!removed) return

      // The label drives routing the same way it does on assign. A missing
      // label can't happen here — archive deletes its assignments in the same
      // transaction — but if it ever did, fall back to the user room.
      const label = await LabelRepository.findById(client, params.workspaceId, params.labelId)

      await OutboxRepository.insert(client, "label:unassigned", {
        workspaceId: params.workspaceId,
        targetUserId: label?.visibility === Visibilities.PUBLIC ? null : params.userId,
        labelId: params.labelId,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        userId: params.userId,
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
      const accessible = await listAccessibleStreamIds(client, params.workspaceId, params.userId, [params.resourceId])
      if (accessible.has(params.resourceId)) return
    }
    throw new HttpError("Resource not found", { status: 404, code: "RESOURCE_NOT_FOUND" })
  }
}
