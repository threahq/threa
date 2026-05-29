import type { Pool } from "pg"
import { App, Octokit } from "octokit"
import { logger } from "../../lib/logger"
import { HttpError } from "../../lib/errors"
import { workspaceIntegrationId } from "../../lib/id"
import type { GitHubAppConfig, LinearOAuthConfig } from "../../lib/env"
import { UserRepository } from "../workspaces"
import {
  permissionsForRole,
  WORKSPACE_PERMISSION_SCOPES,
  WorkspaceIntegrationProviders,
  WorkspaceIntegrationStatuses,
  type GitHubInstalledRepository,
  type GitHubWorkspaceIntegration,
  type LinearAuthorizedUser,
  type LinearRateLimit,
  type LinearWorkspaceIntegration,
} from "@threa/types"
import {
  decryptJson,
  encryptJson,
  createGithubInstallState,
  createLinearInstallState,
  verifyGithubInstallState,
  verifyLinearInstallState,
} from "./crypto"
import { WorkspaceIntegrationRepository, type WorkspaceIntegrationRecord } from "./repository"
import {
  LinearClient,
  LinearGraphQLEndpoint,
  type LinearIntegrationCredentials,
  type LinearIntegrationMetadata,
} from "./linear-client"
import {
  buildLinearAuthorizationUrl,
  exchangeLinearCode,
  expiresAtFromNow,
  refreshLinearToken,
  revokeLinearToken,
  type LinearOAuthTokenResponse,
} from "./linear-oauth"

const log = logger.child({ module: "workspace-integrations" })

const GITHUB_RATE_LIMIT_NEAR_THRESHOLD = 100
const GITHUB_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000
const LINEAR_REQUESTS_NEAR_THRESHOLD = 100
const LINEAR_COMPLEXITY_NEAR_THRESHOLD = 50_000
const LINEAR_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000

interface GitHubIntegrationCredentials {
  installationId: number
  accessToken: string
  tokenExpiresAt: string
}

interface GitHubIntegrationMetadata extends Record<string, unknown> {
  organizationName: string | null
  repositorySelection: "all" | "selected" | null
  permissions: Record<string, string>
  repositories: GitHubInstalledRepository[]
  rateLimitRemaining: number | null
  rateLimitResetAt: string | null
}

interface RefreshResult {
  record: WorkspaceIntegrationRecord
  credentials: GitHubIntegrationCredentials
  metadata: GitHubIntegrationMetadata
}

interface GitHubApiHeaders {
  [key: string]: string | number | string[] | undefined
}

export class GitHubClient {
  private octokit: Octokit

  // `record`/`credentials`/`metadata` are null for an anonymous client. GitHub's
  // REST API serves public repositories without auth, so an unauthenticated
  // client still works for open-source repos; private resources answer 404,
  // which the tool layer surfaces as GITHUB_NOT_FOUND.
  constructor(
    private service: WorkspaceIntegrationService,
    private workspaceId: string,
    private record: WorkspaceIntegrationRecord | null,
    private credentials: GitHubIntegrationCredentials | null,
    private metadata: GitHubIntegrationMetadata | null
  ) {
    this.octokit = credentials ? new Octokit({ auth: credentials.accessToken }) : new Octokit()
  }

  /**
   * Build a client with no installation state. It reads public repositories via
   * GitHub's anonymous REST access; private resources answer 404. Use this when
   * the workspace has no usable GitHub integration but a caller still wants
   * open-source reads.
   */
  static anonymous(service: WorkspaceIntegrationService, workspaceId: string): GitHubClient {
    return new GitHubClient(service, workspaceId, null, null, null)
  }

  async request<T>(route: string, parameters: Record<string, unknown> = {}): Promise<T> {
    return this.requestInternal<T>(route, parameters, false)
  }

  private async requestInternal<T>(route: string, parameters: Record<string, unknown>, retried: boolean): Promise<T> {
    try {
      const response = await this.octokit.request(route, parameters)
      await this.captureRateLimit(response.headers as GitHubApiHeaders)
      return response.data as T
    } catch (error) {
      const status = getErrorStatus(error)
      const headers = getErrorHeaders(error)
      await this.captureRateLimit(headers)

      // Only authenticated installations can refresh; an anonymous client has
      // no credentials to renew, so its 401 propagates as-is.
      if (status === 401 && !retried && this.record && this.credentials) {
        const refreshed = await this.service.refreshGithubCredentialsForClient(this.workspaceId, this.record)
        if (!refreshed) {
          throw error
        }
        this.record = refreshed.record
        this.credentials = refreshed.credentials
        this.metadata = refreshed.metadata
        this.octokit = new Octokit({ auth: refreshed.credentials.accessToken })
        return this.requestInternal<T>(route, parameters, true)
      }

      throw error
    }
  }

