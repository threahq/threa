import { sql } from "../../db"
import { registerBackfill, type BackfillContext } from "../../lib/backfill"
import { WorkspaceIntegrationProviders, WorkspaceIntegrationStatuses } from "@threahq/types"
import type { WorkspaceIntegrationService } from "./service"

export const GITHUB_INSTALLATION_BACKFILL_NAME = "github-installation-routes"

// A workspace holds at most one GitHub integration row, so a run has either one
// unit of work or none. The empty descriptor keeps the chunk payload tiny — the
// workspace id travels on the backfill job envelope.
type GithubInstallationChunk = Record<string, never>

/**
 * Backfill existing GitHub integrations into the plaintext `installation_id`
 * reverse index and register their control-plane routes. Decrypts credentials
 * for pre-column rows, sets the column, and upserts the CP route — all through
 * `WorkspaceIntegrationService.backfillGithubRoute` so the crypto and routing
 * logic stays single-sourced (INV-35).
 */
export function registerGithubInstallationBackfill(deps: {
  workspaceIntegrationService: WorkspaceIntegrationService
}): void {
  const { workspaceIntegrationService } = deps

  async function plan(ctx: BackfillContext, workspaceId: string): Promise<GithubInstallationChunk[]> {
    const result = await ctx.pool.query<{ exists: boolean }>(
      sql`
        SELECT EXISTS (
          SELECT 1 FROM workspace_integrations
          WHERE workspace_id = ${workspaceId}
            AND provider = ${WorkspaceIntegrationProviders.GITHUB}
            AND status = ${WorkspaceIntegrationStatuses.ACTIVE}
        ) AS exists
      `
    )
    return result.rows[0]?.exists ? [{}] : []
  }

  async function processChunk(_ctx: BackfillContext, workspaceId: string): Promise<{ processed: number }> {
    return workspaceIntegrationService.backfillGithubRoute(workspaceId)
  }

  registerBackfill<GithubInstallationChunk>({
    name: GITHUB_INSTALLATION_BACKFILL_NAME,
    plan,
    processChunk,
  })
}
