import type { Pool } from "pg"
import { HttpError, logger } from "@threahq/backend-common"
import type { AISpendingOverview, AISpendingPolicyUpdate, AISpendingPolicyWire } from "@threahq/types"
import { WorkspaceRegistryRepository } from "../workspaces"
import { RegionalResponseError, type RegionalClient } from "../../lib/regional-client"

interface Dependencies {
  pool: Pool
  regionalClient: RegionalClient
}

/** Regional rejections an operator can act on; anything else means the region could not answer. */
const FORWARDED_REGIONAL_STATUSES = new Set([400, 404, 409])

/**
 * Operator access to a workspace's AI spending policy. The owning region's
 * ledger is the only authority: the control plane stores nothing, looks the
 * region up, forwards the versioned command with the authenticated operator,
 * and reports only what the region acknowledged.
 */
export class ControlPlaneAISpendingService {
  private readonly pool: Pool
  private readonly regionalClient: RegionalClient

  constructor({ pool, regionalClient }: Dependencies) {
    this.pool = pool
    this.regionalClient = regionalClient
  }

  async getWorkspaceSpending(workspaceId: string): Promise<AISpendingOverview> {
    const region = await this.regionFor(workspaceId)
    return this.forward(workspaceId, region, async () => {
      const overview = await this.regionalClient.getAISpending(region, workspaceId)
      const workspaceIds = [overview.workspaceId, overview.policy?.workspaceId, overview.currentPeriod?.workspaceId]
      if (workspaceIds.some((id) => id !== undefined && id !== workspaceId)) {
        throw new Error("Regional AI spending overview is for a different workspace")
      }
      return overview
    })
  }

  /**
   * `expectedVersion` makes the command at-most-once: if an acknowledgement is
   * lost, a retry of the same version is rejected as stale, and the caller
   * re-reads the authoritative state instead of assuming success.
   */
  async setWorkspacePolicy(params: {
    workspaceId: string
    operatorWorkosUserId: string
    update: AISpendingPolicyUpdate
  }): Promise<AISpendingPolicyWire> {
    const { workspaceId, operatorWorkosUserId, update } = params
    const region = await this.regionFor(workspaceId)
    return this.forward(workspaceId, region, async () => {
      const { policy } = await this.regionalClient.setAISpendingPolicy(region, workspaceId, {
        ...update,
        operatorWorkosUserId,
      })
      // Every saved edit bumps the version by exactly one and records its operator,
      // so anything else is not an acknowledgement of this command.
      const acknowledgesCommand =
        policy.workspaceId === workspaceId &&
        policy.version === update.expectedVersion + 1 &&
        policy.status === update.status &&
        policy.updatedBy === operatorWorkosUserId
      if (!acknowledgesCommand) throw new Error("Regional AI spending update acknowledged a different command")
      return policy
    })
  }

  private async regionFor(workspaceId: string): Promise<string> {
    const workspace = await WorkspaceRegistryRepository.findById(this.pool, workspaceId)
    if (!workspace) throw new HttpError("Workspace not found", { status: 404, code: "NOT_FOUND" })
    return workspace.region
  }

  private async forward<T>(workspaceId: string, region: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (err) {
      if (err instanceof RegionalResponseError && err.code && FORWARDED_REGIONAL_STATUSES.has(err.status)) {
        throw new HttpError(err.upstreamMessage ?? err.message, { status: err.status, code: err.code })
      }
      logger.error({ err, workspaceId, region }, "Regional AI spending request failed")
      throw new HttpError("Regional backend unavailable", { status: 502, code: "REGION_UNAVAILABLE" })
    }
  }
}
