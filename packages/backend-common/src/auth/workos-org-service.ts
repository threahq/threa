import { WorkOS, type Event, type EventName } from "@workos-inc/node"
import { logger } from "../logger"
import { WORKOS_REQUEST_TIMEOUT_MS, type WorkosConfig } from "./types"

type WidgetScope =
  | "widgets:api-keys:manage"
  | "widgets:users-table:manage"
  | "widgets:sso:manage"
  | "widgets:domain-verification:manage"

/**
 * Extract error code from WorkOS SDK exceptions.
 * Duck-typed to handle both BadRequestException (.code) and GenericServerException (.rawData.code).
 */
export function getWorkosErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null
  if ("code" in error && typeof error.code === "string") return error.code
  if ("rawData" in error && error.rawData && typeof error.rawData === "object" && "code" in error.rawData) {
    return typeof error.rawData.code === "string" ? error.rawData.code : null
  }
  return null
}

/** Shape of an app-level WorkOS invitation as the backoffice needs it. */
export interface WorkosAppInvitation {
  id: string
  email: string
  state: "pending" | "accepted" | "revoked" | "expired"
  acceptedAt: string | null
  revokedAt: string | null
  expiresAt: string
  createdAt: string
  updatedAt: string
  /** Populated after the invitee signs up; null until accepted. */
  acceptedUserId: string | null
}

export interface WorkosInvitationSummary {
  id: string
  state: "pending" | "accepted" | "revoked" | "expired"
  expiresAt: Date
}

/** Minimal WorkOS user shape the backoffice needs for resolving owners. */
export interface WorkosUserSummary {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
}

/**
 * The subset of organization-membership events the authz mirror cares about.
 * Listed explicitly so the service contract makes the supported set obvious
 * without leaking the full WorkOS event union.
 */
export const WORKOS_MIRROR_EVENT_TYPES = [
  "organization_membership.created",
  "organization_membership.updated",
  "organization_membership.deleted",
] as const

export type WorkosMirrorEventType = (typeof WORKOS_MIRROR_EVENT_TYPES)[number]

/** Decoded WorkOS organization membership event the mirror consumes. */
export interface WorkosMembershipEvent {
  id: string
  type: WorkosMirrorEventType
  createdAt: Date
  membership: WorkosOrganizationMembership
}

/**
 * WorkOS organization-membership lifecycle states. Sourced from the WorkOS
 * dashboard event payload; mirrored in `workspace_user_permissions.status`
 * and validated at the regional fan-out endpoint.
 */
export const WORKOS_MEMBERSHIP_STATUSES = ["active", "inactive", "pending"] as const

export type WorkosMembershipStatus = (typeof WORKOS_MEMBERSHIP_STATUSES)[number]

function isWorkosMembershipStatus(value: unknown): value is WorkosMembershipStatus {
  return typeof value === "string" && (WORKOS_MEMBERSHIP_STATUSES as readonly string[]).includes(value)
}

/** Mirror-shaped membership returned from `listOrganizationMemberships`. */
export interface WorkosOrganizationMembership {
  id: string
  organizationId: string
  userId: string
  status: WorkosMembershipStatus
  roleSlugs: string[]
  /** WorkOS-side updated_at; used as last_event_at when backfill upserts. */
  updatedAt: Date
}

