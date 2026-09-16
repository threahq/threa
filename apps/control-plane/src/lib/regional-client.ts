import { logger, INTERNAL_API_KEY_HEADER, type WorkosMembershipStatus } from "@threahq/backend-common"
import {
  aiSpendingOverviewSchema,
  aiSpendingPolicyUpdateResultSchema,
  type AISpendingInternalPolicyUpdate,
  type AISpendingOverview,
  type AISpendingPolicyUpdateResult,
  type FeatureFlagScope,
} from "@threahq/types"
import type { z } from "zod/v4"
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
      timezone?: string
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
      throw new RegionalInvitationError(res.status, body)
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
    await this.postInternal(
      region,
      "/internal/authz/memberships",
      {
        kind: "upsert",
        workspaceId: data.workspaceId,
        workosUserId: data.workosUserId,
        roleSlugs: data.roleSlugs,
        status: data.status,
        lastEventAt: data.lastEventAt.toISOString(),
      },
      "Regional authz membership sync"
    )
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
    await this.postInternal(
      region,
      "/internal/authz/memberships",
      {
        kind: "remove",
        workspaceId: data.workspaceId,
        workosUserId: data.workosUserId,
        eventCreatedAt: data.eventCreatedAt.toISOString(),
      },
      "Regional authz membership removal"
    )
  }

  /**
   * Shared transport for fire-and-forget internal POSTs (no response body
   * needed). Headers, timeout, error normalization, and HTTP plumbing live
   * here once; callers differ only in path, body, and the log label.
   */
  private async postInternal(
    region: string,
    path: string,
    body: Record<string, unknown>,
    logContext: string
  ): Promise<void> {
    const res = await this.fetchInternal(region, "POST", path, body, logContext)
    if (!res.ok) {
      const responseBody = await res.text().catch(() => "")
      logger.error({ region, status: res.status, body: responseBody }, `${logContext} failed`)
      throw new Error(`Regional backend returned ${res.status}: ${responseBody}`)
    }
  }

  private async fetchInternal(
    region: string,
    method: "GET" | "POST" | "PUT",
    path: string,
    body: Record<string, unknown> | undefined,
    logContext: string
  ): Promise<Response> {
    const url = `${this.getRegionUrl(region)}${path}`
    try {
      return await fetch(url, {
        method,
        headers: {
          ...(body !== undefined && { "Content-Type": "application/json" }),
          [INTERNAL_API_KEY_HEADER]: this.internalApiKey,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REGIONAL_REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      logger.error({ err, region, url }, `${logContext} request failed`)
      throw err
    }
  }

  /**
   * Internal command whose acknowledgement carries data. A non-2xx response
   * throws `RegionalResponseError` with the upstream status and code; a 2xx
   * body that does not match `schema` throws, since it acknowledges nothing.
   */
  private async requestInternalJson<T>(
    region: string,
    method: "GET" | "PUT",
    path: string,
    body: Record<string, unknown> | undefined,
    schema: z.ZodType<T>,
    logContext: string
  ): Promise<T> {
    const res = await this.fetchInternal(region, method, path, body, logContext)
    const text = await res.text()
    if (!res.ok) {
      logger.warn({ region, status: res.status, body: text }, `${logContext} rejected`)
      throw new RegionalResponseError(res.status, text)
    }
    const parsed = schema.safeParse(JSON.parse(text))
    if (!parsed.success) {
      logger.error({ region, issues: parsed.error.issues }, `${logContext} returned an unexpected body`)
      throw new Error(`${logContext} returned an unexpected body`)
    }
    return parsed.data
  }

  /** The owning region's authoritative AI spending policy and current period. */
  async getAISpending(region: string, workspaceId: string): Promise<AISpendingOverview> {
    return this.requestInternalJson(
      region,
      "GET",
      `/internal/ai-spending/workspaces/${encodeURIComponent(workspaceId)}`,
      undefined,
      aiSpendingOverviewSchema,
      "Regional AI spending read"
    )
  }

  /** Versioned policy command; resolves only with the policy the region acknowledged storing. */
  async setAISpendingPolicy(
    region: string,
    workspaceId: string,
    command: AISpendingInternalPolicyUpdate
  ): Promise<AISpendingPolicyUpdateResult> {
    return this.requestInternalJson(
      region,
      "PUT",
      `/internal/ai-spending/workspaces/${encodeURIComponent(workspaceId)}`,
      command,
      aiSpendingPolicyUpdateResultSchema,
      "Regional AI spending policy update"
    )
  }

  /**
   * Push one subject's raw feature-flag overrides to the regional backend. The
   * region stores each layer separately and resolves at read. Full-snapshot
   * semantics keep the call idempotent and replay-safe — the region replaces
   * that subject's rows wholesale.
   */
  async syncFeatureFlags(
    region: string,
    data: { workspaceId: string; subjectType: FeatureFlagScope; subjectId: string; overrides: Record<string, string> }
  ): Promise<void> {
    await this.postInternal(region, "/internal/feature-flags", data, "Regional feature flag sync")
  }

  /**
   * Push one workspace user's platform-admin grant to the regional
   * `platform_admin_access` mirror. Snapshot semantics keep the call
   * idempotent and replay-safe — a grant upserts the row, a revoke deletes it.
   */
  async syncPlatformAdminAccess(
    region: string,
    data: { workspaceId: string; workosUserId: string; isPlatformAdmin: boolean }
  ): Promise<void> {
    await this.postInternal(region, "/internal/platform-admin", data, "Regional platform-admin sync")
  }

  /**
   * Forward one verified GitHub webhook delivery to a region's internal
   * ingestion endpoint. The webhook is an invalidation signal — the region
   * derives canonical URLs from `payload` and force-refreshes matching link
   * previews. Idempotency at the region keys on `deliveryGuid`.
   */
  async dispatchGithubWebhook(
    region: string,
    data: {
      deliveryGuid: string
      eventType: string
      action: string | null
      installationId: string | null
      repositoryFullName: string | null
      payload: Record<string, unknown>
    }
  ): Promise<void> {
    await this.postInternal(region, "/internal/github/webhook-events", data, "GitHub webhook dispatch")
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
      throw new RegionalInvitationError(res.status, body)
    }

    return res.json()
  }
}

export class RegionalInvitationError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string
  ) {
    super(`Regional backend returned ${status}: ${body}`)
    this.name = "RegionalInvitationError"
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

/** A regional internal endpoint answered with a non-2xx status; `code` and `error` come from its HttpError body. */
export class RegionalResponseError extends Error {
  readonly code: string | null
  readonly upstreamMessage: string | null

  constructor(
    public readonly status: number,
    body: string
  ) {
    super(`Regional backend returned ${status}`)
    this.name = "RegionalResponseError"
    let parsed: { code?: unknown; error?: unknown } = {}
    try {
      parsed = JSON.parse(body) as typeof parsed
    } catch {
      // Non-JSON bodies (proxies, crashes) carry no structured code.
    }
    this.code = typeof parsed?.code === "string" ? parsed.code : null
    this.upstreamMessage = typeof parsed?.error === "string" ? parsed.error : null
  }
}
