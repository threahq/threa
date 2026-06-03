import type { Pool } from "pg"
import {
  HttpError,
  logger,
  OutboxRepository,
  getWorkosErrorCode,
  displayNameFromWorkos,
  type OutboxEventStatus,
  type WorkosOrgService,
  type WorkosUserSummary,
} from "@threa/backend-common"
import type { WorkspaceInvitableRole } from "@threa/types"
import { PlatformRoleRepository } from "./repository"
import { WorkspaceRegistryRepository } from "../workspaces"
import { WorkosAuthzBackfill, WorkosAuthzRepository } from "../workos-authz"
import type { WorkosAuthzOrganizationBackfillResult } from "../workos-authz"
import { InvitationShadowRepository } from "../invitation-shadows"
import { WaitlistRepository } from "../waitlist"
import { CONTROL_PLANE_LISTENER_ID } from "../../lib/outbox-listeners"

/**
 * Cap on the number of waitlist rows returned to the backoffice table. The
 * headline counts come from a separate grouped query (exact regardless of this
 * cap), so a large waitlist degrades to "most recent N" rather than an
 * unbounded payload.
 */
const WAITLIST_LIST_LIMIT = 500

/** Platform roles recognised by the backoffice gate. */
export const PLATFORM_ROLES = ["admin"] as const
export type PlatformRole = (typeof PLATFORM_ROLES)[number]

export function isValidPlatformRole(value: string): value is PlatformRole {
  return (PLATFORM_ROLES as readonly string[]).includes(value)
}

/** WorkOS invitation error codes we want to surface nicely to the UI. */
const WORKOS_ERROR_CODES = {
  EMAIL_ALREADY_INVITED: "email_already_invited_to_organization",
  USER_ALREADY_MEMBER: "user_already_organization_member",
  USER_ALREADY_EXISTS: "user_already_exists",
} as const

/**
 * WorkOS' SDK surfaces an unstructured `GenericServerException: User already
 * exists.` when you try to send an app-level invitation to an email that
 * already has a WorkOS user. There is no stable error code for this case, so
 * fall back to a message substring check — narrow, unambiguous, and unlikely
 * to collide with other error messages.
 */
const USER_ALREADY_EXISTS_MESSAGE = "User already exists"

function isUserAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  if ("message" in error && typeof error.message === "string") {
    return error.message.includes(USER_ALREADY_EXISTS_MESSAGE)
  }
  return false
}

/** Reference to a workspace an accepted invitation ended up creating/joining. */
export interface WorkspaceRef {
  id: string
  name: string
  slug: string
}

export interface WorkspaceOwnerInvitation {
  id: string
  email: string
  state: "pending" | "accepted" | "revoked" | "expired"
  acceptedAt: string | null
  revokedAt: string | null
  expiresAt: string
  createdAt: string
  updatedAt: string
  /** Populated for accepted invitations whose invitee already belongs to one or more workspaces. */
  workspaces: WorkspaceRef[]
}

export interface WorkspaceSummary {
  id: string
  name: string
  slug: string
  region: string
  createdByWorkosUserId: string
  workosOrganizationId: string | null
  memberCount: number
  createdAt: string
  updatedAt: string
}

export interface WorkspaceOwnerSummary {
  workosUserId: string
  email: string | null
  name: string | null
}

export interface WorkspaceDetail extends WorkspaceSummary {
  owner: WorkspaceOwnerSummary
}

/**
 * Mirror-derived view of a workspace member. Source of truth is
 * `workos_organization_memberships` (populated by `WorkosAuthzPoller` and the
 * backfill script). `firstName`/`lastName` are best-effort lookups via WorkOS;
 * they're null when the user no longer exists or WorkOS lookup fails.
 *
 * `lastEventAt` is the timestamp from the latest event applied to the row, or
 * the backfill timestamp if no events have arrived yet — exposed so the UI can
 * show a "last sync" hint and make stale data visible.
 */
