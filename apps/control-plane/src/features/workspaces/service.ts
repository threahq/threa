import type { Pool, PoolClient } from "pg"
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
} from "@threahq/backend-common"
import {
  WORKSPACE_ROLE_SLUGS,
  WORKSPACE_TIERS,
  orgWorkspaceEnsureSchema,
  type OrgWorkspaceClaimRequest,
  type OrgWorkspaceEnsureRequest,
  type OrgWorkspacePerson,
  type WorkspaceTier,
} from "@threahq/types"
import { z } from "zod"
import { WorkspaceRegistryRepository } from "./repository"
import { parseRequest } from "../../lib/validation"
import type { WorkosOrganizationProvisioner } from "./workos-organization"
import type { RegionalClient } from "../../lib/regional-client"
import type { KvClient } from "../../lib/cloudflare-kv-client"
// Type-only: the platform-admin feature imports this feature's repository, so
// a value import here would create a runtime module cycle. The instance is
// injected by the composition root instead.
import type { PlatformAdminSyncService } from "../platform-admin"

export const OUTBOX_KV_SYNC = "kv_sync"
export const OUTBOX_REGIONAL_CREATE = "regional_create"
export const OUTBOX_WORKSPACE_TIER_SYNC = "workspace_tier_sync"
export const OUTBOX_ORG_WORKSPACE_ENSURE = "org_workspace_ensure"
export const OUTBOX_ORG_WORKSPACE_CLAIM = "org_workspace_claim"

const orgWorkspaceInputSchema = orgWorkspaceEnsureSchema.pick({ name: true, people: true })

/**
 * Names a counterpart org: one workspace exists per key, so two orgs must never serialize alike.
 * Domains compare case-insensitively; external ids do not. A provider holds no `:`, which keeps
 * the serialized form unambiguous.
 */
const orgKeySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("email_domain"), domain: z.string().trim().toLowerCase().min(1) }),
  z.object({
    kind: z.literal("external_team"),
    provider: z.string().regex(/^[^:]+$/),
    externalTeamId: z.string().min(1),
  }),
])
export type OrgKey = z.input<typeof orgKeySchema>

/** The `workspace_registry.org_key` value. */
function serializeOrgKey(key: z.output<typeof orgKeySchema>): string {
  switch (key.kind) {
    case "email_domain":
      return `email_domain:${key.domain}`
    case "external_team":
      return `external_team:${key.provider}:${key.externalTeamId}`
  }
}

interface Dependencies {
  pool: Pool
  regionalClient: RegionalClient
  workosOrgService: WorkosOrgService
  workosOrganizationProvisioner: WorkosOrganizationProvisioner
  kvClient: KvClient
  platformAdminSync: PlatformAdminSyncService
  availableRegions: string[]
  requireWorkspaceCreationInvite: boolean
}

export class ControlPlaneWorkspaceService {
  private pool: Pool
  private regionalClient: RegionalClient
  private workosOrgService: WorkosOrgService
  private workosOrganizationProvisioner: WorkosOrganizationProvisioner
  private kvClient: KvClient
  private platformAdminSync: PlatformAdminSyncService
  private availableRegions: Set<string>
  private requireInvite: boolean

