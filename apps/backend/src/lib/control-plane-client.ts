import { logger } from "./logger"
import { HttpError, INTERNAL_API_KEY_HEADER } from "@threa/backend-common"
import type { InvitationStatus, WorkspaceInvitableRole, WorkspaceRoleSlug } from "@threa/types"

const REQUEST_TIMEOUT_MS = 10_000

// CP's shared error middleware always responds with `{ error, code? }` JSON.
// Translate that into an HttpError carrying the CP's status + code so the
// regional error middleware surfaces the same code (OWNER_ACTION, LAST_OWNER,
// SELF_DEMOTE, FORBIDDEN, ...) to the frontend instead of a generic 500.
function toControlPlaneHttpError(status: number, bodyText: string, fallbackMessage: string): HttpError {
  let message = fallbackMessage
  let code: string | undefined
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText) as { error?: unknown; code?: unknown }
      if (typeof parsed.error === "string" && parsed.error.length > 0) message = parsed.error
      if (typeof parsed.code === "string" && parsed.code.length > 0) code = parsed.code
    } catch {
      // Non-JSON body — fall through with fallback message and no code.
    }
  }
  return new HttpError(message, { status, code })
}

export class ControlPlaneClient {
  constructor(
    private baseUrl: string,
    private internalApiKey: string
  ) {}

