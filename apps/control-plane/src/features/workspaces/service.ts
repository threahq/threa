import type { Pool } from "pg"
import {
  HttpError,
  isUniqueViolation,
  workspaceId as generateWorkspaceId,
  generateUniqueSlug,
  withTransaction,
  logger,
  displayNameFromWorkos,
  OutboxRepository,
  type WorkosOrgService,
} from "@threa/backend-common"
import { WORKSPACE_ROLE_SLUGS } from "@threa/types"
import { WorkspaceRegistryRepository } from "./repository"
import type { RegionalClient } from "../../lib/regional-client"
import type { KvClient } from "../../lib/cloudflare-kv-client"
// Type-only: the platform-admin feature imports this feature's repository, so
// a value import here would create a runtime module cycle. The instance is
// injected by the composition root instead.
import type { PlatformAdminSyncService } from "../platform-admin"

export const OUTBOX_KV_SYNC = "kv_sync"
export const OUTBOX_REGIONAL_CREATE = "regional_create"

interface Dependencies {
  pool: Pool
  regionalClient: RegionalClient
  workosOrgService: WorkosOrgService
  kvClient: KvClient
  platformAdminSync: PlatformAdminSyncService
  availableRegions: string[]
  requireWorkspaceCreationInvite: boolean
}

export class ControlPlaneWorkspaceService {
  private pool: Pool
  private regionalClient: RegionalClient
  private workosOrgService: WorkosOrgService
  private kvClient: KvClient
  private platformAdminSync: PlatformAdminSyncService
  private availableRegions: Set<string>
  private requireInvite: boolean

  constructor(deps: Dependencies) {
    this.pool = deps.pool
    this.regionalClient = deps.regionalClient
    this.workosOrgService = deps.workosOrgService
    this.kvClient = deps.kvClient
    this.platformAdminSync = deps.platformAdminSync
    this.availableRegions = new Set(deps.availableRegions)
    this.requireInvite = deps.requireWorkspaceCreationInvite
  }

  private defaultRegion(): string {
    const first = this.availableRegions.values().next().value
    if (!first) {
      throw new HttpError("No regions available", { status: 500, code: "NO_REGIONS" })
    }
    return first
  }

  listRegions(): string[] {
    return [...this.availableRegions]
  }

  async getRegion(workspaceId: string): Promise<string | null> {
    return WorkspaceRegistryRepository.getRegion(this.pool, workspaceId)
  }

  /**
   * Confirm whether a WorkOS user holds a membership in this workspace. The
   * control plane is the source of truth for membership: the regional backend
   * calls this to self-heal a missing `users` row when its DB has drifted
   * behind the control plane (failed accept-sync, restored snapshot).
   */
  async isMember(workspaceId: string, workosUserId: string): Promise<boolean> {
    return WorkspaceRegistryRepository.isMember(this.pool, workspaceId, workosUserId)
  }

