import { Pool } from "pg"
import { withTransaction, withClient, type Querier } from "../../db"
import { WorkspaceRepository, Workspace } from "./repository"
import { UserRepository, type User } from "./user-repository"
import { OutboxRepository } from "../../lib/outbox"
import { StreamRepository, StreamMemberRepository } from "../streams"
import { EmojiUsageRepository } from "../emoji"
import { PersonaRepository, type Persona } from "../agents"
import { workspaceId, userId as generateUserId, streamId, avatarUploadId } from "../../lib/id"
import { generateSlug, generateUniqueSlug, serializeBigInt } from "@threa/backend-common"
import { WORKSPACE_ROLE_SLUGS } from "@threa/types"
import { HttpError, isUniqueViolation } from "../../lib/errors"
import { logger } from "../../lib/logger"
import { JobQueues } from "../../lib/queue"
import type { QueueManager } from "../../lib/queue"
import type { WorkosOrgService } from "@threa/backend-common"
import { UserApiKeyRepository } from "../user-api-keys"
import { AvatarUploadRepository } from "./avatar-upload-repository"
import type { AvatarService } from "./avatar-service"

function deriveSlugFromEmail(email: string): string {
  const prefix = email.split("@")[0]
  return generateSlug(prefix)
}

export interface CreateWorkspaceParams {
  name: string
  workosUserId: string
  email: string
  userName: string
  setupCompleted?: boolean
}

interface WorkspaceServiceOptions {
  requireWorkspaceCreationInvite?: boolean
}

export class WorkspaceService {
  private pool: Pool
  private workosOrgService: WorkosOrgService | null
  private avatarService: AvatarService
  private jobQueue: QueueManager
  private requireWorkspaceCreationInvite: boolean

  constructor(
    pool: Pool,
    avatarService: AvatarService,
    jobQueue: QueueManager,
    workosOrgService?: WorkosOrgService,
    options?: WorkspaceServiceOptions
  ) {
    this.pool = pool
    this.avatarService = avatarService
    this.jobQueue = jobQueue
    this.workosOrgService = workosOrgService ?? null
    this.requireWorkspaceCreationInvite = options?.requireWorkspaceCreationInvite ?? false
  }

  async getWorkspaceById(id: string): Promise<Workspace | null> {
    return WorkspaceRepository.findById(this.pool, id)
  }

  async getWorkspaceBySlug(slug: string): Promise<Workspace | null> {
    return WorkspaceRepository.findBySlug(this.pool, slug)
  }

  async getWorkspacesByWorkosUserId(workosUserId: string): Promise<Workspace[]> {
    return WorkspaceRepository.list(this.pool, { workosUserId })
  }

  /**
   * Create a workspace from a control-plane instruction.
   * Accepts a pre-generated ID and slug — skips invite validation and slug generation
   * since the control-plane already handled those.
   *
   * Idempotent: if the workspace already exists (e.g. control-plane retrying after
   * its local DB commit failed), returns the existing workspace instead of failing.
   */
  async createWorkspaceFromControlPlane(params: {
    id: string
    name: string
    slug: string
    ownerWorkosUserId: string
    ownerEmail: string
    ownerName: string
  }): Promise<Workspace> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const ownerUserId = generateUserId()

        const ws = await WorkspaceRepository.insert(client, {
          id: params.id,
          name: params.name,
          slug: params.slug,
          createdBy: ownerUserId,
        })

        await this.createUserInTransaction(client, {
          id: ownerUserId,
          workspaceId: params.id,
          workosUserId: params.ownerWorkosUserId,
          email: params.ownerEmail,
          name: params.ownerName,
          role: "owner",
        })

