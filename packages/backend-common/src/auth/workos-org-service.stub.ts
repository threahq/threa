import { ulid } from "ulid"
import type { Event, EventName } from "@workos-inc/node"
import { logger } from "../logger"
import type {
  WorkosAppInvitation,
  WorkosMembershipEvent,
  WorkosOrgService,
  WorkosOrganizationMembership,
  WorkosUserSummary,
} from "./workos-org-service"

export class StubWorkosOrgService implements WorkosOrgService {
  private orgsByExternalId = new Map<string, string>()
  private appInvitations: WorkosAppInvitation[] = []
  /** Test helper: let callers pre-populate a user lookup table. */
  public users = new Map<string, WorkosUserSummary>()
  /**
   * Test helper: in-memory stack of mirror events. Tests push into this with
   * `pushMirrorEvent` and the poller drains via `listMirrorEvents`.
   */
  private mirrorEvents: WorkosMembershipEvent[] = []
  /**
   * Test helper: in-memory stack of raw WorkOS events for the `auth_log`
   * consumer. Tests push with `pushEvent` and the poller drains via
   * `listEvents`.
   */
  private rawEvents: Event[] = []
  /**
   * Test helper: per-org membership listing returned by backfill. Tests seed
   * it via `setOrganizationMemberships`.
   */
  private membershipsByOrg = new Map<string, WorkosOrganizationMembership[]>()
  /**
   * Test helper: records every `sendInvitation` call by the returned id so
   * tests can assert the exact role/org/email that landed at WorkOS.
   */
  public sentInvitations = new Map<
    string,
    { organizationId?: string; email: string; inviterUserId: string; roleSlug?: string }
  >()

  async createOrganization(params: { name: string; externalId: string }): Promise<{ id: string }> {
    const id = `org_stub_${ulid()}`
    this.orgsByExternalId.set(params.externalId, id)
    logger.info({ orgId: id, name: params.name, externalId: params.externalId }, "Stub: Created organization")
    return { id }
  }

  async getOrganizationByExternalId(externalId: string): Promise<{ id: string } | null> {
    const id = this.orgsByExternalId.get(externalId)
    return id ? { id } : null
  }

  async hasAcceptedWorkspaceCreationInvitation(_email: string): Promise<boolean> {
    return true
  }

  async sendInvitation(params: {
    organizationId?: string
    email: string
    inviterUserId: string
    roleSlug?: string
  }): Promise<{ id: string; expiresAt: Date }> {
    const id = `inv_stub_${ulid()}`
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
    if (params.organizationId == null) {
      const now = new Date().toISOString()
      this.appInvitations.push({
        id,
        email: params.email,
        state: "pending",
        acceptedAt: null,
        revokedAt: null,
        expiresAt: expiresAt.toISOString(),
        createdAt: now,
        updatedAt: now,
        acceptedUserId: null,
      })
    }
    this.sentInvitations.set(id, {
      ...(params.organizationId ? { organizationId: params.organizationId } : {}),
      email: params.email,
      inviterUserId: params.inviterUserId,
      ...(params.roleSlug ? { roleSlug: params.roleSlug } : {}),
    })
    logger.info(
      { invitationId: id, email: params.email, roleSlug: params.roleSlug },
      "Stub: Sent invitation (no email)"
    )
    return { id, expiresAt }
  }

  async revokeInvitation(invitationId: string): Promise<void> {
    const existing = this.appInvitations.find((i) => i.id === invitationId)
    if (existing) {
      existing.state = "revoked"
      existing.revokedAt = new Date().toISOString()
      existing.updatedAt = existing.revokedAt
    }
    logger.info({ invitationId }, "Stub: Revoked invitation")
  }

