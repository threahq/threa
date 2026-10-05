import type { Pool } from "pg"
import { logger, type WorkosOrgService } from "@threahq/backend-common"
import { WorkspaceRegistryRepository } from "./repository"

interface Dependencies {
  pool: Pool
  workosOrgService: WorkosOrgService
}

export class WorkosOrganizationProvisioner {
  private pool: Pool
  private workosOrgService: WorkosOrgService

  constructor({ pool, workosOrgService }: Dependencies) {
    this.pool = pool
    this.workosOrgService = workosOrgService
  }

  /**
   * Ensure a WorkOS organization exists for the workspace and return its id.
   * 3-tier lookup: local cache → WorkOS by external ID → create new. Null when
   * the workspace is not in the registry or creation failed. No DB connection
   * is held during WorkOS calls (INV-41).
   */
  async ensureWorkosOrganization(workspaceId: string): Promise<string | null> {
    const cachedOrgId = await WorkspaceRegistryRepository.getWorkosOrganizationId(this.pool, workspaceId)
    if (cachedOrgId) return cachedOrgId

    // Survives local DB wipes.
    const existingOrg = await this.workosOrgService.getOrganizationByExternalId(workspaceId)
    if (existingOrg) {
      await WorkspaceRegistryRepository.setWorkosOrganizationId(this.pool, workspaceId, existingOrg.id)
      return existingOrg.id
    }

    const workspace = await WorkspaceRegistryRepository.findById(this.pool, workspaceId)
    if (!workspace) return null

    try {
      const org = await this.workosOrgService.createOrganization({
        name: workspace.name,
        externalId: workspaceId,
      })
      // Writes only while unset, so a concurrent loser no-ops (INV-20).
      await WorkspaceRegistryRepository.setWorkosOrganizationId(this.pool, workspaceId, org.id)
    } catch (error) {
      logger.error({ err: error, workspaceId }, "Failed to create WorkOS organization")
    }

    // Re-read to get the winning org ID (handles concurrent creation race)
    return WorkspaceRegistryRepository.getWorkosOrganizationId(this.pool, workspaceId)
  }
}