  private async captureRateLimit(headers: GitHubApiHeaders | undefined): Promise<void> {
    // Anonymous clients have no integration record to persist against, and their
    // rate-limit headers are per-IP rather than workspace state.
    if (!headers || !this.metadata) return
    const remaining = parseIntegerHeader(headers["x-ratelimit-remaining"])
    const resetSeconds = parseIntegerHeader(headers["x-ratelimit-reset"])
    const resetAt = resetSeconds ? new Date(resetSeconds * 1000).toISOString() : null

    if (remaining === this.metadata.rateLimitRemaining && resetAt === this.metadata.rateLimitResetAt) {
      return
    }

    this.metadata = await this.service.updateGithubRateLimitMetadata(
      this.workspaceId,
      this.metadata,
      remaining,
      resetAt
    )
  }
}

interface LinearRefreshResult {
  record: WorkspaceIntegrationRecord
  credentials: LinearIntegrationCredentials
  metadata: LinearIntegrationMetadata
}

interface WorkspaceIntegrationServiceDeps {
  pool: Pool
  github: GitHubAppConfig
  linear: LinearOAuthConfig
}

export class WorkspaceIntegrationService {
  private app: App | null

  constructor(private deps: WorkspaceIntegrationServiceDeps) {
    this.app =
      deps.github.enabled && deps.github.privateKey
        ? new App({ appId: deps.github.appId, privateKey: deps.github.privateKey })
        : null
  }

  isGitHubEnabled(): boolean {
    return this.app !== null
  }

  isLinearEnabled(): boolean {
    return this.deps.linear.enabled
  }