export interface WorkosOrgService {
  createOrganization(params: { name: string; externalId: string }): Promise<{ id: string }>
  getOrganizationByExternalId(externalId: string): Promise<{ id: string } | null>
  hasAcceptedWorkspaceCreationInvitation(email: string): Promise<boolean>
  sendInvitation(params: {
    organizationId?: string
    email: string
    inviterUserId: string
    /** WorkOS role slug applied when the invitation is accepted. */
    roleSlug?: string
  }): Promise<{ id: string; expiresAt: Date }>
  getInvitation(invitationId: string): Promise<WorkosInvitationSummary>
  revokeInvitation(invitationId: string): Promise<void>
  /** Resend an existing invitation. WorkOS issues a fresh token + expiry. */
  resendInvitation(invitationId: string): Promise<{ id: string; expiresAt: Date }>
  /**
   * List every app-level WorkOS invitation (no organizationId). Paginates
   * through the full WorkOS result set — backoffice-only surface, not meant
   * for large tenants.
   */
  listAppInvitations(): Promise<WorkosAppInvitation[]>
  /** Look up a user by WorkOS id. Returns null if the user no longer exists. */
  getUser(workosUserId: string): Promise<WorkosUserSummary | null>
  /**
   * List every user that belongs to a WorkOS organization. Paginates the
   * underlying `userManagement.listUsers({ organizationId })` call to
   * completion. Used by the backoffice members tab to avoid N parallel
   * `getUser` round-trips.
   */
  listOrganizationUsers(organizationId: string): Promise<WorkosUserSummary[]>
  getOrganization(organizationId: string): Promise<{ id: string; domains: string[] } | null>
  ensureOrganizationMembership(params: { organizationId: string; userId: string; roleSlug: string }): Promise<void>
  /**
   * Update an existing membership's role. Caller resolves the membership id
   * from the mirror — the SDK keys updates by membership id, not by
   * `(orgId, userId)`, so the lookup belongs at the call site.
   */
  changeOrganizationMembershipRole(params: { organizationMembershipId: string; roleSlug: string }): Promise<void>
  removeOrganizationMembership(organizationMembershipId: string): Promise<void>
  getWidgetToken(params: { organizationId: string; userId: string; scopes: string[] }): Promise<string>
  /**
   * List WorkOS events for the authz mirror. Returns a normalized, mirror-shaped
   * payload — callers don't need to know the WorkOS SDK union.
   */
  listMirrorEvents(params: {
    after?: string
    limit?: number
  }): Promise<{ data: WorkosMembershipEvent[]; after: string | null }>
  /**
   * List raw WorkOS events for a caller-supplied event set. Unlike
   * {@link listMirrorEvents} (which decodes membership payloads for the authz
   * mirror), this returns the SDK events unmodified so a second consumer — the
   * control-plane `auth_log` ingestion — can extract its own fields.
   */
  listEvents(params: {
    events: EventName[]
    after?: string
    limit?: number
  }): Promise<{ data: Event[]; after: string | null }>
  /**
   * List every membership for an organization, paginated to completion. Used
   * by backfill — low-frequency, run by an explicit operator action.
   */
  listOrganizationMemberships(organizationId: string): Promise<WorkosOrganizationMembership[]>
}

export class WorkosOrgServiceImpl implements WorkosOrgService {
  private workos: WorkOS

  constructor(config: WorkosConfig) {
    this.workos = new WorkOS(config.apiKey, { clientId: config.clientId, timeout: WORKOS_REQUEST_TIMEOUT_MS })
  }

  async createOrganization(params: { name: string; externalId: string }): Promise<{ id: string }> {
    const org = await this.workos.organizations.createOrganization({
      name: params.name,
      externalId: params.externalId,
    })
    logger.info({ orgId: org.id, externalId: params.externalId }, "Created WorkOS organization")
    return { id: org.id }
  }

  async getOrganizationByExternalId(externalId: string): Promise<{ id: string } | null> {
    try {
      const org = await this.workos.organizations.getOrganizationByExternalId(externalId)
      return { id: org.id }
    } catch {
      return null
    }
  }

  async hasAcceptedWorkspaceCreationInvitation(email: string): Promise<boolean> {
    try {
      const normalizedEmail = email.toLowerCase()
      let after: string | undefined

      for (;;) {
        const invitations = await this.workos.userManagement.listInvitations({
          email: normalizedEmail,
          limit: 100,
          ...(after ? { after } : {}),
        })

        const hasAcceptedAppInvitation = invitations.data.some(
          (invitation) => invitation.state === "accepted" && invitation.organizationId == null
        )
        if (hasAcceptedAppInvitation) {
          return true
        }

        after = invitations.listMetadata.after ?? undefined
        if (!after) {
          return false
        }
      }
    } catch (error) {
      logger.error({ err: error, email }, "Failed to list WorkOS invitations")
      throw error
    }
  }

  async sendInvitation(params: {
    organizationId?: string
    email: string
    inviterUserId: string
    roleSlug?: string
  }): Promise<{ id: string; expiresAt: Date }> {
    const invitation = await this.workos.userManagement.sendInvitation({
      email: params.email,
      inviterUserId: params.inviterUserId,
      ...(params.organizationId ? { organizationId: params.organizationId } : {}),
      ...(params.roleSlug ? { roleSlug: params.roleSlug } : {}),
    })
    logger.info(
      { invitationId: invitation.id, email: params.email, roleSlug: params.roleSlug },
      "Sent WorkOS invitation"
    )
    return {
      id: invitation.id,
      expiresAt: new Date(invitation.expiresAt),
    }
  }

  async getInvitation(invitationId: string): Promise<WorkosInvitationSummary> {
    const invitation = await this.workos.userManagement.getInvitation(invitationId)
    return { id: invitation.id, state: invitation.state, expiresAt: new Date(invitation.expiresAt) }
  }

  async revokeInvitation(invitationId: string): Promise<void> {
    await this.workos.userManagement.revokeInvitation(invitationId)
    logger.info({ invitationId }, "Revoked WorkOS invitation")
  }