  async createInvitationShadow(params: {
    id: string
    workspaceId: string
    region: string
    expiresAt: Date | null
    maxUses?: number | null
    useCount?: number
    revision?: number
    status?: InvitationStatus
    /** "email" → email-bound at creation; "link" → email-null until claim. */
    kind: "email" | "link"
    /** Required for kind="email", null for kind="link". */
    email: string | null
    /** Required for kind="link", null for kind="email". */
    tokenHash: string | null
    roleSlug: WorkspaceInvitableRole
    inviterWorkosUserId?: string
  }): Promise<void> {
    const url = `${this.baseUrl}/internal/invitation-shadows`
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_API_KEY_HEADER]: this.internalApiKey,
      },
      body: JSON.stringify({
        ...params,
        expiresAt: params.expiresAt?.toISOString() ?? null,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      logger.error({ status: res.status, body }, "Failed to create invitation shadow")
      throw new Error(`Control-plane returned ${res.status}: ${body}`)
    }
  }

  /**
   * Notify CP that a previously unclaimed link invite has been bound to an
   * email. CP mirrors the email onto the shadow row and triggers the WorkOS
   * invitation so the recipient gets a verification email.
   */
  async notifyInvitationLinkClaimed(params: {
    parentInvitationId: string
    childInvitationId?: string
    email: string
    expiresAt?: Date | null
    maxUses?: number | null
    useCount?: number
    revision?: number
    inviterWorkosUserId?: string
  }): Promise<void> {
    const url = `${this.baseUrl}/internal/invitation-shadows/${params.parentInvitationId}/claim`
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_API_KEY_HEADER]: this.internalApiKey,
      },
      body: JSON.stringify({
        ...(params.childInvitationId ? { childInvitationId: params.childInvitationId } : {}),
        email: params.email,
        ...(params.expiresAt !== undefined ? { expiresAt: params.expiresAt?.toISOString() ?? null } : {}),
        ...(params.maxUses !== undefined ? { maxUses: params.maxUses } : {}),
        ...(params.useCount !== undefined ? { useCount: params.useCount } : {}),
        ...(params.revision !== undefined ? { revision: params.revision } : {}),
        ...(params.inviterWorkosUserId ? { inviterWorkosUserId: params.inviterWorkosUserId } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      logger.error(
        {
          parentInvitationId: params.parentInvitationId,
          childInvitationId: params.childInvitationId,
          status: res.status,
          body,
        },
        "Failed to notify invitation link claim"
      )
      throw new Error(`Control-plane returned ${res.status}: ${body}`)
    }
  }

  /**
   * Ask the control plane (source of truth for membership) whether a WorkOS
   * user belongs to a workspace. Used by the regional auth path to self-heal a
   * missing `users` row when this region's DB has drifted behind the control
   * plane. Throws on any non-2xx / transport failure so callers fail closed.
   */
  async getWorkspaceMembership(params: { workspaceId: string; workosUserId: string }): Promise<{ member: boolean }> {
    const url = `${this.baseUrl}/internal/workspaces/${encodeURIComponent(params.workspaceId)}/members/${encodeURIComponent(params.workosUserId)}`
    const res = await fetch(url, {
      method: "GET",
      headers: {
        [INTERNAL_API_KEY_HEADER]: this.internalApiKey,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      logger.error(
        { workspaceId: params.workspaceId, workosUserId: params.workosUserId, status: res.status, body },
        "Failed to confirm workspace membership with control plane"
      )
      throw new Error(`Control-plane returned ${res.status}: ${body}`)
    }

    const data = (await res.json()) as { member?: unknown }
    return { member: data.member === true }
  }

  async changeWorkspaceMemberRole(params: {
    workspaceId: string
    targetUserId: string
    actorWorkosUserId: string
    roleSlug: WorkspaceRoleSlug
  }): Promise<void> {
    const url = `${this.baseUrl}/internal/workspaces/${params.workspaceId}/members/${params.targetUserId}/role`
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_API_KEY_HEADER]: this.internalApiKey,
      },
      body: JSON.stringify({
        actor: { workosUserId: params.actorWorkosUserId },
        roleSlug: params.roleSlug,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      logger.error(
        { workspaceId: params.workspaceId, targetUserId: params.targetUserId, status: res.status, body },
        "Failed to change workspace member role"
      )
      throw toControlPlaneHttpError(res.status, body, "Failed to change workspace member role")
    }
  }

  async removeWorkspaceMember(params: {
    workspaceId: string
    targetUserId: string
    actorWorkosUserId: string
  }): Promise<void> {
    const url = `${this.baseUrl}/internal/workspaces/${params.workspaceId}/members/${params.targetUserId}`
    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_API_KEY_HEADER]: this.internalApiKey,
      },
      body: JSON.stringify({
        actor: { workosUserId: params.actorWorkosUserId },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      logger.error(
        { workspaceId: params.workspaceId, targetUserId: params.targetUserId, status: res.status, body },
        "Failed to remove workspace member"
      )
      throw toControlPlaneHttpError(res.status, body, "Failed to remove workspace member")
    }
  }

  /**
   * Register (upsert) a webhook routing entry so CP can fan a provider webhook
   * for `externalId` (e.g. a GitHub installation id) to this region. Idempotent
   * on (provider, externalId, workspaceId). Throws on any non-2xx / transport
   * failure so the caller fails loudly (INV-11).
   */
  async registerIntegrationRoute(params: {
    provider: string
    externalId: string
    region: string
    workspaceId: string
  }): Promise<void> {
    const url = `${this.baseUrl}/internal/integration-routes`
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_API_KEY_HEADER]: this.internalApiKey,
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      logger.error(
        { provider: params.provider, externalId: params.externalId, status: res.status, body },
        "Failed to register integration route"
      )
      throw new Error(`Control-plane returned ${res.status}: ${body}`)
    }
  }

  async unregisterIntegrationRoute(params: {
    provider: string
    externalId: string
    workspaceId: string
  }): Promise<void> {
    const url = `${this.baseUrl}/internal/integration-routes`
    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_API_KEY_HEADER]: this.internalApiKey,
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      logger.error(
        { provider: params.provider, externalId: params.externalId, status: res.status, body },
        "Failed to unregister integration route"
      )
      throw new Error(`Control-plane returned ${res.status}: ${body}`)
    }
  }

  async acknowledgeInvitationAccepted(params: {
    invitationId: string
    workspaceId: string
    email: string
    workosUserId: string
    parentInvitationId?: string
    expiresAt?: Date | null
    maxUses?: number | null
    useCount?: number
    revision?: number
    status?: InvitationStatus
  }): Promise<void> {
    const url = `${this.baseUrl}/internal/invitation-shadows/${params.invitationId}/accepted`
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_API_KEY_HEADER]: this.internalApiKey,
      },
      body: JSON.stringify({
        workspaceId: params.workspaceId,
        email: params.email,
        workosUserId: params.workosUserId,
        ...(params.parentInvitationId ? { parentInvitationId: params.parentInvitationId } : {}),
        ...(params.expiresAt !== undefined ? { expiresAt: params.expiresAt?.toISOString() ?? null } : {}),
        ...(params.maxUses !== undefined ? { maxUses: params.maxUses } : {}),
        ...(params.useCount !== undefined ? { useCount: params.useCount } : {}),
        ...(params.revision !== undefined ? { revision: params.revision } : {}),
        ...(params.status !== undefined ? { status: params.status } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      logger.error(
        { invitationId: params.invitationId, status: res.status, body },
        "Failed to acknowledge invitation acceptance"
      )
      throw new Error(`Control-plane returned ${res.status}: ${body}`)
    }
  }

  async updateInvitationLinkShadow(params: {
    id: string
    expiresAt: Date | null
    maxUses: number | null
    useCount: number
    revision: number
    status: InvitationStatus
  }): Promise<void> {
    const url = `${this.baseUrl}/internal/invitation-shadows/${params.id}`
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_API_KEY_HEADER]: this.internalApiKey,
      },
      body: JSON.stringify({
        expiresAt: params.expiresAt?.toISOString() ?? null,
        maxUses: params.maxUses,
        useCount: params.useCount,
        revision: params.revision,
        status: params.status,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      logger.error({ id: params.id, status: res.status, body }, "Failed to update invitation link shadow")
      throw new Error(`Control-plane returned ${res.status}: ${body}`)
    }
  }

  async revokeInvitationShadow(id: string): Promise<void> {
    const url = `${this.baseUrl}/internal/invitation-shadows/${id}`
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_API_KEY_HEADER]: this.internalApiKey,
      },
      body: JSON.stringify({ status: "revoked" }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      logger.error({ id, status: res.status, body }, "Failed to revoke invitation shadow")
      throw new Error(`Control-plane returned ${res.status}: ${body}`)
    }
  }
}