  async listForUser(workosUserId: string) {
    const rows = await WorkspaceRegistryRepository.listByUser(this.pool, workosUserId)
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      region: row.region,
      createdBy: row.created_by_workos_user_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  async create(params: {
    name: string
    region?: string
    workosUserId: string
    authUser: { email: string; firstName?: string | null; lastName?: string | null }
  }) {
    const { name, workosUserId, authUser } = params
    const email = authUser.email
    const displayName = displayNameFromWorkos(authUser)

    const region = params.region ?? this.defaultRegion()
    if (!this.availableRegions.has(region)) {
      throw new HttpError(`Invalid region: ${region}`, { status: 400, code: "INVALID_REGION" })
    }

    if (this.requireInvite) {
      const hasInvite = await this.workosOrgService.hasAcceptedWorkspaceCreationInvitation(email)
      if (!hasInvite) {
        throw new HttpError("Workspace creation requires an accepted invitation", {
          status: 403,
          code: "INVITATION_REQUIRED",
        })
      }
    }

    const id = generateWorkspaceId()

    // Insert into control-plane DB with slug collision retry (INV-20).
    // generateUniqueSlug checks availability inside the transaction, but a concurrent
    // transaction can claim the same slug before COMMIT. The UNIQUE constraint catches
    // this — retry with a fresh slug check so the next attempt sees the committed slug.
    const MAX_SLUG_ATTEMPTS = 3
    let workspace: Awaited<ReturnType<typeof WorkspaceRegistryRepository.insert>>
    for (let attempt = 1; ; attempt++) {
      try {
        workspace = await withTransaction(this.pool, async (client) => {
          const slug = await generateUniqueSlug(name, (s) => WorkspaceRegistryRepository.slugExists(client, s))
          const ws = await WorkspaceRegistryRepository.insert(client, {
            id,
            name,
            slug,
            region,
            createdByWorkosUserId: workosUserId,
          })
          await WorkspaceRegistryRepository.insertMembership(client, id, workosUserId)

          // Durable outbox events — regional creation + KV sync both committed atomically
          await OutboxRepository.insert(client, OUTBOX_REGIONAL_CREATE, {
            workspaceId: id,
            name,
            slug,
            region,
            ownerWorkosUserId: workosUserId,
            ownerEmail: email,
            ownerName: displayName,
          })
          await OutboxRepository.insert(client, OUTBOX_KV_SYNC, { workspaceId: id, region })

          // A platform admin's new workspace should show backoffice links
          // without waiting for the next control-plane restart to re-seed.
          await this.platformAdminSync.enqueueIfAdmin(client, workosUserId)

          return ws
        })
        break
      } catch (error) {
        if (attempt >= MAX_SLUG_ATTEMPTS || !isUniqueViolation(error, "workspace_registry_slug_key")) {
          throw error
        }
      }
    }

    const result = {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      region: workspace.region,
      createdBy: workspace.created_by_workos_user_id,
      createdAt: workspace.created_at,
      updatedAt: workspace.updated_at,
    }

    // Best-effort: create WorkOS org and owner membership eagerly (no DB connection held — INV-41)
    try {
      const orgId = await this.ensureWorkosOrganization(id, name)
      if (orgId) {
        await this.workosOrgService.ensureOrganizationMembership({
          organizationId: orgId,
          userId: workosUserId,
          roleSlug: WORKSPACE_ROLE_SLUGS.OWNER,
        })
      }
    } catch (error) {
      logger.warn({ err: error, workspaceId: id }, "Failed to sync WorkOS org membership on workspace creation")
    }

    return result
  }

  /**
   * Ensure a WorkOS organization exists for the given workspace.
   * 3-tier lookup: local cache → WorkOS by external ID → create new.
   */
  private async ensureWorkosOrganization(workspaceId: string, workspaceName: string): Promise<string | null> {
    // Tier 1: Check local DB cache
    const cachedOrgId = await WorkspaceRegistryRepository.getWorkosOrganizationId(this.pool, workspaceId)
    if (cachedOrgId) return cachedOrgId

    // Tier 2: Check WorkOS by external ID
    const existingOrg = await this.workosOrgService.getOrganizationByExternalId(workspaceId)
    if (existingOrg) {
      await WorkspaceRegistryRepository.setWorkosOrganizationId(this.pool, workspaceId, existingOrg.id)
      return existingOrg.id
    }

    // Tier 3: Create new org in WorkOS (with concurrent-creation race guard)
    try {
      const org = await this.workosOrgService.createOrganization({
        name: workspaceName,
        externalId: workspaceId,
      })
      await WorkspaceRegistryRepository.setWorkosOrganizationId(this.pool, workspaceId, org.id)
    } catch (error) {
      logger.error({ err: error, workspaceId }, "Failed to create WorkOS organization")
    }

    // Re-read to get the winning org ID (handles concurrent creation race)
    return WorkspaceRegistryRepository.getWorkosOrganizationId(this.pool, workspaceId)
  }

  /** Outbox handler: provision workspace in the regional backend */
  async provisionRegional(payload: RegionalCreatePayload): Promise<void> {
    await this.regionalClient.createWorkspace(payload.region, {
      id: payload.workspaceId,
      name: payload.name,
      slug: payload.slug,
      ownerWorkosUserId: payload.ownerWorkosUserId,
      ownerEmail: payload.ownerEmail,
      ownerName: payload.ownerName,
    })
    logger.info({ workspaceId: payload.workspaceId, region: payload.region }, "Workspace provisioned in region")
  }

  /** Outbox handler: sync workspace-to-region mapping to Cloudflare KV */
  async syncToKv(payload: KvSyncPayload): Promise<void> {
    await this.kvClient.putWorkspaceRegion(payload.workspaceId, payload.region)
  }
}

// Typed payload definitions for control-plane outbox events
export interface KvSyncPayload {
  workspaceId: string
  region: string
}

export interface RegionalCreatePayload {
  workspaceId: string
  name: string
  slug: string
  region: string
  ownerWorkosUserId: string
  ownerEmail: string
  ownerName: string
}