export interface WorkspaceMemberSummary {
  workosUserId: string
  email: string | null
  firstName: string | null
  lastName: string | null
  status: string
  roleSlugs: string[]
  lastEventAt: string
}

/**
 * Pending invitation_shadows row decorated with inviter metadata. Email is
 * null for link invitations until someone claims the token. `inviter` is null
 * when the shadow predates the inviter column or the user lookup fails — the
 * UI falls back to "Unknown".
 */
export interface WorkspaceInvitationSummary {
  id: string
  kind: "email" | "link"
  email: string | null
  roleSlug: WorkspaceInvitableRole
  expiresAt: string
  createdAt: string
  inviter: {
    workosUserId: string
    email: string | null
    name: string | null
  } | null
}

/** A single marketing-site waitlist signup, shaped for the backoffice table. */
export interface WaitlistEntry {
  id: string
  email: string
  /** Where the signup came from (marketing CTA id, etc.); null when unset. */
  source: string | null
  status: string
  createdAt: string
}

/** Exact signup counts, computed in the database so a list cap never skews them. */
export interface WaitlistStats {
  total: number
  pending: number
  invited: number
}

/**
 * Backoffice waitlist view: the most recent signups plus exact headline counts.
 * `truncated` is true when there are more signups than `entries` contains, so
 * the UI can say "showing the most recent N".
 */
export interface WaitlistOverview {
  entries: WaitlistEntry[]
  stats: WaitlistStats
  truncated: boolean
}

/**
 * Static config the backoffice frontend needs to render external links to
 * the user-facing app and to the WorkOS dashboard. Both values are optional
 * — when missing, the frontend falls back to plain text instead of a link.
 */
export interface BackofficeConfig {
  /**
   * Base URL where the user-facing app lives, e.g. `https://app.threa.io`
   * (prod) or `http://localhost:4813` (dev). Used to build per-workspace
   * deep links like `${appBaseUrl}/ws/${workspaceId}`. Empty string when
   * `FRONTEND_URL` is unset on the control plane.
   */
  workspaceAppBaseUrl: string
  /**
   * WorkOS dashboard environment id (e.g. `environment_01KA3BVADMEYB99HGDHBJM1SE7`).
   * Used to deep-link to the WorkOS dashboard for an organization. Null when
   * `WORKOS_ENVIRONMENT_ID` is unset on the control plane (typical in dev).
   */
  workosEnvironmentId: string | null
}

interface Dependencies {
  pool: Pool
  workosOrgService: WorkosOrgService
  authzBackfill: WorkosAuthzBackfill
  workspaceAppBaseUrl: string
  workosEnvironmentId: string | null
}

/**
 * Backoffice service — backs the `/api/backoffice/*` surface.
 *
 * Owns the platform-admin gate (role lookup) and workspace-owner invitation
 * flow. Future backoffice domains (billing, support tooling, audits) should
 * get their own feature folders and reuse the platform-admin middleware from
 * here via the standard composition in routes.ts.
 */
export class BackofficeService {
  private pool: Pool
  private workosOrgService: WorkosOrgService
  private authzBackfill: WorkosAuthzBackfill
  private workspaceAppBaseUrl: string
  private workosEnvironmentId: string | null

  constructor({ pool, workosOrgService, authzBackfill, workspaceAppBaseUrl, workosEnvironmentId }: Dependencies) {
    this.pool = pool
    this.workosOrgService = workosOrgService
    this.authzBackfill = authzBackfill
    this.workspaceAppBaseUrl = workspaceAppBaseUrl
    this.workosEnvironmentId = workosEnvironmentId
  }

  /** Static config the backoffice frontend needs for external linking. */
  getConfig(): BackofficeConfig {
    return {
      workspaceAppBaseUrl: this.workspaceAppBaseUrl,
      workosEnvironmentId: this.workosEnvironmentId,
    }
  }

  async isPlatformAdmin(workosUserId: string): Promise<boolean> {
    const row = await PlatformRoleRepository.findByWorkosUserId(this.pool, workosUserId)
    return row?.role === "admin"
  }