  async getGithubIntegration(workspaceId: string): Promise<GitHubWorkspaceIntegration | null> {
    const record = await WorkspaceIntegrationRepository.findByWorkspaceAndProvider(
      this.deps.pool,
      workspaceId,
      WorkspaceIntegrationProviders.GITHUB
    )
    if (!record) return null

    const metadata = this.parseMetadata(record.metadata)
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      provider: "github",
      status: record.status,
      installedBy: record.installedBy,
      organizationName: metadata.organizationName,
      repositorySelection: metadata.repositorySelection,
      permissions: metadata.permissions,
      repositories: metadata.repositories,
      rateLimit: {
        remaining: metadata.rateLimitRemaining,
        resetAt: metadata.rateLimitResetAt,
      },
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    }
  }

  getGithubConnectUrl(workspaceId: string): string {
    this.requireGitHubEnabled()
    const state = createGithubInstallState(this.deps.github.integrationSecret, workspaceId)
    return `https://github.com/apps/${this.deps.github.appSlug}/installations/new?state=${encodeURIComponent(state)}`
  }

  async disconnectGithubIntegration(workspaceId: string): Promise<void> {
    await WorkspaceIntegrationRepository.update(this.deps.pool, workspaceId, WorkspaceIntegrationProviders.GITHUB, {
      status: WorkspaceIntegrationStatuses.INACTIVE,
      credentials: {},
      metadata: {},
    })
  }

  async syncGithubRepositories(workspaceId: string): Promise<GitHubWorkspaceIntegration> {
    this.requireGitHubEnabled()

    const record = await WorkspaceIntegrationRepository.findByWorkspaceAndProvider(
      this.deps.pool,
      workspaceId,
      WorkspaceIntegrationProviders.GITHUB
    )
    if (!record || record.status !== WorkspaceIntegrationStatuses.ACTIVE) {
      throw new HttpError("GitHub integration is not active for this workspace", {
        status: 404,
        code: "GITHUB_INTEGRATION_NOT_ACTIVE",
      })
    }

    let credentials: GitHubIntegrationCredentials
    try {
      credentials = this.parseCredentials(workspaceId, record.credentials)
    } catch (error) {
      log.warn({ err: error, workspaceId }, "GitHub integration credentials could not be decrypted during sync")
      throw new HttpError("GitHub integration credentials could not be decrypted", {
        status: 500,
        code: "GITHUB_CREDENTIALS_DECRYPT_FAILED",
      })
    }

    // Mint a fresh installation token and re-list repositories against
    // GitHub. The network round-trip happens before any DB write so we
    // don't hold a connection open during slow remote calls (INV-41).
    let accessToken: string
    let tokenExpiresAt: string
    let nextPermissions: Record<string, string>
    let repositories: GitHubInstalledRepository[]
    try {
      const tokenResponse = await this.getAppOctokit().request(
        "POST /app/installations/{installation_id}/access_tokens",
        { installation_id: credentials.installationId }
      )
      accessToken = tokenResponse.data.token
      tokenExpiresAt = tokenResponse.data.expires_at
      nextPermissions = normalizePermissions(tokenResponse.data.permissions)
      repositories = await listInstallationRepositories(new Octokit({ auth: accessToken }))
    } catch (error) {
      log.warn({ err: error, workspaceId }, "GitHub sync network call failed")
      throw new HttpError("Failed to sync GitHub repositories", {
        status: 502,
        code: "GITHUB_SYNC_FAILED",
      })
    }

    const metadata = this.parseMetadata(record.metadata)
    const nextMetadata: GitHubIntegrationMetadata = {
      ...metadata,
      permissions: nextPermissions || metadata.permissions,
      repositories,
    }

    // Optimistic predicate on status='active' so a concurrent disconnect
    // (which flips status to 'inactive' and clears credentials/metadata)
    // causes sync to fail cleanly instead of resurrecting the integration
    // with the freshly-minted token (INV-20).
    const updated = await WorkspaceIntegrationRepository.update(
      this.deps.pool,
      workspaceId,
      WorkspaceIntegrationProviders.GITHUB,
      {
        credentials: encryptJson(
          this.deps.github.integrationSecret,
          { installationId: credentials.installationId, accessToken, tokenExpiresAt },
          { workspaceId, provider: WorkspaceIntegrationProviders.GITHUB }
        ),
        metadata: nextMetadata,
      },
      { expectedStatus: WorkspaceIntegrationStatuses.ACTIVE }
    )
    if (!updated) {
      throw new HttpError("GitHub integration was disconnected during sync", {
        status: 409,
        code: "GITHUB_INTEGRATION_NOT_ACTIVE",
      })
    }

    const integration = await this.getGithubIntegration(workspaceId)
    if (!integration) {
      throw new HttpError("GitHub integration not found after sync", {
        status: 500,
        code: "GITHUB_INTEGRATION_NOT_FOUND",
      })
    }
    return integration
  }

  async handleGithubCallback(params: {
    state: string
    installationId: string
    workosUserId: string
    viewerPermissions: string[] | null
  }): Promise<{ workspaceId: string }> {
    this.requireGitHubEnabled()

    let workspaceId: string
    try {
      workspaceId = verifyGithubInstallState(this.deps.github.integrationSecret, params.state).workspaceId
    } catch (error) {
      throw new HttpError((error as Error).message, { status: 400, code: "INVALID_GITHUB_INSTALL_STATE" })
    }

    const access = await UserRepository.findWorkspaceUserAccess(this.deps.pool, workspaceId, params.workosUserId)
    if (!access.workspaceExists) {
      throw new HttpError("Workspace not found", { status: 404, code: "WORKSPACE_NOT_FOUND" })
    }
    if (!access.user) {
      throw new HttpError("Not a member of this workspace", { status: 403, code: "FORBIDDEN" })
    }
    // Session-path authz: prefer the JWT claim (no DB round-trip; immune to
    // mirror fan-out lag); fall back to role-derived permissions when the
    // session predates permission claims.
    const permissions = params.viewerPermissions ?? permissionsForRole(access.user.role)
    if (!permissions.includes(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)) {
      throw new HttpError("Only admins can connect GitHub", { status: 403, code: "FORBIDDEN" })
    }

    await this.completeGithubInstallation(workspaceId, access.user.id, params.installationId)
    return { workspaceId }
  }

  /**
   * Resolve a GitHub client for a workspace.
   *
   * When `allowUnauthenticatedFallback` is set, the paths where the workspace
   * has no usable installation (no app configured, no active integration,
   * undecryptable or unrefreshable credentials) return an anonymous client that
   * can still read public/open-source repositories instead of `null`. Callers
   * that only want authenticated access (e.g. link-preview enrichment) omit the
   * flag and keep the original null-on-missing behavior.
   *
   * The near-rate-limit branch deliberately does NOT fall back: it is a
   * back-off circuit-breaker for an installation that exists but is throttled.
   * Handing back an anonymous client there would silently downgrade a heavy
   * GitHub user to the shared per-IP anonymous quota and mask the rate-limit
   * state, so it keeps returning `null` (surfaced as GITHUB_NOT_CONNECTED).
   */
  async getGithubClient(
    workspaceId: string,
    options: { allowUnauthenticatedFallback?: boolean } = {}
  ): Promise<GitHubClient | null> {
    const fallback = () => (options.allowUnauthenticatedFallback ? GitHubClient.anonymous(this, workspaceId) : null)

    if (!this.app) return fallback()

    const record = await WorkspaceIntegrationRepository.findByWorkspaceAndProvider(
      this.deps.pool,
      workspaceId,
      WorkspaceIntegrationProviders.GITHUB
    )
    if (!record || record.status !== WorkspaceIntegrationStatuses.ACTIVE) {
      return fallback()
    }

    const metadata = this.parseMetadata(record.metadata)
    if (this.isNearGithubRateLimit(metadata)) {
      return null
    }

    let credentials: GitHubIntegrationCredentials
    try {
      credentials = this.parseCredentials(workspaceId, record.credentials)
    } catch (error) {
      log.warn({ err: error, workspaceId }, "GitHub integration credentials could not be decrypted")
      return fallback()
    }

    if (this.shouldRefreshToken(credentials.tokenExpiresAt)) {
      const refreshed = await this.refreshGithubCredentialsForClient(workspaceId, record)
      if (!refreshed) return fallback()
      return new GitHubClient(this, workspaceId, refreshed.record, refreshed.credentials, refreshed.metadata)
    }

    return new GitHubClient(this, workspaceId, record, credentials, metadata)
  }

  async updateGithubRateLimitMetadata(
    workspaceId: string,
    metadata: GitHubIntegrationMetadata,
    remaining: number | null,
    resetAt: string | null
  ): Promise<GitHubIntegrationMetadata> {
    const nextMetadata: GitHubIntegrationMetadata = {
      ...metadata,
      rateLimitRemaining: remaining,
      rateLimitResetAt: resetAt,
    }

    await WorkspaceIntegrationRepository.update(this.deps.pool, workspaceId, WorkspaceIntegrationProviders.GITHUB, {
      metadata: nextMetadata,
    })

    return nextMetadata
  }

  async refreshGithubCredentialsForClient(
    workspaceId: string,
    record: WorkspaceIntegrationRecord
  ): Promise<RefreshResult | null> {
    if (!this.app) return null

    let credentials: GitHubIntegrationCredentials
    try {
      credentials = this.parseCredentials(workspaceId, record.credentials)
    } catch (error) {
      log.warn({ err: error, workspaceId }, "Failed to parse GitHub credentials during refresh")
      return null
    }

    const metadata = this.parseMetadata(record.metadata)
    return this.refreshGithubCredentials(workspaceId, record, credentials.installationId, metadata)
  }

  private async completeGithubInstallation(
    workspaceId: string,
    installedByUserId: string,
    installationIdRaw: string
  ): Promise<void> {
    const installationId = Number.parseInt(installationIdRaw, 10)
    if (!Number.isFinite(installationId)) {
      throw new HttpError("Invalid GitHub installation ID", { status: 400, code: "INVALID_GITHUB_INSTALLATION" })
    }

    const installation = await this.getAppOctokit().request("GET /app/installations/{installation_id}", {
      installation_id: installationId,
    })

    const accountType = getInstallationAccountType(installation.data.account) ?? installation.data.target_type ?? null
    if (accountType !== "Organization") {
      throw new HttpError("GitHub App must be installed on an organization", {
        status: 400,
        code: "GITHUB_ORGANIZATION_REQUIRED",
      })
    }

    const refreshed = await this.refreshGithubCredentials(
      workspaceId,
      (await WorkspaceIntegrationRepository.findByWorkspaceAndProvider(
        this.deps.pool,
        workspaceId,
        WorkspaceIntegrationProviders.GITHUB
      )) ?? {
        id: workspaceIntegrationId(),
        workspaceId,
        provider: WorkspaceIntegrationProviders.GITHUB,
        status: WorkspaceIntegrationStatuses.INACTIVE,
        credentials: {},
        metadata: {},
        installedBy: installedByUserId,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      installationId,
      {
        organizationName: getInstallationAccountLogin(installation.data.account),
        repositorySelection: normalizeRepositorySelection(installation.data.repository_selection),
        permissions: normalizePermissions(installation.data.permissions),
        repositories: [],
        rateLimitRemaining: null,
        rateLimitResetAt: null,
      },
      installedByUserId,
      true
    )

    if (!refreshed) {
      throw new HttpError("Failed to activate GitHub integration", {
        status: 502,
        code: "GITHUB_INTEGRATION_ACTIVATION_FAILED",
      })
    }
  }

  private async refreshGithubCredentials(
    workspaceId: string,
    record: WorkspaceIntegrationRecord,
    installationId: number,
    metadata: GitHubIntegrationMetadata,
    installedByOverride?: string,
    hydrateRepositories = false
  ): Promise<RefreshResult | null> {
    try {
      const tokenResponse = await this.getAppOctokit().request(
        "POST /app/installations/{installation_id}/access_tokens",
        {
          installation_id: installationId,
        }
      )

      const accessToken = tokenResponse.data.token
      const tokenExpiresAt = tokenResponse.data.expires_at
      const nextMetadata: GitHubIntegrationMetadata = {
        ...metadata,
        permissions: normalizePermissions(tokenResponse.data.permissions) || metadata.permissions,
      }

      if (hydrateRepositories) {
        const installationOctokit = new Octokit({ auth: accessToken })
        nextMetadata.repositories = await listInstallationRepositories(installationOctokit)
      }

      const updated = await WorkspaceIntegrationRepository.upsert(this.deps.pool, {
        id: record.id,
        workspaceId,
        provider: WorkspaceIntegrationProviders.GITHUB,
        status: WorkspaceIntegrationStatuses.ACTIVE,
        credentials: encryptJson(
          this.deps.github.integrationSecret,
          {
            installationId,
            accessToken,
            tokenExpiresAt,
          },
          { workspaceId, provider: WorkspaceIntegrationProviders.GITHUB }
        ),
        metadata: nextMetadata,
        installedBy: installedByOverride ?? record.installedBy,
      })

      return {
        record: updated,
        credentials: {
          installationId,
          accessToken,
          tokenExpiresAt,
        },
        metadata: nextMetadata,
      }
    } catch (error) {
      log.warn({ err: error, workspaceId, installationId }, "GitHub installation token refresh failed")
      return null
    }
  }

  private parseCredentials(workspaceId: string, payload: Record<string, unknown>): GitHubIntegrationCredentials {
    const decrypted = decryptJson<Partial<GitHubIntegrationCredentials>>(this.deps.github.integrationSecret, payload, {
      workspaceId,
      provider: WorkspaceIntegrationProviders.GITHUB,
    })
    if (
      !decrypted ||
      typeof decrypted.installationId !== "number" ||
      typeof decrypted.accessToken !== "string" ||
      typeof decrypted.tokenExpiresAt !== "string"
    ) {
      throw new Error("Malformed GitHub integration credentials")
    }
    return decrypted as GitHubIntegrationCredentials
  }

  private parseMetadata(payload: Record<string, unknown>): GitHubIntegrationMetadata {
    return {
      organizationName: typeof payload.organizationName === "string" ? payload.organizationName : null,
      repositorySelection: normalizeRepositorySelection(payload.repositorySelection),
      permissions: normalizePermissions(payload.permissions),
      repositories: normalizeRepositories(payload.repositories),
      rateLimitRemaining:
        typeof payload.rateLimitRemaining === "number" && Number.isFinite(payload.rateLimitRemaining)
          ? payload.rateLimitRemaining
          : null,
      rateLimitResetAt: typeof payload.rateLimitResetAt === "string" ? payload.rateLimitResetAt : null,
    }
  }

  private isNearGithubRateLimit(metadata: GitHubIntegrationMetadata): boolean {
    if (metadata.rateLimitRemaining === null || !metadata.rateLimitResetAt) {
      return false
    }
    return (
      metadata.rateLimitRemaining <= GITHUB_RATE_LIMIT_NEAR_THRESHOLD &&
      new Date(metadata.rateLimitResetAt) > new Date()
    )
  }

  private shouldRefreshToken(tokenExpiresAt: string): boolean {
    return new Date(tokenExpiresAt).getTime() - Date.now() <= GITHUB_TOKEN_REFRESH_SKEW_MS
  }

  private requireGitHubEnabled(): void {
    if (!this.app) {
      throw new HttpError("GitHub integration is not configured", {
        status: 503,
        code: "GITHUB_INTEGRATION_NOT_CONFIGURED",
      })
    }
  }

  private getAppOctokit() {
    this.requireGitHubEnabled()
    return this.app!.octokit
  }

  // ── Linear ────────────────────────────────────────────────────────────

  async getLinearIntegration(workspaceId: string): Promise<LinearWorkspaceIntegration | null> {
    const record = await WorkspaceIntegrationRepository.findByWorkspaceAndProvider(
      this.deps.pool,
      workspaceId,
      WorkspaceIntegrationProviders.LINEAR
    )
    if (!record) return null

    const metadata = this.parseLinearMetadata(record.metadata)
    let scope: string | null = null
    try {
      scope = this.parseLinearCredentials(workspaceId, record.credentials).scope || null
    } catch {
      scope = null
    }

    return {
      id: record.id,
      workspaceId: record.workspaceId,
      provider: "linear",
      status: record.status,
      installedBy: record.installedBy,
      organizationId: metadata.organizationId,
      organizationName: metadata.organizationName,
      organizationUrlKey: metadata.organizationUrlKey,
      authorizedUser: metadata.authorizedUser,
      scope,
      rateLimit: metadata.rateLimit,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    }
  }

  getLinearConnectUrl(workspaceId: string): string {
    this.requireLinearEnabled()
    const state = createLinearInstallState(this.deps.linear.integrationSecret, workspaceId)
    return buildLinearAuthorizationUrl({
      clientId: this.deps.linear.clientId,
      redirectUri: this.deps.linear.redirectUri,
      state,
    })
  }

  async disconnectLinearIntegration(workspaceId: string): Promise<void> {
    const record = await WorkspaceIntegrationRepository.findByWorkspaceAndProvider(
      this.deps.pool,
      workspaceId,
      WorkspaceIntegrationProviders.LINEAR
    )

    if (record) {
      try {
        const credentials = this.parseLinearCredentials(workspaceId, record.credentials)
        await revokeLinearToken({ accessToken: credentials.accessToken })
      } catch (error) {
        log.warn({ err: error, workspaceId }, "Linear token revocation failed; continuing with local disconnect")
      }
    }

    await WorkspaceIntegrationRepository.update(this.deps.pool, workspaceId, WorkspaceIntegrationProviders.LINEAR, {
      status: WorkspaceIntegrationStatuses.INACTIVE,
      credentials: {},
      metadata: {},
    })
  }

  async handleLinearCallback(params: {
    state: string
    code: string
    workosUserId: string
  }): Promise<{ workspaceId: string }> {
    this.requireLinearEnabled()

    let workspaceId: string
    try {
      workspaceId = verifyLinearInstallState(this.deps.linear.integrationSecret, params.state).workspaceId
    } catch (error) {
      throw new HttpError((error as Error).message, { status: 400, code: "INVALID_LINEAR_INSTALL_STATE" })
    }

    const access = await UserRepository.findWorkspaceUserAccess(this.deps.pool, workspaceId, params.workosUserId)
    if (!access.workspaceExists) {
      throw new HttpError("Workspace not found", { status: 404, code: "WORKSPACE_NOT_FOUND" })
    }
    if (!access.user) {
      throw new HttpError("Not a member of this workspace", { status: 403, code: "FORBIDDEN" })
    }
    if (access.user.role !== "admin" && access.user.role !== "owner") {
      throw new HttpError("Only admins can connect Linear", { status: 403, code: "FORBIDDEN" })
    }

    await this.completeLinearInstallation(workspaceId, access.user.id, params.code)
    return { workspaceId }
  }

  async getLinearClient(workspaceId: string): Promise<LinearClient | null> {
    if (!this.isLinearEnabled()) return null

    const record = await WorkspaceIntegrationRepository.findByWorkspaceAndProvider(
      this.deps.pool,
      workspaceId,
      WorkspaceIntegrationProviders.LINEAR
    )
    if (!record || record.status !== WorkspaceIntegrationStatuses.ACTIVE) {
      return null
    }

    const metadata = this.parseLinearMetadata(record.metadata)
    if (this.isNearLinearRateLimit(metadata)) {
      return null
    }

    let credentials: LinearIntegrationCredentials
    try {
      credentials = this.parseLinearCredentials(workspaceId, record.credentials)
    } catch (error) {
      log.warn({ err: error, workspaceId }, "Linear integration credentials could not be decrypted")
      return null
    }

    if (this.shouldRefreshLinearToken(credentials.tokenExpiresAt)) {
      const refreshed = await this.refreshLinearCredentialsForPreview(workspaceId, record)
      if (!refreshed) return null
      return new LinearClient(this, workspaceId, refreshed.record, refreshed.credentials, refreshed.metadata)
    }

    return new LinearClient(this, workspaceId, record, credentials, metadata)
  }

  async updateLinearRateLimitMetadata(
    workspaceId: string,
    metadata: LinearIntegrationMetadata,
    rateLimit: LinearRateLimit
  ): Promise<LinearIntegrationMetadata> {
    const nextMetadata: LinearIntegrationMetadata = { ...metadata, rateLimit }

    await WorkspaceIntegrationRepository.update(this.deps.pool, workspaceId, WorkspaceIntegrationProviders.LINEAR, {
      metadata: nextMetadata,
    })

    return nextMetadata
  }

  async refreshLinearCredentialsForPreview(
    workspaceId: string,
    record: WorkspaceIntegrationRecord
  ): Promise<LinearRefreshResult | null> {
    let credentials: LinearIntegrationCredentials
    try {
      credentials = this.parseLinearCredentials(workspaceId, record.credentials)
    } catch (error) {
      log.warn({ err: error, workspaceId }, "Failed to parse Linear credentials during refresh")
      return null
    }

    if (!credentials.refreshToken) {
      log.warn({ workspaceId }, "Linear credentials have no refresh token; marking integration as error state")
      await WorkspaceIntegrationRepository.update(this.deps.pool, workspaceId, WorkspaceIntegrationProviders.LINEAR, {
        status: WorkspaceIntegrationStatuses.ERROR,
      })
      return null
    }

    const metadata = this.parseLinearMetadata(record.metadata)

    let tokens: LinearOAuthTokenResponse
    try {
      tokens = await refreshLinearToken({
        clientId: this.deps.linear.clientId,
        clientSecret: this.deps.linear.clientSecret,
        refreshToken: credentials.refreshToken,
      })
    } catch (error) {
      log.warn({ err: error, workspaceId }, "Linear token refresh failed")
      await WorkspaceIntegrationRepository.update(this.deps.pool, workspaceId, WorkspaceIntegrationProviders.LINEAR, {
        status: WorkspaceIntegrationStatuses.ERROR,
      })
      return null
    }

    return this.persistLinearCredentials(workspaceId, record, tokens, metadata)
  }

  private async completeLinearInstallation(
    workspaceId: string,
    installedByUserId: string,
    code: string
  ): Promise<void> {
    let tokens: LinearOAuthTokenResponse
    try {
      tokens = await exchangeLinearCode({
        clientId: this.deps.linear.clientId,
        clientSecret: this.deps.linear.clientSecret,
        redirectUri: this.deps.linear.redirectUri,
        code,
      })
    } catch (error) {
      throw new HttpError(`Linear token exchange failed: ${(error as Error).message}`, {
        status: 502,
        code: "LINEAR_TOKEN_EXCHANGE_FAILED",
      })
    }

    const viewer = await fetchLinearViewer(tokens.accessToken)
    if (!viewer) {
      throw new HttpError("Failed to fetch Linear viewer/organization", {
        status: 502,
        code: "LINEAR_VIEWER_FETCH_FAILED",
      })
    }

    const existing = await WorkspaceIntegrationRepository.findByWorkspaceAndProvider(
      this.deps.pool,
      workspaceId,
      WorkspaceIntegrationProviders.LINEAR
    )

    const metadata: LinearIntegrationMetadata = {
      organizationId: viewer.organization.id,
      organizationName: viewer.organization.name,
      organizationUrlKey: viewer.organization.urlKey,
      authorizedUser: viewer.user,
      rateLimit: {
        requestsRemaining: null,
        requestsResetAt: null,
        complexityRemaining: null,
        complexityResetAt: null,
      },
    }

    const baseRecord: WorkspaceIntegrationRecord = existing ?? {
      id: workspaceIntegrationId(),
      workspaceId,
      provider: WorkspaceIntegrationProviders.LINEAR,
      status: WorkspaceIntegrationStatuses.INACTIVE,
      credentials: {},
      metadata: {},
      installedBy: installedByUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    await this.persistLinearCredentials(workspaceId, baseRecord, tokens, metadata, installedByUserId)
  }

  private async persistLinearCredentials(
    workspaceId: string,
    record: WorkspaceIntegrationRecord,
    tokens: LinearOAuthTokenResponse,
    metadata: LinearIntegrationMetadata,
    installedByOverride?: string
  ): Promise<LinearRefreshResult> {
    const credentials: LinearIntegrationCredentials = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenType: tokens.tokenType,
      tokenExpiresAt: expiresAtFromNow(tokens.expiresIn),
      scope: tokens.scope,
      actor: "app",
    }

    const updated = await WorkspaceIntegrationRepository.upsert(this.deps.pool, {
      id: record.id,
      workspaceId,
      provider: WorkspaceIntegrationProviders.LINEAR,
      status: WorkspaceIntegrationStatuses.ACTIVE,
      credentials: encryptJson(this.deps.linear.integrationSecret, credentials, {
        workspaceId,
        provider: WorkspaceIntegrationProviders.LINEAR,
      }),
      metadata,
      installedBy: installedByOverride ?? record.installedBy,
    })

    return { record: updated, credentials, metadata }
  }

  private parseLinearCredentials(workspaceId: string, payload: Record<string, unknown>): LinearIntegrationCredentials {
    const decrypted = decryptJson<Partial<LinearIntegrationCredentials>>(this.deps.linear.integrationSecret, payload, {
      workspaceId,
      provider: WorkspaceIntegrationProviders.LINEAR,
    })
    if (
      !decrypted ||
      typeof decrypted.accessToken !== "string" ||
      typeof decrypted.tokenExpiresAt !== "string" ||
      decrypted.actor !== "app"
    ) {
      throw new Error("Malformed Linear integration credentials")
    }
    return {
      accessToken: decrypted.accessToken,
      refreshToken: typeof decrypted.refreshToken === "string" ? decrypted.refreshToken : null,
      tokenType: typeof decrypted.tokenType === "string" ? decrypted.tokenType : "Bearer",
      tokenExpiresAt: decrypted.tokenExpiresAt,
      scope: typeof decrypted.scope === "string" ? decrypted.scope : "",
      actor: "app",
    }
  }

  private parseLinearMetadata(payload: Record<string, unknown>): LinearIntegrationMetadata {
    const authorizedUserRaw = (payload.authorizedUser as Record<string, unknown> | null | undefined) ?? null
    const authorizedUser: LinearAuthorizedUser | null =
      authorizedUserRaw && typeof authorizedUserRaw.id === "string" && typeof authorizedUserRaw.name === "string"
        ? {
            id: authorizedUserRaw.id,
            name: authorizedUserRaw.name,
            email: typeof authorizedUserRaw.email === "string" ? authorizedUserRaw.email : null,
          }
        : null

    const rateLimitRaw = (payload.rateLimit as Record<string, unknown> | null | undefined) ?? null
    const rateLimit: LinearRateLimit = {
      requestsRemaining:
        rateLimitRaw && typeof rateLimitRaw.requestsRemaining === "number" ? rateLimitRaw.requestsRemaining : null,
      requestsResetAt:
        rateLimitRaw && typeof rateLimitRaw.requestsResetAt === "string" ? rateLimitRaw.requestsResetAt : null,
      complexityRemaining:
        rateLimitRaw && typeof rateLimitRaw.complexityRemaining === "number" ? rateLimitRaw.complexityRemaining : null,
      complexityResetAt:
        rateLimitRaw && typeof rateLimitRaw.complexityResetAt === "string" ? rateLimitRaw.complexityResetAt : null,
    }

    return {
      organizationId: typeof payload.organizationId === "string" ? payload.organizationId : null,
      organizationName: typeof payload.organizationName === "string" ? payload.organizationName : null,
      organizationUrlKey: typeof payload.organizationUrlKey === "string" ? payload.organizationUrlKey : null,
      authorizedUser,
      rateLimit,
    }
  }

  private isNearLinearRateLimit(metadata: LinearIntegrationMetadata): boolean {
    const { requestsRemaining, requestsResetAt, complexityRemaining, complexityResetAt } = metadata.rateLimit
    const now = new Date()
    const requestsLow =
      requestsRemaining !== null &&
      requestsResetAt !== null &&
      requestsRemaining <= LINEAR_REQUESTS_NEAR_THRESHOLD &&
      new Date(requestsResetAt) > now
    const complexityLow =
      complexityRemaining !== null &&
      complexityResetAt !== null &&
      complexityRemaining <= LINEAR_COMPLEXITY_NEAR_THRESHOLD &&
      new Date(complexityResetAt) > now
    return requestsLow || complexityLow
  }

  private shouldRefreshLinearToken(tokenExpiresAt: string): boolean {
    return new Date(tokenExpiresAt).getTime() - Date.now() <= LINEAR_TOKEN_REFRESH_SKEW_MS
  }

  private requireLinearEnabled(): void {
    if (!this.isLinearEnabled()) {
      throw new HttpError("Linear integration is not configured", {
        status: 503,
        code: "LINEAR_INTEGRATION_NOT_CONFIGURED",
      })
    }
  }
}

