import type { Pool } from "pg"
import { Visibilities, type LabelAssignment, type LabelableResourceType } from "@threa/types"
import { withTransaction } from "../../db"
import { HttpError } from "../../lib/errors"
import { OutboxRepository } from "../../lib/outbox"
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
 * attachments later). Resource-agnostic by design — it validates the label,
 * never the resource — so a new resource type needs no change here. Viewer-
 * scoped: assignments are private to the assigning user and fan out to their
 * user room via the outbox (INV-4).
 */
export class LabelAssignmentService {
  private readonly pool: Pool

  constructor(deps: LabelAssignmentServiceDeps) {
    this.pool = deps.pool
  }

  listForUser(workspaceId: string, userId: string): Promise<LabelAssignment[]> {
    return LabelAssignmentRepository.listForUser(this.pool, workspaceId, userId)
  }

  listForResource(
    workspaceId: string,
    userId: string,
    resourceType: LabelableResourceType,
    resourceId: string
  ): Promise<LabelAssignment[]> {
    return LabelAssignmentRepository.listForResource(this.pool, workspaceId, resourceType, resourceId, userId)
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

      const assignment = await LabelAssignmentRepository.assign(client, {
        workspaceId: params.workspaceId,
        labelId: params.labelId,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        userId: params.userId,
      })

      await OutboxRepository.insert(client, "label:assigned", {
        workspaceId: params.workspaceId,
        targetUserId: params.userId,
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

      await OutboxRepository.insert(client, "label:unassigned", {
        workspaceId: params.workspaceId,
        targetUserId: params.userId,
        labelId: params.labelId,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        userId: params.userId,
      })
    })
  }
}