  /**
   * Invite a new workspace owner by sending a WorkOS app-level invitation
   * (no organizationId). When the invitee accepts and signs in, the control
   * plane's existing `hasAcceptedWorkspaceCreationInvitation` check will
   * recognize the accepted invitation and let them create their own workspace.
   */
  async createWorkspaceOwnerInvitation(params: {
    email: string
    inviterWorkosUserId: string
  }): Promise<WorkspaceOwnerInvitation> {
    try {
      const invitation = await this.workosOrgService.sendInvitation({
        email: params.email,
        inviterUserId: params.inviterWorkosUserId,
      })
      logger.info(
        { email: params.email, invitationId: invitation.id, inviter: params.inviterWorkosUserId },
        "Backoffice: workspace owner invitation sent"
      )
      const now = new Date().toISOString()
      return {
        id: invitation.id,
        email: params.email,
        state: "pending",
        acceptedAt: null,
        revokedAt: null,
        expiresAt: invitation.expiresAt.toISOString(),
        createdAt: now,
        updatedAt: now,
        workspaces: [],
      }
    } catch (error) {
      this.rethrowWorkosInvitationError(error)
    }
  }

  async revokeWorkspaceOwnerInvitation(invitationId: string): Promise<void> {
    await this.workosOrgService.revokeInvitation(invitationId)
    logger.info({ invitationId }, "Backoffice: workspace owner invitation revoked")
  }

  async resendWorkspaceOwnerInvitation(invitationId: string): Promise<WorkspaceOwnerInvitation> {
    try {
      const fresh = await this.workosOrgService.resendInvitation(invitationId)
      logger.info({ oldInvitationId: invitationId, newInvitationId: fresh.id }, "Backoffice: invitation resent")
      // The new invitation inherits the email from the old one — look it up
      // via a full list to avoid needing a dedicated `getInvitation` method on
      // the service interface. Small price to pay, called rarely.
      const all = await this.workosOrgService.listAppInvitations()
      const match = all.find((i) => i.id === fresh.id)
      if (!match) {
        throw new HttpError("Resent invitation not found", { status: 500, code: "RESEND_FAILED" })
      }
      return {
        id: match.id,
        email: match.email,
        state: match.state,
        acceptedAt: match.acceptedAt,
        revokedAt: match.revokedAt,
        expiresAt: match.expiresAt,
        createdAt: match.createdAt,
        updatedAt: match.updatedAt,
        workspaces: [],
      }
    } catch (error) {
      this.rethrowWorkosInvitationError(error)
    }
  }

  /**
   * List all workspace-owner invitations — app-level WorkOS invitations with
   * no organization attached. Resolves `acceptedUserId` → workspaces so the
   * UI can link each accepted invite to the workspaces the invitee belongs to.
   */
  async listWorkspaceOwnerInvitations(): Promise<WorkspaceOwnerInvitation[]> {
    const raw = await this.workosOrgService.listAppInvitations()
    const acceptedUserIds = raw.map((i) => i.acceptedUserId).filter((id): id is string => id != null)

    const workspacesByUser =
      acceptedUserIds.length > 0
        ? await this.buildWorkspaceRefsByUser(acceptedUserIds)
        : new Map<string, WorkspaceRef[]>()

    return raw.map((invite) => ({
      id: invite.id,
      email: invite.email,
      state: invite.state,
      acceptedAt: invite.acceptedAt,
      revokedAt: invite.revokedAt,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
      updatedAt: invite.updatedAt,
      workspaces: invite.acceptedUserId ? (workspacesByUser.get(invite.acceptedUserId) ?? []) : [],
    }))
  }

  /** List every workspace in the registry. Backoffice-only — no workspace scoping. */
  async listAllWorkspaces(): Promise<WorkspaceSummary[]> {
    const rows = await WorkspaceRegistryRepository.listAllWithMemberCounts(this.pool)
    return rows.map((row) => this.toWorkspaceSummary(row))
  }

