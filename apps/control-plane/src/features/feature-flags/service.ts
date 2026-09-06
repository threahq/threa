import type { Pool } from "pg"
import { HttpError, withTransaction, logger, OutboxRepository } from "@threahq/backend-common"
import {
  defaultFeatureFlagValue,
  flagAllowsScope,
  isFeatureFlagKey,
  isFeatureFlagValue,
  type FeatureFlagScope,
} from "@threahq/types"
import { FeatureFlagOverrideRepository, type FeatureFlagOverrideRecord } from "./repository"
import { WorkspaceRegistryRepository } from "../workspaces"
import type { RegionalClient } from "../../lib/regional-client"

export const OUTBOX_FEATURE_FLAGS_SYNC = "feature_flags_sync"

/**
 * Outbox payload for the regional fan-out. Carries only the subject identity —
 * the handler re-reads that subject's overrides at delivery time, so rapid
 * changes collapse to the latest state and replays are idempotent.
 */
export interface FeatureFlagsSyncPayload extends Record<string, unknown> {
  workspaceId: string
  subjectType: FeatureFlagScope
  subjectId: string
}

interface Dependencies {
  pool: Pool
  regionalClient: RegionalClient
}

/** A stored override still backed by the code registry — live key, declared value, and a scope the flag allows. */
function isLiveOverride(record: FeatureFlagOverrideRecord): boolean {
  return (
    isFeatureFlagKey(record.flagKey) &&
    isFeatureFlagValue(record.flagKey, record.value) &&
    flagAllowsScope(record.flagKey, record.subjectType)
  )
}

/**
 * Source of truth for feature flag overrides. Backoffice admins set values
 * here — at workspace or user scope; every write emits a durable outbox event
 * that pushes that subject's raw overrides to the workspace's regional backend,
 * which resolves them against the same registry and broadcasts to live sessions.
 */
export class ControlPlaneFeatureFlagService {
  private pool: Pool
  private regionalClient: RegionalClient

  constructor({ pool, regionalClient }: Dependencies) {
    this.pool = pool
    this.regionalClient = regionalClient
  }

  /**
   * All overrides stored for a workspace, filtered to keys/values/scopes still
   * in the code registry so the backoffice never renders retired flags.
   */
  async listWorkspaceOverrides(workspaceId: string): Promise<FeatureFlagOverrideRecord[]> {
    const rows = await FeatureFlagOverrideRepository.listByWorkspace(this.pool, workspaceId)
    return rows.filter(isLiveOverride)
  }

  /**
   * Set one subject's flag to a declared value. Choosing the flag's explicit
   * default clears the override — only deviations from default are stored,
   * mirroring workspace-settings. The override write and the fan-out outbox
   * event commit atomically (INV-7).
   */
  async setFlag(params: {
    workspaceId: string
    subjectType: FeatureFlagScope
    subjectId: string
    flagKey: string
    value: string
  }): Promise<void> {
    const { workspaceId, subjectType, subjectId, flagKey, value } = params
    if (!isFeatureFlagKey(flagKey)) {
      throw new HttpError("Unknown feature flag", { status: 400, code: "UNKNOWN_FLAG" })
    }
    if (!flagAllowsScope(flagKey, subjectType)) {
      throw new HttpError("Feature flag does not allow this scope", { status: 400, code: "FLAG_SCOPE_NOT_ALLOWED" })
    }
    // The workspace layer is a single row keyed by the workspace itself; a
    // subjectId other than the workspace id would orphan a second, unreadable
    // workspace override (the PK permits it). Reject rather than normalize (INV-11).
    if (subjectType === "workspace" && subjectId !== workspaceId) {
      throw new HttpError("Workspace-scope override must target the workspace itself", {
        status: 400,
        code: "INVALID_SUBJECT",
      })
    }
    if (!isFeatureFlagValue(flagKey, value)) {
      throw new HttpError("Value is not declared for this feature flag", { status: 400, code: "UNKNOWN_FLAG_VALUE" })
    }
    const workspace = await WorkspaceRegistryRepository.findById(this.pool, workspaceId)
    if (!workspace) {
      throw new HttpError("Workspace not found", { status: 404, code: "NOT_FOUND" })
    }

    await withTransaction(this.pool, async (client) => {
      if (value === defaultFeatureFlagValue(flagKey)) {
        await FeatureFlagOverrideRepository.deleteOverride(client, { workspaceId, subjectType, subjectId, flagKey })
      } else {
        await FeatureFlagOverrideRepository.setOverride(client, { workspaceId, subjectType, subjectId, flagKey, value })
      }
      await OutboxRepository.insert(client, OUTBOX_FEATURE_FLAGS_SYNC, {
        workspaceId,
        subjectType,
        subjectId,
      } satisfies FeatureFlagsSyncPayload)
    })
  }

  /**
   * Outbox handler: push one subject's raw overrides to the workspace's region.
   * Reads current state (not event-time state) and filters through the registry
   * so retired flags never reach the region; the region resolves the layers.
   */
  async syncToRegion(payload: FeatureFlagsSyncPayload): Promise<void> {
    const workspace = await WorkspaceRegistryRepository.findById(this.pool, payload.workspaceId)
    if (!workspace) {
      // Workspace deleted between write and drain — nothing to sync to.
      logger.warn({ workspaceId: payload.workspaceId }, "Feature flag sync skipped: workspace not in registry")
      return
    }
    const rows = await FeatureFlagOverrideRepository.listForSubject(
      this.pool,
      payload.workspaceId,
      payload.subjectType,
      payload.subjectId
    )
    const overrides = Object.fromEntries(rows.filter(isLiveOverride).map((row) => [row.flagKey, row.value]))
    await this.regionalClient.syncFeatureFlags(workspace.region, {
      workspaceId: payload.workspaceId,
      subjectType: payload.subjectType,
      subjectId: payload.subjectId,
      overrides,
    })
  }
}