  async resendInvitation(invitationId: string): Promise<{ id: string; expiresAt: Date }> {
    const fresh = await this.workos.userManagement.resendInvitation(invitationId)
    logger.info({ invitationId, newInvitationId: fresh.id }, "Resent WorkOS invitation")
    return { id: fresh.id, expiresAt: new Date(fresh.expiresAt) }
  }

  async getUser(workosUserId: string): Promise<WorkosUserSummary | null> {
    try {
      const user = await this.workos.userManagement.getUser(workosUserId)
      return {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      }
    } catch (error) {
      logger.warn({ err: error, workosUserId }, "Failed to load WorkOS user")
      return null
    }
  }

  async listOrganizationUsers(organizationId: string): Promise<WorkosUserSummary[]> {
    const results: WorkosUserSummary[] = []
    let after: string | undefined

    for (;;) {
      const page = await this.workos.userManagement.listUsers({
        organizationId,
        limit: 100,
        ...(after ? { after } : {}),
      })

      for (const user of page.data) {
        results.push({
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
        })
      }

      after = page.listMetadata.after ?? undefined
      if (!after) return results
    }
  }

  async listAppInvitations(): Promise<WorkosAppInvitation[]> {
    const results: WorkosAppInvitation[] = []
    let after: string | undefined

    for (;;) {
      const page = await this.workos.userManagement.listInvitations({
        limit: 100,
        ...(after ? { after } : {}),
      })

      for (const invite of page.data) {
        // App-level invitations only — scoped invites are handled inside
        // their owning workspace, not the global backoffice.
        if (invite.organizationId != null) continue
        results.push({
          id: invite.id,
          email: invite.email,
          state: invite.state,
          acceptedAt: invite.acceptedAt ?? null,
          revokedAt: invite.revokedAt ?? null,
          expiresAt: invite.expiresAt,
          createdAt: invite.createdAt,
          updatedAt: invite.updatedAt,
          acceptedUserId: invite.acceptedUserId ?? null,
        })
      }

      after = page.listMetadata.after ?? undefined
      if (!after) return results
    }
  }

  async getOrganization(organizationId: string): Promise<{ id: string; domains: string[] } | null> {
    try {
      const org = await this.workos.organizations.getOrganization(organizationId)
      const domains = org.domains?.map((d) => d.domain).filter(Boolean) ?? []
      return { id: org.id, domains }
    } catch (error) {
      logger.error({ err: error, organizationId }, "Failed to get WorkOS organization")
      return null
    }
  }

  async ensureOrganizationMembership(params: {
    organizationId: string
    userId: string
    roleSlug: string
  }): Promise<void> {
    try {
      await this.workos.userManagement.createOrganizationMembership({
        organizationId: params.organizationId,
        userId: params.userId,
        roleSlug: params.roleSlug,
      })
      logger.info(
        { organizationId: params.organizationId, userId: params.userId, roleSlug: params.roleSlug },
        "Created WorkOS organization membership"
      )
    } catch (error) {
      const code = getWorkosErrorCode(error)
      if (code === "user_already_organization_member") {
        // Upgrade role if needed (e.g., member promoted to admin in Threa).
        // Only upgrades to "admin" — never downgrades, so acceptShadow("member")
        // won't demote an existing admin.
        if (params.roleSlug === "admin") {
          try {
            const memberships = await this.workos.userManagement.listOrganizationMemberships({
              organizationId: params.organizationId,
              userId: params.userId,
            })
            const existing = memberships.data[0]
            if (existing && existing.role?.slug !== params.roleSlug) {
              await this.workos.userManagement.updateOrganizationMembership(existing.id, {
                roleSlug: params.roleSlug,
              })
              logger.info(
                { organizationId: params.organizationId, userId: params.userId, roleSlug: params.roleSlug },
                "Upgraded WorkOS organization membership role"
              )
            }
          } catch (upgradeError) {
            logger.warn(
              { err: upgradeError, organizationId: params.organizationId, userId: params.userId },
              "Failed to upgrade WorkOS org membership role (best-effort)"
            )
          }
        }
        return
      }
      throw error
    }
  }

  async changeOrganizationMembershipRole(params: {
    organizationMembershipId: string
    roleSlug: string
  }): Promise<void> {
    await this.workos.userManagement.updateOrganizationMembership(params.organizationMembershipId, {
      roleSlug: params.roleSlug,
    })
    logger.info(
      { organizationMembershipId: params.organizationMembershipId, roleSlug: params.roleSlug },
      "Changed WorkOS organization membership role"
    )
  }