  async getWorkspaceDetail(id: string): Promise<WorkspaceDetail> {
    const row = await WorkspaceRegistryRepository.findByIdWithMemberCount(this.pool, id)
    if (!row) {
      throw new HttpError("Workspace not found", { status: 404, code: "NOT_FOUND" })
    }
    const ownerUser = await this.workosOrgService.getUser(row.created_by_workos_user_id)
    return {
      ...this.toWorkspaceSummary(row),
      owner: summarizeOwner(row.created_by_workos_user_id, ownerUser),
    }
  }

  /**
   * List the WorkOS-mirrored membership for a workspace. Returns an empty
   * array if the workspace exists but isn't linked to a WorkOS organization
   * yet (or backfill hasn't reached it).
   *
   * 404s when the workspace itself doesn't exist so the UI can distinguish
   * "no members yet" from "wrong id".
   */
  async listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMemberSummary[]> {
    const workspace = await WorkspaceRegistryRepository.findById(this.pool, workspaceId)
    if (!workspace) {
      throw new HttpError("Workspace not found", { status: 404, code: "NOT_FOUND" })
    }
    if (!workspace.workos_organization_id) {
      return []
    }

    const rows = await WorkosAuthzRepository.listByOrganization(this.pool, workspace.workos_organization_id)
    if (rows.length === 0) return []

    // Single batched WorkOS round-trip via `listUsers({ organizationId })`,
    // joined back to mirror rows in-memory. If the call fails the tab still
    // renders with workosUserId-only fallbacks rather than 500-ing the page.
    const userByWorkosId = new Map<string, WorkosUserSummary>()
    try {
      const users = await this.workosOrgService.listOrganizationUsers(workspace.workos_organization_id)
      for (const user of users) userByWorkosId.set(user.id, user)
    } catch (err) {
      logger.warn(
        { err, workspaceId, organizationId: workspace.workos_organization_id },
        "Backoffice: failed to list WorkOS users for organization; rendering members without enrichment"
      )
    }

    return rows.map((row) => {
      const user = userByWorkosId.get(row.workos_user_id) ?? null
      return {
        workosUserId: row.workos_user_id,
        email: user?.email ?? null,
        firstName: user?.firstName ?? null,
        lastName: user?.lastName ?? null,
        status: row.status,
        roleSlugs: row.role_slugs,
        lastEventAt: row.last_event_at.toISOString(),
      }
    })
  }

  /**
   * Operator-triggered re-sync of one workspace's membership mirror. Re-reads
   * the full membership list from WorkOS, upserts the CP mirror, and emits
   * outbox events that fan out to the regional `workspace_user_permissions`.
   * Idempotent; useful when the event poller has drifted or fan-out has
   * stalled and PATs are 401-ing with `OWNER_INACTIVE`.
   *
   * Returns counts plus the outbox event ids the backfill emitted, so the UI
   * can poll `getOutboxEventStatuses` to surface fan-out progress and make
   * dead-lettered failures visible — otherwise a "Re-sync complete" banner
   * would lie about regional reality. 400 (`NOT_LINKED`) when the workspace
   * has no WorkOS organization attached.
   */
  async resyncWorkspaceMembers(workspaceId: string): Promise<WorkosAuthzOrganizationBackfillResult> {
    const workspace = await WorkspaceRegistryRepository.findById(this.pool, workspaceId)
    if (!workspace) {
      throw new HttpError("Workspace not found", { status: 404, code: "NOT_FOUND" })
    }
    if (!workspace.workos_organization_id) {
      throw new HttpError("Workspace not linked to a WorkOS organization", {
        status: 400,
        code: "NOT_LINKED",
      })
    }
    return this.authzBackfill.runForOrganization(workspace.workos_organization_id)
  }