        return ws
      })
    } catch (error) {
      // Idempotency guard: if this exact workspace PK already exists, return it.
      // Only catch PK collisions — slug or other constraint violations are real errors.
      if (isUniqueViolation(error, "workspaces_pkey")) {
        const existing = await WorkspaceRepository.findById(this.pool, params.id)
        if (existing) return existing
      }
      throw error
    }
  }

  async createWorkspace(params: CreateWorkspaceParams): Promise<Workspace> {
    if (this.requireWorkspaceCreationInvite) {
      await this.assertWorkspaceCreationAllowed(params.email)
    }

    return withTransaction(this.pool, async (client) => {
      const id = workspaceId()
      const ownerUserId = generateUserId()
      const slug = await generateUniqueSlug(params.name, (slug) => WorkspaceRepository.slugExists(client, slug))

      const ws = await WorkspaceRepository.insert(client, {
        id,
        name: params.name,
        slug,
        createdBy: ownerUserId,
      })

      await this.createUserInTransaction(client, {
        id: ownerUserId,
        workspaceId: id,
        workosUserId: params.workosUserId,
        email: params.email,
        name: params.userName,
        role: "owner",
        setupCompleted: params.setupCompleted,
      })

      return ws
    })
  }

  private async assertWorkspaceCreationAllowed(email: string): Promise<void> {
    if (!this.workosOrgService) {
      throw new HttpError("Workspace invite validation is not configured", {
        status: 500,
        code: "WORKSPACE_INVITE_VALIDATION_NOT_CONFIGURED",
      })
    }

    const normalizedEmail = email.trim().toLowerCase()
    const hasWorkspaceCreationInvite =
      await this.workosOrgService.hasAcceptedWorkspaceCreationInvitation(normalizedEmail)
    if (!hasWorkspaceCreationInvite) {
      throw new HttpError("Workspace creation requires a dedicated workspace invite.", {
        status: 403,
        code: "WORKSPACE_CREATION_INVITE_REQUIRED",
      })
    }
  }

  async addUser(
    wsId: string,
    params: {
      workosUserId: string
      email: string
      name: string
      role?: User["role"]
      setupCompleted?: boolean
    }
  ): Promise<User> {
    return withTransaction(this.pool, async (client) => {
      return this.createUserInTransaction(client, {
        workspaceId: wsId,
        workosUserId: params.workosUserId,
        email: params.email,
        name: params.name,
        role: params.role ?? WORKSPACE_ROLE_SLUGS.MEMBER,
        setupCompleted: params.setupCompleted,
      })
    })
  }

  /**
   * Idempotently ensure a regional `users` row exists for a confirmed member.
   * Drives the same creation path as invite-accept (system stream + outbox
   * fan-out) so a self-healed user is indistinguishable from a normally
   * provisioned one. `setupCompleted: false` routes them through first-run
   * setup, which fills in the details the failed sync never delivered.
   *
   * Concurrent first requests race on the `(workspace_id, workos_user_id)`
   * unique constraint; the loser re-reads and returns the winner (INV-20).
   */
  async ensureUserProvisioned(params: {
    workspaceId: string
    workosUserId: string
    email: string
    name: string
    role: User["role"]
  }): Promise<User> {
    const existing = await UserRepository.findByWorkosUserIdInWorkspace(
      this.pool,
      params.workspaceId,
      params.workosUserId
    )
    if (existing) return existing

    try {
      return await withTransaction(this.pool, async (client) =>
        this.createUserInTransaction(client, {
          workspaceId: params.workspaceId,
          workosUserId: params.workosUserId,
          email: params.email,
          name: params.name,
          role: params.role,
          setupCompleted: false,
        })
      )
    } catch (error) {
      if (isUniqueViolation(error, "users_workspace_workos_user_key")) {
        const raced = await UserRepository.findByWorkosUserIdInWorkspace(
          this.pool,
          params.workspaceId,
          params.workosUserId
        )
        if (raced) return raced
        throw new Error(
          `users row vanished after unique-constraint collision for workspace ${params.workspaceId}, workosUser ${params.workosUserId}`,
          { cause: error }
        )
      }
      throw error
    }
  }

  async createUserInTransaction(
    client: Querier,
    params: {
      id?: string
      workspaceId: string
      workosUserId: string
      email: string
      name: string
      role: User["role"]
      setupCompleted?: boolean
    }
  ): Promise<User> {
    const normalizedEmail = params.email.trim().toLowerCase()
    const userSlug = await generateUniqueSlug(params.name, (s) =>
      UserRepository.slugExistsInWorkspace(client, params.workspaceId, s)
    )

    const user = await UserRepository.insert(client, {
      id: params.id ?? generateUserId(),
      workspaceId: params.workspaceId,
      workosUserId: params.workosUserId,
      email: normalizedEmail,
      slug: userSlug,
      name: params.name,
      role: params.role,
      setupCompleted: params.setupCompleted,
    })

    await OutboxRepository.insert(client, "workspace_user:added", {
      workspaceId: params.workspaceId,
      user: serializeBigInt(user),
    })

    const sId = streamId()
    const stream = await StreamRepository.insertSystemStream(client, {
      id: sId,
      workspaceId: params.workspaceId,
      createdBy: user.id,
    })
    await StreamMemberRepository.insert(client, sId, user.id)
    await OutboxRepository.insert(client, "stream:created", {
      workspaceId: params.workspaceId,
      streamId: sId,
      stream,
    })

    return user
  }

  async removeUser(workspaceId: string, userId: string): Promise<void> {
    return withTransaction(this.pool, async (client) => {
      await UserApiKeyRepository.revokeAllByUser(client, workspaceId, userId)
      await UserRepository.remove(client, workspaceId, userId)

      await OutboxRepository.insert(client, "workspace_user:removed", {
        workspaceId,
        removedUserId: userId,
      })
    })
  }

  async getUsers(workspaceId: string): Promise<User[]> {
    return UserRepository.listByWorkspace(this.pool, workspaceId)
  }

  async isMember(workspaceId: string, workosUserId: string): Promise<boolean> {
    return UserRepository.isMember(this.pool, workspaceId, workosUserId)
  }

  async getPersonasForWorkspace(workspaceId: string): Promise<Persona[]> {
    return PersonaRepository.listForWorkspace(this.pool, workspaceId)
  }

  async getEmojiWeights(workspaceId: string, userId: string): Promise<Record<string, number>> {
    return EmojiUsageRepository.getWeights(this.pool, workspaceId, userId)
  }

  async isSlugAvailable(workspaceId: string, slug: string, excludeUserId?: string): Promise<boolean> {
    if (excludeUserId) {
      const user = await UserRepository.findById(this.pool, workspaceId, excludeUserId)
      if (user && user.slug === slug) return true
    }
    const exists = await UserRepository.slugExistsInWorkspace(this.pool, workspaceId, slug)
    return !exists
  }

  async completeUserSetup(
    userId: string,
    workspaceId: string,
    params: { name?: string; slug?: string; timezone: string; locale: string }
  ): Promise<User> {
    // Phase 1: Fast reads
    const { user, orgId } = await withClient(this.pool, async (client) => {
      const user = await UserRepository.findById(client, workspaceId, userId)
      if (!user) {
        throw new HttpError("User not found", { status: 404, code: "USER_NOT_FOUND" })
      }

      if (user.setupCompleted) {
        throw new HttpError("User setup already completed", { status: 400, code: "SETUP_ALREADY_COMPLETED" })
      }

      const orgId = await WorkspaceRepository.getWorkosOrganizationId(client, workspaceId)
      return { user, orgId }
    })

    // Phase 2: External API call — no DB connection held
    const preferEmailSlug = await this.shouldPreferEmailSlug(orgId, user.email)

    // Phase 3: Transaction with retry on slug collision.
    // generateUniqueSlug checks availability within the transaction, but a concurrent
    // transaction can claim the same slug before our COMMIT. The UNIQUE constraint
    // catches this — retry with a fresh check so the next attempt sees the committed slug.
    const MAX_SLUG_ATTEMPTS = 3
    for (let attempt = 1; ; attempt++) {
      try {
        return await withTransaction(this.pool, async (client) => {
          // Re-read user inside transaction to get fresh slug (Phase 1 value may be stale)
          const currentUser = await UserRepository.findById(client, workspaceId, userId)
          if (!currentUser || currentUser.setupCompleted) {
            throw new HttpError("User setup already completed", { status: 400, code: "SETUP_ALREADY_COMPLETED" })
          }

          let slug: string

          if (preferEmailSlug) {
            slug = deriveSlugFromEmail(currentUser.email)
          } else if (params.slug) {
            slug = generateSlug(params.slug)
          } else {
            const slugBaseName = params.name ?? currentUser.name
            slug = await generateUniqueSlug(slugBaseName, (s) =>
              UserRepository.slugExistsInWorkspace(client, workspaceId, s)
            )
          }

          const slugExists = await UserRepository.slugExistsInWorkspace(client, workspaceId, slug)
          if (slugExists && slug !== currentUser.slug) {
            slug = await generateUniqueSlug(slug, (s) => UserRepository.slugExistsInWorkspace(client, workspaceId, s))
          }

          const updated = await UserRepository.update(client, workspaceId, userId, {
            slug,
            name: params.name,
            timezone: params.timezone,
            locale: params.locale,
            setupCompleted: true,
          })

          if (!updated) {
            throw new HttpError("User setup already completed", { status: 400, code: "SETUP_ALREADY_COMPLETED" })
          }

          await OutboxRepository.insert(client, "workspace_user:updated", {
            workspaceId,
            user: serializeBigInt(updated),
          })

          return updated
        })
      } catch (error) {
        if (attempt >= MAX_SLUG_ATTEMPTS || !isUniqueViolation(error, "users_workspace_slug_key")) {
          throw error
        }
      }
    }
  }

  async updateUserProfile(
    userId: string,
    workspaceId: string,
    params: {
      name?: string
      description?: string | null
      pronouns?: string | null
      phone?: string | null
      githubUsername?: string | null
    }
  ): Promise<User> {
    return withTransaction(this.pool, async (client) => {
      const updated = await UserRepository.update(client, workspaceId, userId, params)
      if (!updated) {
        throw new HttpError("User not found", { status: 404, code: "USER_NOT_FOUND" })
      }

      await OutboxRepository.insert(client, "workspace_user:updated", {
        workspaceId,
        user: serializeBigInt(updated),
      })

      return updated
    })
  }

  /**
   * Set or clear the caller's cosmetic status. `emoji`/`text`/`expiresAt` are
   * passed straight through (clearing = all null), so the user-row write and
   * the `workspace_user:updated` broadcast stay in one transaction (INV-7).
   */
  async setUserStatus(
    userId: string,
    workspaceId: string,
    status: { statusEmoji: string | null; statusText: string | null; statusExpiresAt: Date | null }
  ): Promise<User> {
    return withTransaction(this.pool, async (client) => {
      const updated = await UserRepository.update(client, workspaceId, userId, status)
      if (!updated) {
        throw new HttpError("User not found", { status: 404, code: "USER_NOT_FOUND" })
      }

      await OutboxRepository.insert(client, "workspace_user:updated", {
        workspaceId,
        user: serializeBigInt(updated),
      })

      return updated
    })
  }

  async uploadAvatar(userId: string, workspaceId: string, buffer: Buffer): Promise<User> {
    // Phase 1: Verify user exists and capture current avatar for replacement tracking
    const user = await UserRepository.findById(this.pool, workspaceId, userId)
    if (!user) {
      throw new HttpError("User not found", { status: 404, code: "USER_NOT_FOUND" })
    }

    // Phase 2: Upload raw buffer to S3 (single fast PUT, no processing)
    const rawS3Key = await this.avatarService.uploadRaw({ buffer, workspaceId, userId })

    // Phase 3: Create upload tracking row and enqueue job
    const uploadId = avatarUploadId()
    try {
      await AvatarUploadRepository.insert(this.pool, {
        id: uploadId,
        workspaceId,
        userId,
        rawS3Key,
        replacesAvatarUrl: user.avatarUrl,
      })
    } catch (error) {
      this.avatarService.deleteRawFile(rawS3Key)
      throw error
    }

    await this.jobQueue.send(JobQueues.AVATAR_PROCESS, {
      workspaceId,
      avatarUploadId: uploadId,
    })

    return user
  }

  async removeUserAvatar(userId: string, workspaceId: string): Promise<User> {
    let oldAvatarUrl: string | null = null

    const updated = await withTransaction(this.pool, async (client) => {
      const currentUser = await UserRepository.findById(client, workspaceId, userId)
      oldAvatarUrl = currentUser?.avatarUrl ?? null

      // Delete any in-flight upload rows — racing workers will see their row gone and skip
      await AvatarUploadRepository.deleteByUserId(client, userId)

      const result = await UserRepository.update(client, workspaceId, userId, {
        avatarUrl: null,
      })
      if (!result) {
        throw new HttpError("User not found", { status: 404, code: "USER_NOT_FOUND" })
      }

      await OutboxRepository.insert(client, "workspace_user:updated", {
        workspaceId,
        user: serializeBigInt(result),
      })

      return result
    })

    if (oldAvatarUrl) {
      this.avatarService.deleteAvatarFiles(oldAvatarUrl)
    }

    return updated
  }

  /**
   * Ensure a WorkOS organization exists for the given workspace.
   * 3-tier lookup: local cache → WorkOS by external ID → create new.
   * No DB connection held during WorkOS API calls (INV-41).
   */
  async ensureWorkosOrganization(workspaceId: string): Promise<string | null> {
    if (!this.workosOrgService) return null

    // Tier 1: Local DB cache
    const cached = await WorkspaceRepository.getWorkosOrganizationId(this.pool, workspaceId)
    if (cached) return cached

    // Tier 2: WorkOS by external ID
    const existing = await this.workosOrgService.getOrganizationByExternalId(workspaceId)
    if (existing) {
      await WorkspaceRepository.setWorkosOrganizationId(this.pool, workspaceId, existing.id)
      return existing.id
    }

    // Tier 3: Create new (with concurrent-creation race guard)
    const workspace = await WorkspaceRepository.findById(this.pool, workspaceId)
    if (!workspace) return null

    try {
      const org = await this.workosOrgService.createOrganization({
        name: workspace.name,
        externalId: workspaceId,
      })
      await WorkspaceRepository.setWorkosOrganizationId(this.pool, workspaceId, org.id)
    } catch (error) {
      logger.error({ err: error, workspaceId }, "Failed to create WorkOS organization")
    }

    // Re-read to get the winning org ID (handles concurrent creation race)
    return WorkspaceRepository.getWorkosOrganizationId(this.pool, workspaceId)
  }

  private async shouldPreferEmailSlug(orgId: string | null, email: string): Promise<boolean> {
    if (!this.workosOrgService || !orgId) return false

    const org = await this.workosOrgService.getOrganization(orgId)
    if (!org || org.domains.length === 0) return false

    const emailDomain = email.split("@")[1]?.toLowerCase()
    return org.domains.some((d) => d.toLowerCase() === emailDomain)
  }
}
