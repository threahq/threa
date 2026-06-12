import type { Pool } from "pg"
import { HttpError, withTransaction, logger, OutboxRepository } from "@threa/backend-common"
import {
  defaultFeatureFlagValue,
  isFeatureFlagKey,
  isFeatureFlagValue,
  resolveFeatureFlags,
  type FeatureFlags,
} from "@threa/types"
import { FeatureFlagOverrideRepository, type FeatureFlagOverrideRecord } from "./repository"
import { WorkspaceRegistryRepository } from "../workspaces"
import type { RegionalClient } from "../../lib/regional-client"

export const OUTBOX_FEATURE_FLAGS_SYNC = "feature_flags_sync"

/**
 * Outbox payload for the regional fan-out. Carries only identity — the
 * handler re-reads the overrides at delivery time and pushes a full snapshot,
 * so rapid changes collapse to the latest state and replays are idempotent.
 */
export interface FeatureFlagsSyncPayload extends Record<string, unknown> {
  workspaceId: string
  workosUserId: string
}

interface Dependencies {
  pool: Pool
  regionalClient: RegionalClient
}

/**
 * Source of truth for per-user feature flags. Backoffice admins set values
 * here; every write emits a durable outbox event that pushes the user's
 * resolved flag snapshot to the workspace's regional backend, which in turn
 * broadcasts it to the user's live sessions.
 */
export class ControlPlaneFeatureFlagService {
  private pool: Pool
  private regionalClient: RegionalClient

  constructor({ pool, regionalClient }: Dependencies) {
    this.pool = pool
    this.regionalClient = regionalClient
  }

  /**
   * All overrides stored for a workspace, filtered to keys/values still in
   * the code registry so the backoffice never renders retired flags.
   */
  async listWorkspaceOverrides(workspaceId: string): Promise<FeatureFlagOverrideRecord[]> {
    const rows = await FeatureFlagOverrideRepository.listByWorkspace(this.pool, workspaceId)
    return rows.filter((row) => isFeatureFlagKey(row.flagKey) && isFeatureFlagValue(row.flagKey, row.value))
  }

  /**
   * Set one user's flag to a declared value. Choosing the default (first
   * declared) value clears the override — only deviations from default are
   * stored, mirroring workspace-settings. The override write and the fan-out
   * outbox event commit atomically (INV-7).
   */
  async setFlag(params: { workspaceId: string; workosUserId: string; flagKey: string; value: string }): Promise<void> {
    const { flagKey, value } = params
    if (!isFeatureFlagKey(flagKey)) {
      throw new HttpError("Unknown feature flag", { status: 400, code: "UNKNOWN_FLAG" })
    }
    if (!isFeatureFlagValue(flagKey, value)) {
      throw new HttpError("Value is not declared for this feature flag", { status: 400, code: "UNKNOWN_FLAG_VALUE" })
    }
    const workspace = await WorkspaceRegistryRepository.findById(this.pool, params.workspaceId)
    if (!workspace) {
      throw new HttpError("Workspace not found", { status: 404, code: "NOT_FOUND" })
    }

    await withTransaction(this.pool, async (client) => {
      if (value === defaultFeatureFlagValue(flagKey)) {
        await FeatureFlagOverrideRepository.deleteOverride(client, {
          workspaceId: params.workspaceId,
          workosUserId: params.workosUserId,
          flagKey,
        })
      } else {
        await FeatureFlagOverrideRepository.setOverride(client, {
          workspaceId: params.workspaceId,
          workosUserId: params.workosUserId,
          flagKey,
          value,
        })
      }
      await OutboxRepository.insert(client, OUTBOX_FEATURE_FLAGS_SYNC, {
        workspaceId: params.workspaceId,
        workosUserId: params.workosUserId,
      } satisfies FeatureFlagsSyncPayload)
    })
  }

  /**
   * Outbox handler: push one user's resolved flag snapshot to the workspace's
   * region. Reads current state (not event-time state) so the last event to
   * drain always leaves the region consistent with the control plane.
   */
  async syncToRegion(payload: FeatureFlagsSyncPayload): Promise<void> {
    const workspace = await WorkspaceRegistryRepository.findById(this.pool, payload.workspaceId)
    if (!workspace) {
      // Workspace deleted between write and drain — nothing to sync to.
      logger.warn({ workspaceId: payload.workspaceId }, "Feature flag sync skipped: workspace not in registry")
      return
    }
    const flags = await this.resolveForUser(payload.workspaceId, payload.workosUserId)
    await this.regionalClient.syncUserFeatureFlags(workspace.region, {
      workspaceId: payload.workspaceId,
      workosUserId: payload.workosUserId,
      flags,
    })
  }

  private async resolveForUser(workspaceId: string, workosUserId: string): Promise<FeatureFlags> {
    const overrides = await FeatureFlagOverrideRepository.listForUser(this.pool, workspaceId, workosUserId)
    return resolveFeatureFlags(overrides)
  }
}