  /**
   * Report processing state for a set of outbox event ids against the
   * control-plane listener. Used by the backoffice "Re-sync members" UI to
   * poll until fan-out has drained (or to surface dead-lettered events).
   *
   * The listener id is fixed server-side rather than accepted from the
   * client: backoffice consumers only ever care about the single CP listener,
   * and exposing an arbitrary listener id would leak internal infra naming
   * onto a privileged surface.
   */
  async getOutboxEventStatuses(eventIds: string[]): Promise<OutboxEventStatus[]> {
    if (eventIds.length === 0) return []
    const bigIntIds = eventIds.map((id) => {
      try {
        return BigInt(id)
      } catch {
        throw new HttpError("Invalid outbox event id", { status: 400, code: "VALIDATION_ERROR" })
      }
    })
    return OutboxRepository.getEventStatuses(this.pool, CONTROL_PLANE_LISTENER_ID, bigIntIds)
  }

  /**
   * Pending invitations for a workspace, surfaced separately from the WorkOS
   * mirror so admins can see link invitations (never reach WorkOS until
   * claimed) and the role each invite was sent at. Inviter user is looked up
   * in parallel; failures degrade to `inviter: null` rather than failing the
   * whole list.
   */
  async listWorkspaceInvitations(workspaceId: string): Promise<WorkspaceInvitationSummary[]> {
    const workspace = await WorkspaceRegistryRepository.findById(this.pool, workspaceId)
    if (!workspace) {
      throw new HttpError("Workspace not found", { status: 404, code: "NOT_FOUND" })
    }

    const rows = await InvitationShadowRepository.listPendingByWorkspace(this.pool, workspaceId)
    if (rows.length === 0) return []

    const uniqueInviterIds = Array.from(
      new Set(rows.map((r) => r.inviter_workos_user_id).filter((id): id is string => id != null))
    )
    const inviterById = new Map<string, WorkosUserSummary>()
    if (uniqueInviterIds.length > 0) {
      const lookups = await Promise.all(
        uniqueInviterIds.map(async (id) => {
          try {
            return await this.workosOrgService.getUser(id)
          } catch (err) {
            logger.warn({ err, workosUserId: id, workspaceId }, "Backoffice: failed to resolve inviter user")
            return null
          }
        })
      )
      for (const user of lookups) {
        if (user) inviterById.set(user.id, user)
      }
    }

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind === "link" ? "link" : "email",
      email: row.email,
      roleSlug: row.role_slug,
      expiresAt: row.expires_at.toISOString(),
      createdAt: row.created_at.toISOString(),
      inviter: summarizeInviter(row.inviter_workos_user_id, inviterById),
    }))
  }

  /**
   * Backoffice waitlist view. Returns the most recent signups (capped) for the
   * table alongside exact status counts computed in the database, so the
   * headline numbers stay accurate even when the list is truncated. The two
   * reads run concurrently — neither depends on the other.
   */
  async listWaitlist(): Promise<WaitlistOverview> {
    const [rows, counts] = await Promise.all([
      WaitlistRepository.list(this.pool, WAITLIST_LIST_LIMIT),
      WaitlistRepository.statusCounts(this.pool),
    ])

    const countByStatus = new Map(counts.map((c) => [c.status, c.count]))
    const total = counts.reduce((sum, c) => sum + c.count, 0)

    return {
      entries: rows.map((row) => ({
        id: row.id,
        email: row.email,
        source: row.source,
        status: row.status,
        createdAt: row.created_at.toISOString(),
      })),
      stats: {
        total,
        pending: countByStatus.get("pending") ?? 0,
        invited: countByStatus.get("invited") ?? 0,
      },
      truncated: total > rows.length,
    }
  }

  // --- private helpers -----------------------------------------------------

  private rethrowWorkosInvitationError(error: unknown): never {
    const code = getWorkosErrorCode(error)
    if (code === WORKOS_ERROR_CODES.EMAIL_ALREADY_INVITED) {
      throw new HttpError("An invitation for this email already exists", {
        status: 409,
        code: "ALREADY_INVITED",
      })
    }
    if (code === WORKOS_ERROR_CODES.USER_ALREADY_MEMBER) {
      throw new HttpError("This user already has a Threa account", {
        status: 409,
        code: "ALREADY_MEMBER",
      })
    }
    if (code === WORKOS_ERROR_CODES.USER_ALREADY_EXISTS || isUserAlreadyExistsError(error)) {
      throw new HttpError("A Threa user with this email already exists", {
        status: 409,
        code: "USER_ALREADY_EXISTS",
      })
    }
    throw error
  }

  private toWorkspaceSummary(row: {
    id: string
    name: string
    slug: string
    region: string
    created_by_workos_user_id: string
    workos_organization_id: string | null
    member_count: number
    created_at: Date
    updated_at: Date
  }): WorkspaceSummary {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      region: row.region,
      createdByWorkosUserId: row.created_by_workos_user_id,
      workosOrganizationId: row.workos_organization_id,
      memberCount: row.member_count,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }
  }

  /**
   * Build a map of `workosUserId -> WorkspaceRef[]` by batch-querying the
   * membership table and then loading the referenced workspaces in one go.
   * Used to link accepted invitations to the workspaces the invitee joined
   * (in practice: the one they created on signup).
   */
  private async buildWorkspaceRefsByUser(workosUserIds: string[]): Promise<Map<string, WorkspaceRef[]>> {
    const idsByUser = await WorkspaceRegistryRepository.listIdsByUser(this.pool, workosUserIds)
    const allWorkspaceIds = Array.from(new Set([...idsByUser.values()].flat()))
    if (allWorkspaceIds.length === 0) return new Map()

    // Load the referenced workspaces in a single batched query (INV-56) —
    // `findByIds` returns rows for all ids in one round-trip via
    // `WHERE id = ANY($1::text[])`, instead of N parallel `findById` calls.
    const rows = await WorkspaceRegistryRepository.findByIds(this.pool, allWorkspaceIds)
    const workspaceById = new Map<string, WorkspaceRef>()
    for (const row of rows) {
      workspaceById.set(row.id, { id: row.id, name: row.name, slug: row.slug })
    }

    const result = new Map<string, WorkspaceRef[]>()
    for (const [userId, workspaceIds] of idsByUser.entries()) {
      const refs = workspaceIds.map((wsId) => workspaceById.get(wsId)).filter((ref): ref is WorkspaceRef => ref != null)
      if (refs.length > 0) result.set(userId, refs)
    }
    return result
  }
}