  constructor(deps: Dependencies) {
    this.pool = deps.pool
    this.regionalClient = deps.regionalClient
    this.workosOrgService = deps.workosOrgService
    this.workosOrganizationProvisioner = deps.workosOrganizationProvisioner
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

  private assertRegion(region: string): void {
    if (!this.availableRegions.has(region)) {
      throw new HttpError(`Invalid region: ${region}`, { status: 400, code: "INVALID_REGION" })
    }
  }

  /**
   * Run `work` in a transaction with a slug for `name` that is free when the transaction starts.
   * A concurrent transaction can claim the same slug before COMMIT; the UNIQUE constraint catches
   * that, and the retry sees the committed slug (INV-20).
   */
  private async withFreshSlug<T>(name: string, work: (client: PoolClient, slug: string) => Promise<T>): Promise<T> {
    const MAX_SLUG_ATTEMPTS = 3
    for (let attempt = 1; ; attempt++) {
      try {
        return await withTransaction(this.pool, async (client) => {
          const slug = await generateUniqueSlug(name, (s) => WorkspaceRegistryRepository.slugExists(client, s))
          return work(client, slug)
        })
      } catch (error) {
        if (attempt >= MAX_SLUG_ATTEMPTS || !isUniqueViolation(error, "workspace_registry_slug_key")) {
          throw error
        }
      }
    }
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
      tier: row.tier,
      createdBy: row.created_by_workos_user_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  async create(params: {
    name: string
    region?: string
    /** The creator's IANA zone; the region seeds the workspace's billing timezone from it. */
    timezone?: string
    workosUserId: string
    authUser: { email: string; firstName?: string | null; lastName?: string | null }
  }) {
    const { name, workosUserId, authUser } = params
    const email = authUser.email
    const displayName = displayNameFromWorkos(authUser)

    const region = params.region ?? this.defaultRegion()
    this.assertRegion(region)

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

    const workspace = await this.withFreshSlug(name, async (client, slug) => {
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
        timezone: params.timezone,
      })
      await OutboxRepository.insert(client, OUTBOX_KV_SYNC, { workspaceId: id, region })

      // A platform admin's new workspace should show backoffice links
      // without waiting for the next control-plane restart to re-seed.
      await this.platformAdminSync.enqueueIfAdmin(client, workosUserId)

      return ws
    })

    const result = {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      region: workspace.region,
      tier: workspace.tier,
      createdBy: workspace.created_by_workos_user_id,
      createdAt: workspace.created_at,
      updatedAt: workspace.updated_at,
    }

    // Best-effort: create WorkOS org and owner membership eagerly (no DB connection held — INV-41)
    try {
      const orgId = await this.workosOrganizationProvisioner.ensureWorkosOrganization(id)
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
   * The workspace for a counterpart org, created unclaimed on first call and reused after, so
   * racing callers for one org get one workspace. Every call sends its people to the region, which
   * adds the ones it does not hold yet. No WorkOS objects until someone claims it.
   */
  async ensureOrgWorkspace(params: {
    orgKey: OrgKey
    name: string
    region: string
    people: OrgWorkspacePerson[]
  }): Promise<{ workspaceId: string; created: boolean }> {
    // A payload the region rejects would retry in the outbox forever, so reject it here.
    const { name, people } = parseRequest(orgWorkspaceInputSchema, { name: params.name, people: params.people })
    this.assertRegion(params.region)
    const orgKey = serializeOrgKey(parseRequest(orgKeySchema, params.orgKey))
    const id = generateWorkspaceId()

    return this.withFreshSlug(name, async (client, slug) => {
      const created = await WorkspaceRegistryRepository.insertForOrgIfAbsent(client, {
        id,
        name,
        slug,
        region: params.region,
        tier: WORKSPACE_TIERS.CONNECT,
        orgKey,
      })
      const workspace = await WorkspaceRegistryRepository.findByOrgKey(client, orgKey)
      if (!workspace) throw new Error(`Org workspace row missing after insert for ${orgKey}`)

      await OutboxRepository.insert(client, OUTBOX_ORG_WORKSPACE_ENSURE, {
        workspaceId: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        tier: workspace.tier,
        region: workspace.region,
        people,
      } satisfies OrgWorkspaceEnsurePayload)
      if (created) {
        await OutboxRepository.insert(client, OUTBOX_KV_SYNC, {
          workspaceId: workspace.id,
          region: workspace.region,
        } satisfies KvSyncPayload)
      }

      return { workspaceId: workspace.id, created }
    })
  }

  /**
   * Join the org workspace for a verified email's domain, if one exists. The first claimer becomes
   * its owner and creates its WorkOS org; later claimers are members. The membership insert is the
   * idempotency key: a repeat sign-in emits no regional event but re-runs the idempotent WorkOS sync,
   * so a sync that failed after an earlier claim is repaired on a later sign-in.
   */
  async claimOrgWorkspaces(params: {
    workosUserId: string
    email: string
    emailVerified: boolean
    name: string
  }): Promise<void> {
    const { workosUserId, email, emailVerified, name } = params
    const domain = email
      .slice(email.lastIndexOf("@") + 1)
      .trim()
      .toLowerCase()
    if (!emailVerified || !email.includes("@") || !domain) return
    const orgKey = serializeOrgKey({ kind: "email_domain", domain })

    const claim = await withTransaction(this.pool, async (client) => {
      const workspace = await WorkspaceRegistryRepository.findByOrgKey(client, orgKey)
      if (!workspace) return null
      if (!(await WorkspaceRegistryRepository.insertMembership(client, workspace.id, workosUserId))) {
        const role =
          workspace.created_by_workos_user_id === workosUserId
            ? WORKSPACE_ROLE_SLUGS.OWNER
            : WORKSPACE_ROLE_SLUGS.MEMBER
        return { workspaceId: workspace.id, role }
      }

      const role = (await WorkspaceRegistryRepository.claimCreatorIfUnset(client, workspace.id, workosUserId))
        ? WORKSPACE_ROLE_SLUGS.OWNER
        : WORKSPACE_ROLE_SLUGS.MEMBER
      await OutboxRepository.insert(client, OUTBOX_ORG_WORKSPACE_CLAIM, {
        workspaceId: workspace.id,
        region: workspace.region,
        workosUserId,
        email: email.toLowerCase(),
        name,
        role,
      } satisfies OrgWorkspaceClaimPayload)
      return { workspaceId: workspace.id, role }
    })
    if (!claim) return

    // Best-effort, as in `create`: no DB connection held across WorkOS calls (INV-41).
    try {
      const orgId = await this.workosOrganizationProvisioner.ensureWorkosOrganization(claim.workspaceId)
      if (orgId) {
        await this.workosOrgService.ensureOrganizationMembership({
          organizationId: orgId,
          userId: workosUserId,
          roleSlug: claim.role,
        })
      }
    } catch (error) {
      logger.warn(
        { err: error, workspaceId: claim.workspaceId },
        "Failed to sync WorkOS org membership on org workspace claim"
      )
    }
  }

  /** Outbox handler: bind the claimer to their regional user, making the first claimer its owner. */
  async claimOrgWorkspaceInRegion(payload: OrgWorkspaceClaimPayload): Promise<void> {
    const { region, ...request } = payload
    await this.regionalClient.claimOrgWorkspace(region, request)
  }

  /** Outbox handler: create the org workspace in its region and add the people it lacks. */
  async ensureOrgWorkspaceInRegion(payload: OrgWorkspaceEnsurePayload): Promise<void> {
    const { region, ...request } = payload
    await this.regionalClient.ensureOrgWorkspace(region, request)
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
      timezone: payload.timezone,
    })
    logger.info({ workspaceId: payload.workspaceId, region: payload.region }, "Workspace provisioned in region")
  }