  async removeOrganizationMembership(organizationMembershipId: string): Promise<void> {
    await this.workos.userManagement.deleteOrganizationMembership(organizationMembershipId)
    logger.info({ organizationMembershipId }, "Removed WorkOS organization membership")
  }

  async getWidgetToken(params: { organizationId: string; userId: string; scopes: string[] }): Promise<string> {
    const token = await this.workos.widgets.getToken({
      organizationId: params.organizationId,
      userId: params.userId,
      scopes: params.scopes as WidgetScope[],
    })
    return token
  }

  async listMirrorEvents(params: {
    after?: string
    limit?: number
  }): Promise<{ data: WorkosMembershipEvent[]; after: string | null }> {
    const page = await this.workos.events.listEvents({
      events: [...WORKOS_MIRROR_EVENT_TYPES],
      ...(params.after ? { after: params.after } : {}),
      ...(params.limit ? { limit: params.limit } : {}),
    })

    const data: WorkosMembershipEvent[] = []
    for (const raw of page.data) {
      const decoded = decodeMembershipEvent(raw)
      if (decoded) data.push(decoded)
    }
    return { data, after: page.listMetadata.after ?? null }
  }

  async listEvents(params: {
    events: EventName[]
    after?: string
    limit?: number
  }): Promise<{ data: Event[]; after: string | null }> {
    const page = await this.workos.events.listEvents({
      events: params.events,
      ...(params.after ? { after: params.after } : {}),
      ...(params.limit ? { limit: params.limit } : {}),
    })
    return { data: page.data, after: page.listMetadata.after ?? null }
  }

  async listOrganizationMemberships(organizationId: string): Promise<WorkosOrganizationMembership[]> {
    const results: WorkosOrganizationMembership[] = []
    let after: string | undefined

    for (;;) {
      const page = await this.workos.userManagement.listOrganizationMemberships({
        organizationId,
        limit: 100,
        ...(after ? { after } : {}),
      })

      for (const m of page.data) {
        results.push(toMirrorMembership(m))
      }

      after = page.listMetadata.after ?? undefined
      if (!after) return results
    }
  }
}

interface MembershipEventLike {
  id: string
  event: string
  createdAt: string
  data: unknown
}

function decodeMembershipEvent(raw: unknown): WorkosMembershipEvent | null {
  if (!raw || typeof raw !== "object") return null
  const candidate = raw as MembershipEventLike
  if (typeof candidate.id !== "string" || typeof candidate.event !== "string") return null
  if (!isMirrorEventType(candidate.event)) return null
  const membership = parseMembershipPayload(candidate.data)
  if (!membership) return null
  return {
    id: candidate.id,
    type: candidate.event,
    createdAt: new Date(candidate.createdAt),
    membership,
  }
}

function isMirrorEventType(event: string): event is WorkosMirrorEventType {
  return (WORKOS_MIRROR_EVENT_TYPES as readonly string[]).includes(event)
}

interface MembershipPayloadLike {
  id?: unknown
  organizationId?: unknown
  userId?: unknown
  status?: unknown
  updatedAt?: unknown
  role?: { slug?: unknown }
  roles?: Array<{ slug?: unknown }>
}

function parseMembershipPayload(data: unknown): WorkosOrganizationMembership | null {
  if (!data || typeof data !== "object") return null
  const m = data as MembershipPayloadLike
  if (typeof m.id !== "string" || typeof m.organizationId !== "string" || typeof m.userId !== "string") {
    return null
  }
  if (!isWorkosMembershipStatus(m.status)) {
    return null
  }
  return {
    id: m.id,
    organizationId: m.organizationId,
    userId: m.userId,
    status: m.status,
    roleSlugs: extractRoleSlugs(m),
    updatedAt: typeof m.updatedAt === "string" ? new Date(m.updatedAt) : new Date(),
  }
}

function extractRoleSlugs(m: MembershipPayloadLike): string[] {
  const slugs: string[] = []
  if (Array.isArray(m.roles)) {
    for (const r of m.roles) {
      if (r && typeof r.slug === "string") slugs.push(r.slug)
    }
  }
  if (slugs.length === 0 && m.role && typeof m.role.slug === "string") {
    slugs.push(m.role.slug)
  }
  return slugs
}

function toMirrorMembership(m: {
  id: string
  organizationId: string
  userId: string
  status: WorkosMembershipStatus
  updatedAt: string
  role: { slug: string }
  roles?: Array<{ slug: string }>
}): WorkosOrganizationMembership {
  return {
    id: m.id,
    organizationId: m.organizationId,
    userId: m.userId,
    status: m.status,
    roleSlugs: m.roles && m.roles.length > 0 ? m.roles.map((r) => r.slug) : [m.role.slug],
    updatedAt: new Date(m.updatedAt),
  }
}