async function listInstallationRepositories(octokit: Octokit): Promise<GitHubInstalledRepository[]> {
  const repositories: GitHubInstalledRepository[] = []
  let page = 1

  for (;;) {
    const response = await octokit.request("GET /installation/repositories", {
      per_page: 100,
      page,
    })
    repositories.push(
      ...response.data.repositories.map((repo) => ({
        fullName: repo.full_name,
        private: repo.private,
      }))
    )
    if (response.data.repositories.length < 100) {
      break
    }
    page += 1
  }

  return repositories
}

function normalizePermissions(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  )
}

function normalizeRepositories(value: unknown): GitHubInstalledRepository[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const fullName = (entry as { fullName?: unknown }).fullName
    const isPrivate = (entry as { private?: unknown }).private
    if (typeof fullName !== "string" || typeof isPrivate !== "boolean") return []
    return [{ fullName, private: isPrivate }]
  })
}

function normalizeRepositorySelection(value: unknown): "all" | "selected" | null {
  return value === "all" || value === "selected" ? value : null
}

function getInstallationAccountType(account: unknown): string | null {
  if (!account || typeof account !== "object") return null
  const type = (account as { type?: unknown }).type
  return typeof type === "string" ? type : null
}

function getInstallationAccountLogin(account: unknown): string | null {
  if (!account || typeof account !== "object") return null
  const login = (account as { login?: unknown }).login
  return typeof login === "string" ? login : null
}