  /** The tier write and the fan-out outbox event commit atomically (INV-7). */
  async setTier(workspaceId: string, tier: WorkspaceTier): Promise<WorkspaceTier> {
    await withTransaction(this.pool, async (client) => {
      if (!(await WorkspaceRegistryRepository.updateTier(client, workspaceId, tier))) {
        throw new HttpError("Workspace not found", { status: 404, code: "NOT_FOUND" })
      }
      await OutboxRepository.insert(client, OUTBOX_WORKSPACE_TIER_SYNC, {
        workspaceId,
      } satisfies WorkspaceTierSyncPayload)
    })
    return tier
  }

  /** Outbox handler: push the current tier, not event-time state, to the workspace's region. */
  async syncTierToRegion(payload: WorkspaceTierSyncPayload): Promise<void> {
    const workspace = await WorkspaceRegistryRepository.findById(this.pool, payload.workspaceId)
    if (!workspace) {
      logger.warn({ workspaceId: payload.workspaceId }, "Workspace tier sync skipped: workspace not in registry")
      return
    }
    await this.regionalClient.syncWorkspaceTier(workspace.region, { workspaceId: workspace.id, tier: workspace.tier })
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

/** Carries only the workspace; the handler re-reads the current tier, so replays are idempotent. */
export interface WorkspaceTierSyncPayload extends Record<string, unknown> {
  workspaceId: string
}

export interface RegionalCreatePayload {
  workspaceId: string
  name: string
  slug: string
  region: string
  ownerWorkosUserId: string
  ownerEmail: string
  ownerName: string
  /** Absent on events enqueued before workspaces carried a timezone. */
  timezone?: string
}

export interface OrgWorkspaceEnsurePayload extends OrgWorkspaceEnsureRequest {
  region: string
}

export interface OrgWorkspaceClaimPayload extends OrgWorkspaceClaimRequest {
  region: string
}