function summarizeOwner(workosUserId: string, user: WorkosUserSummary | null): WorkspaceOwnerSummary {
  if (!user) {
    return { workosUserId, email: null, name: null }
  }
  return {
    workosUserId,
    email: user.email,
    name: displayNameFromWorkos({ email: user.email, firstName: user.firstName, lastName: user.lastName }),
  }
}

function summarizeInviter(
  workosUserId: string | null,
  inviterById: Map<string, WorkosUserSummary>
): WorkspaceInvitationSummary["inviter"] {
  if (!workosUserId) return null
  const user = inviterById.get(workosUserId)
  if (!user) return { workosUserId, email: null, name: null }
  return {
    workosUserId,
    email: user.email,
    name: displayNameFromWorkos({ email: user.email, firstName: user.firstName, lastName: user.lastName }),
  }
}

/**
 * Seed platform admins from configuration. Intended to be called once after
 * migrations on control-plane startup. Idempotent — re-running leaves existing
 * rows unchanged except for `updated_at`. Single batch round-trip (INV-56).
 */
export async function seedPlatformAdmins(pool: Pool, workosUserIds: string[]): Promise<void> {
  if (workosUserIds.length === 0) return
  await PlatformRoleRepository.upsertMany(
    pool,
    workosUserIds.map((id) => ({ workosUserId: id, role: "admin" }))
  )
  logger.info({ count: workosUserIds.length }, "Seeded platform admins from env")
}