function parseIntegerHeader(value: string | number | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== "string" && typeof raw !== "number") {
    return null
  }
  const parsed = Number.parseInt(String(raw), 10)
  return Number.isFinite(parsed) ? parsed : null
}

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null
  const status = (error as { status?: unknown }).status
  return typeof status === "number" ? status : null
}

function getErrorHeaders(error: unknown): GitHubApiHeaders | undefined {
  if (!error || typeof error !== "object") return undefined
  return (error as { response?: { headers?: GitHubApiHeaders } }).response?.headers
}

interface LinearViewerResponse {
  organization: { id: string; name: string; urlKey: string }
  user: LinearAuthorizedUser
}

/**
 * One-shot GraphQL fetch used during install/callback to capture organization
 * identity. Does not go through `LinearClient` because no integration record
 * exists yet at this point.
 */
async function fetchLinearViewer(accessToken: string): Promise<LinearViewerResponse | null> {
  const response = await fetch(LinearGraphQLEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query: `query InstallViewer {
        organization { id name urlKey }
        viewer { id name email }
      }`,
    }),
  })

  if (!response.ok) return null

  const body = (await response.json().catch(() => null)) as {
    data?: {
      organization?: { id?: unknown; name?: unknown; urlKey?: unknown }
      viewer?: { id?: unknown; name?: unknown; email?: unknown }
    }
  } | null

  const org = body?.data?.organization
  const viewer = body?.data?.viewer
  if (
    !org ||
    typeof org.id !== "string" ||
    typeof org.name !== "string" ||
    typeof org.urlKey !== "string" ||
    !viewer ||
    typeof viewer.id !== "string" ||
    typeof viewer.name !== "string"
  ) {
    return null
  }

  return {
    organization: { id: org.id, name: org.name, urlKey: org.urlKey },
    user: {
      id: viewer.id,
      name: viewer.name,
      email: typeof viewer.email === "string" ? viewer.email : null,
    },
  }
}
