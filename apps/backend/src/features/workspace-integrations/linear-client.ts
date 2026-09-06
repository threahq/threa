/**
 * Linear GraphQL client wrapper. Handles token refresh (single 401-retry) and
 * per-response rate-limit capture. Hand-rolled rather than `@linear/sdk` so each
 * query stays tight instead of over-fetching from the auto-gen.
 *
 * Docs:
 * - https://linear.app/developers/graphql
 * - https://linear.app/developers/rate-limiting
 */

import type { LinearRateLimit } from "@threahq/types"
import { logger } from "../../lib/logger"
import type { WorkspaceIntegrationService } from "./service"
import type { WorkspaceIntegrationRecord } from "./repository"

const log = logger.child({ module: "linear-client" })

const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql"

// Exposed so the callback flow (which runs before any integration record exists)
// can share the endpoint constant. Feature-internal; not on the index.ts surface.
export { LINEAR_GRAPHQL_ENDPOINT as LinearGraphQLEndpoint }

export interface LinearIntegrationCredentials {
  accessToken: string
  refreshToken: string | null
  tokenType: string
  tokenExpiresAt: string
  scope: string
  actor: "app"
}

export interface LinearIntegrationMetadata extends Record<string, unknown> {
  organizationId: string | null
  organizationName: string | null
  organizationUrlKey: string | null
  authorizedUser: {
    id: string
    name: string
    email: string | null
  } | null
  rateLimit: LinearRateLimit
}

interface LinearGraphQLError {
  message: string
  extensions?: { code?: string; userPresentableMessage?: string }
}

interface LinearGraphQLResponse<T> {
  data?: T
  errors?: LinearGraphQLError[]
}

export class LinearApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
    public readonly errors: LinearGraphQLError[] = []
  ) {
    super(message)
    this.name = "LinearApiError"
  }

  static isUnauthorized(error: unknown): boolean {
    return error instanceof LinearApiError && (error.status === 401 || error.code === "AUTHENTICATION_ERROR")
  }

  static isNotFound(error: unknown): boolean {
    return error instanceof LinearApiError && (error.status === 404 || error.code === "ENTITY_NOT_FOUND")
  }

  static isRateLimited(error: unknown): boolean {
    return error instanceof LinearApiError && (error.status === 429 || error.code === "RATELIMITED")
  }
}

export class LinearClient {
  constructor(
    private service: WorkspaceIntegrationService,
    private workspaceId: string,
    private record: WorkspaceIntegrationRecord,
    private credentials: LinearIntegrationCredentials,
    private metadata: LinearIntegrationMetadata,
    private fetchImpl: typeof fetch = fetch
  ) {}

  get organization(): LinearIntegrationMetadata {
    return this.metadata
  }

  async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    return this.requestInternal<T>(query, variables, false)
  }

  private async requestInternal<T>(query: string, variables: Record<string, unknown>, retried: boolean): Promise<T> {
    const response = await this.fetchImpl(LINEAR_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.credentials.accessToken}`,
      },
      body: JSON.stringify({ query, variables }),
    })

    await this.captureRateLimit(response.headers)

    if (response.status === 401 && !retried) {
      const refreshed = await this.service.refreshLinearCredentialsForPreview(this.workspaceId, this.record)
      if (!refreshed) {
        throw new LinearApiError("Linear authentication failed", 401, "AUTHENTICATION_ERROR")
      }
      this.record = refreshed.record
      this.credentials = refreshed.credentials
      this.metadata = refreshed.metadata
      return this.requestInternal<T>(query, variables, true)
    }

    const body = (await response.json().catch(() => null)) as LinearGraphQLResponse<T> | null

    if (!response.ok || !body || body.errors?.length) {
      const code = body?.errors?.[0]?.extensions?.code ?? null
      const message = body?.errors?.[0]?.message ?? `Linear request failed with status ${response.status}`
      throw new LinearApiError(message, response.status, code, body?.errors ?? [])
    }

    if (!body.data) {
      throw new LinearApiError("Linear returned no data", response.status, null)
    }

    return body.data
  }

  // Best-effort telemetry: a persistence failure here must never propagate, or it
  // would replace the real request error and (on a 401) skip the refresh retry.
  private async captureRateLimit(headers: Headers): Promise<void> {
    try {
      await this.captureRateLimitInternal(headers)
    } catch (error) {
      log.warn({ err: error, workspaceId: this.workspaceId }, "Linear rate-limit capture failed; continuing")
    }
  }

  private async captureRateLimitInternal(headers: Headers): Promise<void> {
    const requestsRemaining = parseIntegerHeader(headers.get("x-ratelimit-requests-remaining"))
    const requestsResetSeconds = parseIntegerHeader(headers.get("x-ratelimit-requests-reset"))
    const complexityRemaining = parseIntegerHeader(headers.get("x-ratelimit-complexity-remaining"))
    const complexityResetSeconds = parseIntegerHeader(headers.get("x-ratelimit-complexity-reset"))

    // Responses without rate-limit headers parse to all-null; persisting that would
    // wipe a previously-captured near-limit state and neuter `isNearLinearRateLimit`.
    if (
      requestsRemaining === null &&
      requestsResetSeconds === null &&
      complexityRemaining === null &&
      complexityResetSeconds === null
    ) {
      return
    }

    // Linear documents both second-precision and ms-precision reset timestamps across
    // its pages; treat any reset value > 10^12 as already-in-ms.
    const requestsResetAt = secondsOrMsToIso(requestsResetSeconds)
    const complexityResetAt = secondsOrMsToIso(complexityResetSeconds)

    if (
      requestsRemaining === this.metadata.rateLimit.requestsRemaining &&
      requestsResetAt === this.metadata.rateLimit.requestsResetAt &&
      complexityRemaining === this.metadata.rateLimit.complexityRemaining &&
      complexityResetAt === this.metadata.rateLimit.complexityResetAt
    ) {
      return
    }

    const result = await this.service.updateLinearRateLimitMetadata(
      this.workspaceId,
      this.metadata,
      this.record.installationId,
      {
        requestsRemaining,
        requestsResetAt,
        complexityRemaining,
        complexityResetAt,
      },
      this.record.version
    )
    this.metadata = result.metadata
    // Advance the cached version on a win so this reused client's next capture
    // CASes on the fresh generation instead of colliding with its own prior write.
    if (result.version !== null) this.record = { ...this.record, version: result.version }
  }
}

function parseIntegerHeader(value: string | null): number | null {
  if (value === null) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function secondsOrMsToIso(value: number | null): string | null {
  if (value === null) return null
  const ms = value > 10 ** 12 ? value : value * 1000
  return new Date(ms).toISOString()
}
