import type { Pool } from "pg"
import { PlatformAdminAccessRepository } from "./repository"

export interface ApplyPlatformAdminSyncInput {
  workspaceId: string
  workosUserId: string
  /** Snapshot from the control plane — grants insert the mirror row, revokes delete it. */
  isPlatformAdmin: boolean
}

/**
 * Regional read/write surface for platform-admin access. The control plane
 * owns the data (`platform_roles`) and pushes per-workspace snapshots through
 * `applySync`; the bootstrap reads `hasAccess` so the frontend can gate links
 * into the backoffice. There is no live broadcast — grants are rare operator
 * actions, so the change takes effect on the viewer's next bootstrap.
 */
export class PlatformAdminService {
  constructor(private pool: Pool) {}

  async hasAccess(workspaceId: string, workosUserId: string): Promise<boolean> {
    // Single query, INV-30
    return PlatformAdminAccessRepository.hasAccess(this.pool, workspaceId, workosUserId)
  }

  async applySync(input: ApplyPlatformAdminSyncInput): Promise<void> {
    await PlatformAdminAccessRepository.setAccess(
      this.pool,
      input.workspaceId,
      input.workosUserId,
      input.isPlatformAdmin
    )
  }
}
