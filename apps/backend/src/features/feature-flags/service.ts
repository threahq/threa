import type { Pool } from "pg"
import {
  resolveFeatureFlags,
  type FeatureFlagKey,
  type FeatureFlagLayers,
  type FeatureFlagScope,
  type FeatureFlagValue,
  type FeatureFlags,
} from "@threahq/types"
import { withTransaction } from "../../db"
import { logger } from "../../lib/logger"
import { OutboxRepository } from "../../lib/outbox"
import { UserRepository } from "../workspaces"
import { FeatureFlagOverrideRepository } from "./repository"

export interface ApplyFeatureFlagSyncInput {
  workspaceId: string
  subjectType: FeatureFlagScope
  /** workos_user_id for user scope, workspace_id for workspace scope. */
  subjectId: string
  /** That subject's raw overrides from the control plane — replaces stored rows wholesale. */
  overrides: Record<string, string>
}

/**
 * Regional read/write surface for feature flags. The control plane owns the
 * data and pushes one subject's overrides through `applySync`; everything else
 * in the backend resolves flags via `getFlags`/`getFlag`, which mirror the
 * frontend's bootstrap-backed lookup so a flag means the same thing on both
 * sides of the stack. Reads key on `workos_user_id` — the same id storage keys
 * on — so no path joins to the regional user row (that lookup is only needed to
 * route the user-scoped broadcast).
 */
export class FeatureFlagService {
  constructor(private pool: Pool) {}

  /** Raw stored layers for one user in one workspace — the bootstrap wire shape. */
  async getFlagLayers(workspaceId: string, workosUserId: string): Promise<FeatureFlagLayers> {
    return FeatureFlagOverrideRepository.findLayers(this.pool, workspaceId, workosUserId)
  }

  /** The user's resolved flags: registry defaults + workspace layer + user layer. */
  async getFlags(workspaceId: string, workosUserId: string): Promise<FeatureFlags> {
    return resolveFeatureFlags(await this.getFlagLayers(workspaceId, workosUserId))
  }

  /** Backend-side flag lookup — the counterpart of the frontend's `useFeatureFlag`. */
  async getFlag<K extends FeatureFlagKey>(
    workspaceId: string,
    workosUserId: string,
    key: K
  ): Promise<FeatureFlagValue<K>> {
    const flags = await this.getFlags(workspaceId, workosUserId)
    return flags[key]
  }

  /**
   * A workspace-scoped flag resolved from the workspace layer + default only,
   * no user. For gates that have no user in scope (a workspace-only flag never
   * depends on one), so nothing has to fabricate or look one up.
   */
  async getWorkspaceFlag<K extends FeatureFlagKey>(workspaceId: string, key: K): Promise<FeatureFlagValue<K>> {
    const workspace = await FeatureFlagOverrideRepository.findWorkspaceOverrides(this.pool, workspaceId)
    return resolveFeatureFlags({ workspace, user: {} })[key]
  }

  /**
   * Apply a control-plane snapshot for one subject and broadcast the changed
   * layer to live sessions. The row replacement always lands — no regional-user
   * resolution gates the write, which is the decision-2 fix (an invited-but-
   * never-signed-in user's flags used to be dropped, not just their broadcast).
   *
   * The broadcast is best-effort and separate from the write: the outbox event
   * carries the raw layer that changed (a workspace layer cannot be resolved
   * server-side — each recipient has their own user layer). For user scope it is
   * routed to the regional user's room, so it needs the regional user id; if the
   * user has no regional row yet, the write still commits and only the broadcast
   * is skipped (nobody is connected to receive it). Write + outbox commit in one
   * transaction (INV-7).
   */
  async applySync(input: ApplyFeatureFlagSyncInput): Promise<void> {
    const { workspaceId, subjectType, subjectId, overrides } = input

    if (subjectType === "workspace") {
      await withTransaction(this.pool, async (client) => {
        await FeatureFlagOverrideRepository.replaceForSubject(client, workspaceId, "workspace", subjectId, overrides)
        await OutboxRepository.insert(client, "feature_flags:workspace_updated", { workspaceId, overrides })
      })
      return
    }

    const user = await UserRepository.findByWorkosUserIdInWorkspace(this.pool, workspaceId, subjectId)
    await withTransaction(this.pool, async (client) => {
      await FeatureFlagOverrideRepository.replaceForSubject(client, workspaceId, "user", subjectId, overrides)
      if (user) {
        await OutboxRepository.insert(client, "feature_flags:updated", {
          workspaceId,
          targetUserId: user.id,
          overrides,
        })
      } else {
        logger.info(
          { workspaceId, workosUserId: subjectId },
          "Feature flag sync stored without broadcast: no regional user for WorkOS id yet"
        )
      }
    })
  }
}