  async resendInvitation(invitationId: string): Promise<{ id: string; expiresAt: Date }> {
    const existing = this.appInvitations.find((i) => i.id === invitationId)
    if (!existing) {
      const id = `inv_stub_${ulid()}`
      return { id, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) }
    }
    // Mirror the real service: mark the old as revoked and create a new one.
    existing.state = "revoked"
    existing.revokedAt = new Date().toISOString()
    existing.updatedAt = existing.revokedAt
    const fresh = await this.sendInvitation({ email: existing.email, inviterUserId: "stub" })
    logger.info({ oldInvitationId: invitationId, newInvitationId: fresh.id }, "Stub: Resent invitation")
    return fresh
  }

  async listAppInvitations(): Promise<WorkosAppInvitation[]> {
    return [...this.appInvitations]
  }

  async getUser(workosUserId: string): Promise<WorkosUserSummary | null> {
    return this.users.get(workosUserId) ?? null
  }

  async listOrganizationUsers(organizationId: string): Promise<WorkosUserSummary[]> {
    const memberships = this.membershipsByOrg.get(organizationId) ?? []
    const users: WorkosUserSummary[] = []
    for (const m of memberships) {
      const user = this.users.get(m.userId)
      if (user) users.push(user)
    }
    return users
  }

  async getOrganization(organizationId: string): Promise<{ id: string; domains: string[] } | null> {
    return { id: organizationId, domains: [] }
  }

  async ensureOrganizationMembership(params: {
    organizationId: string
    userId: string
    roleSlug: string
  }): Promise<void> {
    const memberships = this.membershipsByOrg.get(params.organizationId) ?? []
    const existing = memberships.find((m) => m.userId === params.userId)
    if (existing) {
      existing.roleSlugs = [params.roleSlug]
      existing.updatedAt = new Date()
    } else {
      memberships.push({
        id: `om_stub_${ulid()}`,
        organizationId: params.organizationId,
        userId: params.userId,
        status: "active",
        roleSlugs: [params.roleSlug],
        updatedAt: new Date(),
      })
      this.membershipsByOrg.set(params.organizationId, memberships)
    }
    logger.info(
      { organizationId: params.organizationId, userId: params.userId, roleSlug: params.roleSlug },
      "Stub: Ensured organization membership"
    )
  }

  async changeOrganizationMembershipRole(params: {
    organizationMembershipId: string
    roleSlug: string
  }): Promise<void> {
    const found = this.findMembershipById(params.organizationMembershipId)
    if (!found) {
      logger.warn(
        { organizationMembershipId: params.organizationMembershipId },
        "Stub: changeOrganizationMembershipRole called with unknown id"
      )
      return
    }
    found.membership.roleSlugs = [params.roleSlug]
    found.membership.updatedAt = new Date()
    logger.info(
      { organizationMembershipId: params.organizationMembershipId, roleSlug: params.roleSlug },
      "Stub: Changed organization membership role"
    )
  }

  async removeOrganizationMembership(organizationMembershipId: string): Promise<void> {
    const found = this.findMembershipById(organizationMembershipId)
    if (!found) {
      logger.warn({ organizationMembershipId }, "Stub: removeOrganizationMembership called with unknown id")
      return
    }
    found.memberships.splice(found.index, 1)
    if (found.memberships.length === 0) this.membershipsByOrg.delete(found.orgId)
    logger.info({ organizationMembershipId }, "Stub: Removed organization membership")
  }

  private findMembershipById(organizationMembershipId: string): {
    orgId: string
    memberships: WorkosOrganizationMembership[]
    index: number
    membership: WorkosOrganizationMembership
  } | null {
    for (const [orgId, memberships] of this.membershipsByOrg) {
      const index = memberships.findIndex((m) => m.id === organizationMembershipId)
      if (index >= 0) {
        return { orgId, memberships, index, membership: memberships[index]! }
      }
    }
    return null
  }

  async getWidgetToken(_params: { organizationId: string; userId: string; scopes: string[] }): Promise<string> {
    return "stub_widget_token"
  }

  async listMirrorEvents(params: {
    after?: string
    limit?: number
  }): Promise<{ data: WorkosMembershipEvent[]; after: string | null }> {
    const startIdx = params.after ? this.mirrorEvents.findIndex((e) => e.id === params.after) + 1 : 0
    const slice = this.mirrorEvents.slice(startIdx, startIdx + (params.limit ?? 100))
    const next = startIdx + slice.length < this.mirrorEvents.length ? (slice[slice.length - 1]?.id ?? null) : null
    return { data: slice, after: next }
  }

  async listEvents(params: {
    events: EventName[]
    after?: string
    limit?: number
  }): Promise<{ data: Event[]; after: string | null }> {
    const filtered = this.rawEvents.filter((e) => (params.events as readonly string[]).includes(e.event))
    const startIdx = params.after ? filtered.findIndex((e) => e.id === params.after) + 1 : 0
    const slice = filtered.slice(startIdx, startIdx + (params.limit ?? 100))
    const next = startIdx + slice.length < filtered.length ? (slice[slice.length - 1]?.id ?? null) : null
    return { data: slice, after: next }
  }

  async listOrganizationMemberships(organizationId: string): Promise<WorkosOrganizationMembership[]> {
    return [...(this.membershipsByOrg.get(organizationId) ?? [])]
  }

  /** Test helper: append a mirror event to the stub queue. */
  pushMirrorEvent(event: WorkosMembershipEvent): void {
    this.mirrorEvents.push(event)
  }

  /** Test helper: append a raw WorkOS event to the `listEvents` queue. */
  pushEvent(event: Event): void {
    this.rawEvents.push(event)
  }

  /** Test helper: clear all queued raw events. */
  clearEvents(): void {
    this.rawEvents = []
  }

  /** Test helper: replace the membership listing for an organization. */
  setOrganizationMemberships(organizationId: string, memberships: WorkosOrganizationMembership[]): void {
    this.membershipsByOrg.set(organizationId, [...memberships])
  }

  /** Test helper: clear all queued mirror events. */
  clearMirrorEvents(): void {
    this.mirrorEvents = []
  }
}
