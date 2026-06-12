import { logger, INTERNAL_API_KEY_HEADER, type WorkosMembershipStatus } from "@threa/backend-common"
import type { RegionConfig } from "../config"

const REGIONAL_REQUEST_TIMEOUT_MS = 15_000

export class RegionalClient {
  constructor(
    private regions: Record<string, RegionConfig>,
    private internalApiKey: string
  ) {}

  private getRegionUrl(region: string): string {
    const config = this.regions[region]
    if (!config) {
      throw new Error(`Unknown region: ${region}`)
    }
    return config.internalUrl
  }

  async createWorkspace(
    region: string,
    data: {
      id: string
      name: string
      slug: string
      ownerWorkosUserId: string
      ownerEmail: string
      ownerName: string
    }
  ): Promise<{ workspace: unknown }> {
    const url = `${this.getRegionUrl(region)}/internal/workspaces`
    let res: Response
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [INTERNAL_API_KEY_HEADER]: this.internalApiKey,
        },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(REGIONAL_REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      logger.error({ err, region, url }, "Regional workspace creation request failed")
      throw err
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      logger.error({ region, status: res.status, body }, "Regional workspace creation failed")
      throw new Error(`Regional backend returned ${res.status}: ${body}`)
    }

    return res.json()
  }

  async acceptInvitation(
    region: string,
    invitationId: string,
    data: { workosUserId: string; email: string; name: string }
  ): Promise<{ workspaceId: string }> {
    const url = `${this.getRegionUrl(region)}/internal/invitations/${invitationId}/accept`
    let res: Response
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [INTERNAL_API_KEY_HEADER]: this.internalApiKey,
        },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(REGIONAL_REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      logger.error({ err, region, url, invitationId }, "Regional invitation acceptance request failed")
      throw err
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      logger.error({ region, invitationId, status: res.status, body }, "Regional invitation acceptance failed")
      throw new Error(`Regional backend returned ${res.status}: ${body}`)
    }

    return res.json()
  }

  /**
   * Push a membership upsert to the regional `workspace_user_permissions`
   * mirror used by the API-key clamp path. Body matches the regional
   * `POST /internal/authz/memberships` discriminated-union schema.
   */
  async syncWorkspaceMembership(
    region: string,
    data: {
      workspaceId: string
      workosUserId: string
      roleSlugs: string[]
      status: WorkosMembershipStatus
      lastEventAt: Date
    }
  ): Promise<void> {
    await this.postToAuthzMemberships(region, "sync", {
      kind: "upsert",
      workspaceId: data.workspaceId,
      workosUserId: data.workosUserId,
      roleSlugs: data.roleSlugs,
      status: data.status,
      lastEventAt: data.lastEventAt.toISOString(),
    })
  }

  /**
   * Push a membership removal to the regional `workspace_user_permissions`
   * mirror. Body matches the regional `POST /internal/authz/memberships`
   * discriminated-union schema (`kind: "remove"`).
   */
  async removeWorkspaceMembership(
    region: string,
    data: { workspaceId: string; workosUserId: string; eventCreatedAt: Date }
  ): Promise<void> {
    await this.postToAuthzMemberships(region, "removal", {
      kind: "remove",
      workspaceId: data.workspaceId,
      workosUserId: data.workosUserId,
      eventCreatedAt: data.eventCreatedAt.toISOString(),
    })
  }

  /**
   * Shared transport for `POST /internal/authz/memberships`. The two callers
   * differ only in the discriminated-union body and the log verb, so headers,
   * timeout, error normalization, and HTTP plumbing live here once.
   */
  private async postToAuthzMemberships(
    region: string,
    op: "sync" | "removal",
    body: Record<string, unknown>
  ): Promise<void> {
    const url = `${this.getRegionUrl(region)}/internal/authz/memberships`
    let res: Response
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [INTERNAL_API_KEY_HEADER]: this.internalApiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REGIONAL_REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      logger.error({ err, region, url }, `Regional authz membership ${op} request failed`)
      throw err
    }

    if (!res.ok) {
      const responseBody = await res.text().catch(() => "")
      logger.error({ region, status: res.status, body: responseBody }, `Regional authz membership ${op} failed`)
      throw new Error(`Regional backend returned ${res.status}: ${responseBody}`)
    }
  }

  /**
   * Push one user's resolved feature-flag snapshot to the regional backend.
   * Full-snapshot semantics keep the call idempotent and replay-safe — the
   * region replaces the user's rows wholesale.
   */
  async syncUserFeatureFlags(
    region: string,
    data: { workspaceId: string; workosUserId: string; flags: Record<string, boolean> }
  ): Promise<void> {
    const url = `${this.getRegionUrl(region)}/internal/feature-flags`
    let res: Response
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [INTERNAL_API_KEY_HEADER]: this.internalApiKey,
        },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(REGIONAL_REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      logger.error({ err, region, url }, "Regional feature flag sync request failed")
      throw err
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      logger.error({ region, status: res.status, body }, "Regional feature flag sync failed")
      throw new Error(`Regional backend returned ${res.status}: ${body}`)
    }
  }

  /**
   * Forward a link-invitation claim from CP to the regional backend that owns
   * the row. Regional performs the atomic claim (INV-20). On 4xx, surfaces the
   * upstream error code so CP can map it to an HTTP status without parsing.
   */
  async claimInvitationLink(
    region: string,
    data: { token: string; email: string }
  ): Promise<{ ok: true; alreadyMember?: { workspaceId: string } }> {
    const url = `${this.getRegionUrl(region)}/internal/invitations/claim-link`
    let res: Response
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [INTERNAL_API_KEY_HEADER]: this.internalApiKey,
        },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(REGIONAL_REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      logger.error({ err, region, url }, "Regional invitation link claim request failed")
      throw err
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      logger.error({ region, status: res.status, body }, "Regional invitation link claim failed")
      throw new RegionalClaimError(res.status, body)
    }

    return res.json()
  }
}

export class RegionalClaimError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string
  ) {
    super(`Regional backend returned ${status}: ${body}`)
    this.name = "RegionalClaimError"
  }

  /** Try to parse the upstream `code` from the JSON body. */
  upstreamCode(): string | null {
    try {
      const parsed = JSON.parse(this.body) as { code?: string }
      return typeof parsed.code === "string" ? parsed.code : null
    } catch {
      return null
    }
  }
}
