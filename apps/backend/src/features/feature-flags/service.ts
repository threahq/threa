import type { Pool } from "pg"
import { resolveFeatureFlags, type FeatureFlagKey, type FeatureFlags } from "@threa/types"
import { withTransaction } from "../../db"
import { logger } from "../../lib/logger"
import { OutboxRepository } from "../../lib/outbox"
import { UserRepository } from "../workspaces"
import { UserFeatureFlagRepository } from "./repository"

export interface ApplyFeatureFlagSyncInput {
  workspaceId: string
  workosUserId: string
  /** Full resolved snapshot from the control plane — replaces stored rows wholesale. */
  flags: Record<string, boolean>
}

/**
 * Regional read/write surface for per-user feature flags. The control plane
 * owns the data and pushes snapshots through `applySync`; everything else in
 * the backend resolves flags via `getFlags`/`isEnabled`, which mirror the
 * frontend's bootstrap-backed lookup so a flag means the same thing on both
 * sides of the stack.
 */
export class FeatureFlagService {
  constructor(private pool: Pool) {}

  /** The user's resolved flags: registry defaults (off) + stored snapshot. */
  async getFlags(workspaceId: string, userId: string): Promise<FeatureFlags> {
    // Single query, INV-30
    const rows = await UserFeatureFlagRepository.findForUser(this.pool, workspaceId, userId)
    return resolveFeatureFlags(rows)
  }

  /** Backend-side flag check — the counterpart of the frontend's `useFeatureFlag`. */
  async isEnabled(workspaceId: string, userId: string, key: FeatureFlagKey): Promise<boolean> {
    const flags = await this.getFlags(workspaceId, userId)
    return flags[key]
  }

  /**
   * Apply a control-plane snapshot and broadcast the user's new resolved
   * flags to their live sessions. Row replacement and the outbox event commit
   * together (INV-7), so a session can never observe the broadcast without
   * the rows that back it.
   *
   * Returns false when the WorkOS user has no regional user row yet (flag set
   * before first sign-in). Safe to drop: the regional state already equals the
   * default the snapshot would mostly encode, and the next backoffice toggle
   * re-syncs after the user exists.
   */
  async applySync(input: ApplyFeatureFlagSyncInput): Promise<boolean> {
    const user = await UserRepository.findByWorkosUserIdInWorkspace(this.pool, input.workspaceId, input.workosUserId)
    if (!user) {
      logger.warn(
        { workspaceId: input.workspaceId, workosUserId: input.workosUserId },
        "Feature flag sync skipped: no regional user for WorkOS id"
      )
      return false
    }

    await withTransaction(this.pool, async (client) => {
      await UserFeatureFlagRepository.replaceForUser(client, input.workspaceId, user.id, input.flags)
      const rows = await UserFeatureFlagRepository.findForUser(client, input.workspaceId, user.id)
      await OutboxRepository.insert(client, "feature_flags:updated", {
        workspaceId: input.workspaceId,
        targetUserId: user.id,
        featureFlags: resolveFeatureFlags(rows),
      })
    })
    return true
  }
}
