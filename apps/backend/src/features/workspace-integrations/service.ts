import type { Pool } from "pg"
import { App, Octokit } from "octokit"
import { logger } from "../../lib/logger"
import { HttpError } from "../../lib/errors"
import { workspaceIntegrationId } from "../../lib/id"
import type { GitHubAppConfig, LinearOAuthConfig } from "../../lib/env"
import { withTransaction } from "../../db"
import type { Querier } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
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
  type ToolPrivacyCategory,
} from "@threa/types"
import {
  decryptJson,
  encryptJson,
  createGithubInstallState,
  createLinearInstallState,
  verifyGithubInstallState,
  verifyLinearInstallState,
} from "./crypto"
import {
  WorkspaceIntegrationRepository,
  type UpsertWorkspaceIntegrationParams,
  type WorkspaceIntegrationRecord,
} from "./repository"
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
  // Account login (org or user); the JSONB key predates personal-account support.
  organizationName: string | null
  accountType: "Organization" | "User" | null
  repositorySelection: "all" | "selected" | null
  // GitHub's `html_url` for the installation — its settings page, where the
  // repository grant is edited. Absent on rows installed before it was captured;
  // `mapGithubIntegration` derives a replacement so those still get a link.
  configurationUrl: string | null
  permissions: Record<string, string>
  repositories: GitHubInstalledRepository[]
  rateLimitRemaining: number | null
  rateLimitResetAt: string | null
}

/** Installation identity + repository-grant mode as GitHub reports it. */
interface GitHubInstallationSnapshot {
  accountLogin: string | null
  accountType: "Organization" | "User" | null
  repositorySelection: "all" | "selected" | null
  configurationUrl: string | null
  permissions: Record<string, string>
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
    return (await this.requestInternal(route, parameters, false)).data as T
  }

  /**
   * GET with `If-None-Match` support for cache-validator refreshes. A matching
   * validator surfaces as `{ status: 304 }` instead of the RequestError octokit
   * throws for it; an authorized 304 does not count against the primary rate
   * limit, which is the whole point of the conditional refresh path.
   */
  async requestConditional<T>(
    route: string,
    parameters: Record<string, unknown>,
    ifNoneMatch: string | null
  ): Promise<{ status: 200; data: T; etag: string | null } | { status: 304 }> {
    const withValidator = ifNoneMatch
      ? {
          ...parameters,
          headers: { ...(parameters.headers as Record<string, unknown> | undefined), "if-none-match": ifNoneMatch },
        }
      : parameters
    try {
      const response = await this.requestInternal(route, withValidator, false)
      const etag = response.headers["etag"]
      return { status: 200, data: response.data as T, etag: typeof etag === "string" ? etag : null }
    } catch (error) {
      if (getErrorStatus(error) === 304) return { status: 304 }
      throw error
    }
  }

  private async requestInternal(
    route: string,
    parameters: Record<string, unknown>,
    retried: boolean
  ): Promise<{ data: unknown; headers: GitHubApiHeaders }> {
    try {
      const response = await this.octokit.request(route, parameters)
      const headers = response.headers as GitHubApiHeaders
      await this.captureRateLimit(headers)
      return { data: response.data, headers }
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
        return this.requestInternal(route, parameters, true)
      }

      throw error
    }
  }

  // Best-effort telemetry: a persistence failure here must never propagate.
  // `requestInternal` calls this on the error path BEFORE the 401-refresh branch,
  // so a throw would replace the original GitHub error and skip the refresh retry.
  private async captureRateLimit(headers: GitHubApiHeaders | undefined): Promise<void> {
    try {
      // Anonymous clients have no integration record to persist against, and their
      // rate-limit headers are per-IP rather than workspace state.
      if (!headers || !this.metadata || !this.credentials || !this.record) return
      const record = this.record
      const remaining = parseIntegerHeader(headers["x-ratelimit-remaining"])
      const resetSeconds = parseIntegerHeader(headers["x-ratelimit-reset"])
      const resetAt = resetSeconds ? new Date(resetSeconds * 1000).toISOString() : null

      if (remaining === this.metadata.rateLimitRemaining && resetAt === this.metadata.rateLimitResetAt) {
        return
      }

      const result = await this.service.updateGithubRateLimitMetadata(
        this.workspaceId,
        this.metadata,
        record.installationId,
        remaining,
        resetAt,
        record.version
      )
      this.metadata = result.metadata
      // Advance the cached version on a win so this reused client's next capture
      // CASes on the fresh generation instead of colliding with its own prior write.
      if (result.version !== null) this.record = { ...record, version: result.version }
    } catch (error) {
      log.warn({ err: error, workspaceId: this.workspaceId }, "GitHub rate-limit capture failed; continuing")
    }
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
  // This region's routing key, stamped into the durable `github_route:*` outbox
  // events that `GithubRouteSyncHandler` drains into the control plane. Null in
  // local single-region dev (no control plane) — the events are then not emitted.
  region?: string | null
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

  /**
   * Tool-privacy categories whose backing tools are actually available in this
   * workspace. `web`/`workspace` are always present; `github`/`linear` only when
   * enabled for the deployment AND active for the workspace. `messaging` is
   * omitted — always allowed, never offered as a toggle.
   */
  async getAvailableToolCategories(workspaceId: string): Promise<ToolPrivacyCategory[]> {
    // GitHub and Linear are independent lookups — fan them out so they don't
    // serialize on the bootstrap path. Each short-circuits (no query) when its
    // integration is disabled for the deployment.
    const [githubInstalls, linear] = await Promise.all([
      this.isGitHubEnabled() ? this.listGithubInstallations(workspaceId) : Promise.resolve([]),
      this.isLinearEnabled() ? this.getLinearIntegration(workspaceId) : Promise.resolve(null),
    ])
    const categories: ToolPrivacyCategory[] = ["web", "workspace"]
    if (githubInstalls.some((install) => install.status === WorkspaceIntegrationStatuses.ACTIVE)) {
      categories.push("github")
    }
    if (linear?.status === WorkspaceIntegrationStatuses.ACTIVE) categories.push("linear")
    return categories
  }

  /**
   * Every GitHub installation the workspace has connected (multi-install). Rows
   * disconnected to INACTIVE are historical junk and filtered out; active and
   * error rows render. Oldest install first (list ordering is deterministic).
   */
  async listGithubInstallations(workspaceId: string): Promise<GitHubWorkspaceIntegration[]> {
    const records = await WorkspaceIntegrationRepository.listByWorkspaceAndProvider(
      this.deps.pool,
      workspaceId,
      WorkspaceIntegrationProviders.GITHUB
    )
    return records
      .filter((record) => record.status !== WorkspaceIntegrationStatuses.INACTIVE)
      .map((record) => this.mapGithubIntegration(record))
  }

  private mapGithubIntegration(record: WorkspaceIntegrationRecord): GitHubWorkspaceIntegration {
    const metadata = this.parseMetadata(record.metadata)
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      provider: "github",
      status: record.status,
      installedBy: record.installedBy,
      accountLogin: metadata.organizationName,
      installationId: record.installationId,
      accountType: metadata.accountType,
      repositorySelection: metadata.repositorySelection,
      configurationUrl:
        metadata.configurationUrl ??
        deriveInstallationConfigurationUrl(record.installationId, metadata.accountType, metadata.organizationName),
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

  async disconnectGithubInstallation(workspaceId: string, integrationId: string): Promise<void> {
    const record = await WorkspaceIntegrationRepository.findByWorkspaceAndId(this.deps.pool, workspaceId, integrationId)
    // Idempotent 204 semantics: an unknown id or a non-GitHub row is a no-op.
    if (!record || record.provider !== WorkspaceIntegrationProviders.GITHUB) return

    // Resolve the installation id from the pre-clear row so the unregister event
    // carries it even for a pre-backfill row whose only copy lives in the
    // credentials this update wipes. Committing the event in the same transaction
    // makes the order the clear runs in irrelevant — the id is already captured.
    const installationId = this.resolveInstallationId(workspaceId, record)

    await withTransaction(this.deps.pool, async (client) => {
      const updated = await WorkspaceIntegrationRepository.update(
        client,
        workspaceId,
        WorkspaceIntegrationProviders.GITHUB,
        record.installationId,
        {
          status: WorkspaceIntegrationStatuses.INACTIVE,
          credentials: {},
          metadata: {},
        }
      )
      if (!updated) {
        log.warn(
          { workspaceId, installationId },
          "GitHub disconnect matched 0 rows — a concurrent reinstall likely won the guarded update"
        )
        return
      }
      if (installationId) {
        await this.emitRouteUnregister(client, workspaceId, installationId)
      }
    })
  }

  /**
   * All workspaces whose active GitHub integration belongs to `installationId`.
   * The webhook worker uses this to fan a delivery out to every subscribed
   * workspace (installs are per org, so this is normally >1 — INV-8 keeps
   * workspace resolution regional).
   */
  async listActiveWorkspaceIdsForInstallation(installationId: string): Promise<string[]> {
    const records = await WorkspaceIntegrationRepository.listActiveByInstallationId(
      this.deps.pool,
      WorkspaceIntegrationProviders.GITHUB,
      installationId
    )
    return records.map((record) => record.workspaceId)
  }

  /**
   * Tear down every workspace's GitHub integration for a deleted/suspended
   * installation (webhook `installation` event). Per row, one transaction flips
   * the status inactive and commits the durable `github_route:unregister` event
   * so no further webhooks fan to this region.
   *
   * The status flip is guarded on the EXACT installation id (plus status='active')
   * so a row that disconnected and reconnected to a DIFFERENT installation between
   * the list and the write is left untouched — deleting installation A must never
   * deactivate a row now on B. A guarded no-op emits no unregister event and is
   * not counted as deactivated. The flip and the event are idempotent, so a retry
   * after a partial failure is safe.
   */
  async deactivateInstallation(installationId: string): Promise<{ deactivatedWorkspaceIds: string[] }> {
    const records = await WorkspaceIntegrationRepository.listActiveByInstallationId(
      this.deps.pool,
      WorkspaceIntegrationProviders.GITHUB,
      installationId
    )
    const deactivatedWorkspaceIds: string[] = []
    for (const record of records) {
      const updated = await withTransaction(this.deps.pool, async (client) => {
        const result = await WorkspaceIntegrationRepository.update(
          client,
          record.workspaceId,
          WorkspaceIntegrationProviders.GITHUB,
          installationId,
          { status: WorkspaceIntegrationStatuses.INACTIVE },
          { expectedStatus: WorkspaceIntegrationStatuses.ACTIVE }
        )
        if (result) {
          await this.emitRouteUnregister(client, record.workspaceId, installationId)
        }
        return result
      })
      if (updated) {
        deactivatedWorkspaceIds.push(record.workspaceId)
      }
    }
    return { deactivatedWorkspaceIds }
  }

  /**
   * Backfill one workspace's GitHub reverse index: derive the installation id
   * (plaintext column, else decrypt), persist it to the plaintext column, and
   * register the CP route. Idempotent — safe to re-run. Returns the number of
   * integrations processed (0 or 1). A row whose credentials can't be decrypted
   * is skipped (processed 0) rather than retried forever; a route-registration
   * failure throws so the backfill framework retries the chunk.
   */
  async backfillGithubRoute(workspaceId: string): Promise<{ processed: number }> {
    const record = await WorkspaceIntegrationRepository.findByWorkspaceAndProvider(
      this.deps.pool,
      workspaceId,
      WorkspaceIntegrationProviders.GITHUB
    )
    if (!record || record.status !== WorkspaceIntegrationStatuses.ACTIVE) {
      return { processed: 0 }
    }

    const installationId = this.resolveInstallationId(workspaceId, record)
    if (!installationId) {
      log.warn({ workspaceId }, "GitHub installation id could not be resolved during backfill; skipping")
      return { processed: 0 }
    }

    // One transaction persists the plaintext id and commits the register event.
    // The update is guarded on status='active' (a concurrent disconnect flips it
    // inactive) AND scoped to the installation id column read at the top (NULL for a
    // pre-backfill row); a reconnect to a DIFFERENT installation B shifts the column
    // to B, so this NULL-scoped write matches 0 rows rather than clobbering B back
    // to A. Because the register event is ordered in the outbox, a disconnect that
    // lands after this commit emits its unregister event after ours — the control
    // plane converges without a post-register re-check.
    const updated = await withTransaction(this.deps.pool, async (client) => {
      const result = await WorkspaceIntegrationRepository.update(
        client,
        workspaceId,
        WorkspaceIntegrationProviders.GITHUB,
        record.installationId,
        { installationId },
        { expectedStatus: WorkspaceIntegrationStatuses.ACTIVE }
      )
      if (result) {
        await this.emitRouteRegister(client, workspaceId, installationId)
      }
      return result
    })

    return { processed: updated ? 1 : 0 }
  }

  /**
   * The plaintext `installation_id` column is the source of truth for the
   * reverse index; fall back to decrypting credentials for pre-backfill rows
   * that predate the column.
   */
  private resolveInstallationId(workspaceId: string, record: WorkspaceIntegrationRecord): string | null {
    if (record.installationId) return record.installationId
    try {
      return String(this.parseCredentials(workspaceId, record.credentials).installationId)
    } catch {
      return null
    }
  }

  /**
   * Reconcile one installation's cached snapshot against GitHub: repository grant,
   * selection mode, account identity, permissions, and a freshly minted token.
   * The grant itself is edited on GitHub (Threa holds only an installation token,
   * which cannot change repository access), so this is the read side of every
   * reconfiguration — user-triggered from settings, or webhook-triggered when the
   * user adds/removes repositories on GitHub.
   */
  async syncGithubRepositories(workspaceId: string, integrationId: string): Promise<GitHubWorkspaceIntegration> {
    this.requireGitHubEnabled()

    const record = await WorkspaceIntegrationRepository.findByWorkspaceAndId(this.deps.pool, workspaceId, integrationId)
    if (
      !record ||
      record.provider !== WorkspaceIntegrationProviders.GITHUB ||
      record.status !== WorkspaceIntegrationStatuses.ACTIVE
    ) {
      throw new HttpError("GitHub integration is not active for this workspace", {
        status: 404,
        code: "GITHUB_INTEGRATION_NOT_ACTIVE",
      })
    }

    const result = await this.syncGithubInstallationRecord(workspaceId, record)
    if (result.ok) {
      return this.mapGithubIntegration(result.record)
    }

    switch (result.failure) {
      case "decrypt":
        throw new HttpError("GitHub integration credentials could not be decrypted", {
          status: 500,
          code: "GITHUB_CREDENTIALS_DECRYPT_FAILED",
        })
      case "installation_gone":
        throw new HttpError("This GitHub installation no longer exists. Reconnect to restore access.", {
          status: 409,
          code: "GITHUB_INSTALLATION_GONE",
        })
      case "conflict":
        throw new HttpError("GitHub integration was disconnected during sync", {
          status: 409,
          code: "GITHUB_INTEGRATION_NOT_ACTIVE",
        })
      default:
        throw new HttpError("Failed to sync GitHub repositories", { status: 502, code: "GITHUB_SYNC_FAILED" })
    }
  }

  /**
   * Re-sync every workspace subscribed to an installation. Driven by the
   * `installation_repositories` webhook, so a repository added or removed on
   * GitHub lands in Threa without anyone opening settings. A network failure is
   * rethrown so the queue retries the delivery; terminal per-row failures
   * (undecryptable credentials, a lost CAS, an installation GitHub no longer
   * knows) are logged and skipped — retrying them would never succeed.
   */
  async refreshGithubInstallationRepositories(installationId: string): Promise<{ refreshedWorkspaceIds: string[] }> {
    if (!this.isGitHubEnabled()) return { refreshedWorkspaceIds: [] }

    const records = await WorkspaceIntegrationRepository.listActiveByInstallationId(
      this.deps.pool,
      WorkspaceIntegrationProviders.GITHUB,
      installationId
    )
    const refreshedWorkspaceIds: string[] = []
    let retryable = false
    for (const record of records) {
      const result = await this.syncGithubInstallationRecord(record.workspaceId, record)
      if (result.ok) {
        refreshedWorkspaceIds.push(record.workspaceId)
        continue
      }
      if (result.failure === "network") retryable = true
      log.warn(
        { workspaceId: record.workspaceId, installationId, failure: result.failure },
        "GitHub installation repository refresh failed for a workspace"
      )
    }

    if (retryable) {
      throw new Error(`GitHub installation ${installationId} repository refresh failed; retrying delivery`)
    }
    return { refreshedWorkspaceIds }
  }

  /**
   * The one snapshot-refresh path, shared by the settings Sync button and the
   * webhook. All network work happens before any DB write so no connection is
   * held across it (INV-41).
   *
   * The write is a CACHE WRITE — it replaces the whole metadata object — so it
   * pins the active status and the installation observed before the round-trip
   * (INV-20) plus the version read at the same point (INV-66), and re-reads and
   * retries ONCE against the current version before giving up.
   */
  private async syncGithubInstallationRecord(
    workspaceId: string,
    record: WorkspaceIntegrationRecord
  ): Promise<
    | { ok: true; record: WorkspaceIntegrationRecord }
    | { ok: false; failure: "decrypt" | "installation_gone" | "network" | "conflict" }
  > {
    let credentials: GitHubIntegrationCredentials
    try {
      credentials = this.parseCredentials(workspaceId, record.credentials)
    } catch (error) {
      log.warn({ err: error, workspaceId }, "GitHub integration credentials could not be decrypted during sync")
      return { ok: false, failure: "decrypt" }
    }

    let accessToken: string
    let tokenExpiresAt: string
    let tokenPermissions: Record<string, string>
    let snapshot: GitHubInstallationSnapshot
    let repositories: GitHubInstalledRepository[]
    try {
      const tokenResponse = await this.getAppOctokit().request(
        "POST /app/installations/{installation_id}/access_tokens",
        { installation_id: credentials.installationId }
      )
      accessToken = tokenResponse.data.token
      tokenExpiresAt = tokenResponse.data.expires_at
      tokenPermissions = normalizePermissions(tokenResponse.data.permissions)
      snapshot = await this.fetchGithubInstallationSnapshot(credentials.installationId)
      repositories = await listInstallationRepositories(new Octokit({ auth: accessToken }))
    } catch (error) {
      const status = getErrorStatus(error)
      // A 404/410 against a valid app JWT is definitive: the app is not installed
      // there any more. Park the row in `error` (not inactive) so settings offers
      // Reconnect and the CP routes survive a reinstall on the same id.
      if (status === 404 || status === 410) {
        log.warn({ workspaceId, installationId: record.installationId }, "GitHub installation no longer exists")
        await this.markGithubInstallationError(workspaceId, record)
        return { ok: false, failure: "installation_gone" }
      }
      log.warn({ err: error, workspaceId }, "GitHub sync network call failed")
      return { ok: false, failure: "network" }
    }

    const encryptedCredentials = encryptJson(
      this.deps.github.integrationSecret,
      { installationId: credentials.installationId, accessToken, tokenExpiresAt },
      { workspaceId, provider: WorkspaceIntegrationProviders.GITHUB }
    )

    const persistSync = async (base: WorkspaceIntegrationRecord): Promise<WorkspaceIntegrationRecord | null> => {
      const baseMetadata = this.parseMetadata(base.metadata)
      const nextMetadata: GitHubIntegrationMetadata = {
        ...baseMetadata,
        organizationName: snapshot.accountLogin ?? baseMetadata.organizationName,
        accountType: snapshot.accountType ?? baseMetadata.accountType,
        repositorySelection: snapshot.repositorySelection ?? baseMetadata.repositorySelection,
        configurationUrl: snapshot.configurationUrl ?? baseMetadata.configurationUrl,
        permissions: Object.keys(tokenPermissions).length > 0 ? tokenPermissions : baseMetadata.permissions,
        repositories,
      }
      return WorkspaceIntegrationRepository.update(
        this.deps.pool,
        workspaceId,
        WorkspaceIntegrationProviders.GITHUB,
        base.installationId,
        { credentials: encryptedCredentials, metadata: nextMetadata },
        {
          expectedStatus: WorkspaceIntegrationStatuses.ACTIVE,
          expectedVersion: base.version,
        }
      )
    }

    let updated = await persistSync(record)
    if (!updated) {
      const reread = await WorkspaceIntegrationRepository.findByWorkspaceAndId(this.deps.pool, workspaceId, record.id)
      if (reread && reread.status === WorkspaceIntegrationStatuses.ACTIVE) {
        updated = await persistSync(reread)
      }
    }
    if (!updated) {
      return { ok: false, failure: "conflict" }
    }

    return { ok: true, record: updated }
  }

  /**
   * Park an installation GitHub no longer knows in `error`. Scoped to the
   * installation observed at read and guarded on ACTIVE, so a row that
   * disconnected or reconnected elsewhere in the meantime is left alone.
   */
  private async markGithubInstallationError(workspaceId: string, record: WorkspaceIntegrationRecord): Promise<void> {
    await WorkspaceIntegrationRepository.update(
      this.deps.pool,
      workspaceId,
      WorkspaceIntegrationProviders.GITHUB,
      record.installationId,
      { status: WorkspaceIntegrationStatuses.ERROR },
      { expectedStatus: WorkspaceIntegrationStatuses.ACTIVE }
    )
  }

  /**
   * Installation identity and repository-grant mode, straight from GitHub. The
   * `html_url` it returns is the page where that grant is edited — the target of
   * the settings "Configure on GitHub" link.
   */
  private async fetchGithubInstallationSnapshot(installationId: number): Promise<GitHubInstallationSnapshot> {
    const installation = await this.getAppOctokit().request("GET /app/installations/{installation_id}", {
      installation_id: installationId,
    })
    const accountType = normalizeGithubAccountType(
      getInstallationAccountType(installation.data.account) ?? installation.data.target_type ?? null
    )
    const accountLogin = getInstallationAccountLogin(installation.data.account)
    return {
      accountLogin,
      accountType,
      repositorySelection: normalizeRepositorySelection(installation.data.repository_selection),
      configurationUrl:
        normalizeGithubConfigurationUrl(installation.data.html_url) ??
        deriveInstallationConfigurationUrl(String(installationId), accountType, accountLogin),
      permissions: normalizePermissions(installation.data.permissions),
    }
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
   * Resolve a GitHub client for a workspace across its N installations.
   *
   * `repoOwner` (a repository's owner login) prefers the installation whose
   * account login matches it: that install is the ONLY candidate — its quota is
   * never borrowed by a sibling. A near-limit owner-matched install returns
   * `null` (hard breaker) regardless of the fallback flag, because handing back a
   * sibling or anonymous client would silently downgrade a heavy user to the
   * shared per-IP quota and mask the rate-limit state (surfaced as
   * GITHUB_NOT_CONNECTED).
   *
   * With no `repoOwner` (or no matching install), any active non-throttled
   * install serves the request — installation tokens read public repos too. When
   * every active install is throttled the breaker returns `null`; when none
   * yields a usable client (undecryptable/unrefreshable) it falls back.
   *
   * When `allowUnauthenticatedFallback` is set, the fallback paths (no app, no
   * active install, nothing usable) return an anonymous client that still reads
   * public/open-source repos instead of `null`. Callers wanting only
   * authenticated access (link-preview enrichment) omit the flag.
   */
  async getGithubClient(
    workspaceId: string,
    options: { repoOwner?: string; allowUnauthenticatedFallback?: boolean } = {}
  ): Promise<GitHubClient | null> {
    const fallback = () => (options.allowUnauthenticatedFallback ? GitHubClient.anonymous(this, workspaceId) : null)

    if (!this.app) return fallback()

    const activeRecords = (
      await WorkspaceIntegrationRepository.listByWorkspaceAndProvider(
        this.deps.pool,
        workspaceId,
        WorkspaceIntegrationProviders.GITHUB
      )
    ).filter((record) => record.status === WorkspaceIntegrationStatuses.ACTIVE)
    if (activeRecords.length === 0) return fallback()

    if (options.repoOwner) {
      const owner = options.repoOwner.toLowerCase()
      const matched = activeRecords.find(
        (record) => this.parseMetadata(record.metadata).organizationName?.toLowerCase() === owner
      )
      if (matched) {
        if (this.isNearGithubRateLimit(this.parseMetadata(matched.metadata))) return null
        return (await this.buildGithubClientFromRecord(workspaceId, matched)) ?? fallback()
      }
    }

    let allThrottled = true
    for (const record of activeRecords) {
      if (this.isNearGithubRateLimit(this.parseMetadata(record.metadata))) continue
      allThrottled = false
      const client = await this.buildGithubClientFromRecord(workspaceId, record)
      if (client) return client
    }
    if (allThrottled) return null
    return fallback()
  }

  /**
   * Build a client for one active install: parse credentials (undecryptable →
   * null), proactively refresh a near-expiry token (refresh failure → null), else
   * a client bound to this record so its 401-refresh/rate-limit CAS hit the right row.
   */
  private async buildGithubClientFromRecord(
    workspaceId: string,
    record: WorkspaceIntegrationRecord
  ): Promise<GitHubClient | null> {
    let credentials: GitHubIntegrationCredentials
    try {
      credentials = this.parseCredentials(workspaceId, record.credentials)
    } catch (error) {
      log.warn({ err: error, workspaceId }, "GitHub integration credentials could not be decrypted")
      return null
    }

    if (this.shouldRefreshToken(credentials.tokenExpiresAt)) {
      const refreshed = await this.refreshGithubCredentialsForClient(workspaceId, record)
      if (!refreshed) return null
      return new GitHubClient(this, workspaceId, refreshed.record, refreshed.credentials, refreshed.metadata)
    }

    return new GitHubClient(this, workspaceId, record, credentials, this.parseMetadata(record.metadata))
  }

  async updateGithubRateLimitMetadata(
    workspaceId: string,
    metadata: GitHubIntegrationMetadata,
    installationScope: string | null,
    remaining: number | null,
    resetAt: string | null,
    expectedVersion?: number
  ): Promise<{ metadata: GitHubIntegrationMetadata; version: number | null }> {
    const nextMetadata: GitHubIntegrationMetadata = {
      ...metadata,
      rateLimitRemaining: remaining,
      rateLimitResetAt: resetAt,
    }

    // CACHE WRITE — version-CAS. This replaces the WHOLE metadata object, so a
    // stale rate-limit write must not erase a newer concurrent write (e.g. a
    // repo-sync that just refreshed `repositories`). Scoped to the client's
    // observed installation so it lands on the right row of an N-install
    // workspace. A lost race matches 0 rows; keep the client's prior metadata
    // rather than pretending the write stuck.
    const updated = await WorkspaceIntegrationRepository.update(
      this.deps.pool,
      workspaceId,
      WorkspaceIntegrationProviders.GITHUB,
      installationScope,
      { metadata: nextMetadata },
      {
        expectedStatus: WorkspaceIntegrationStatuses.ACTIVE,
        expectedVersion,
      }
    )

    // Return the new version on a win so a reused client (memoized agent turn,
    // multi-call preview) advances its cached version and its NEXT capture CASes
    // on the fresh generation instead of self-colliding on the frozen one and
    // dropping every reading after the first (which would starve the near-limit
    // breaker). `null` on a loss — the client keeps its version and defers to the
    // concurrent writer that actually advanced the row.
    return updated ? { metadata: nextMetadata, version: updated.version } : { metadata, version: null }
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

    // Both organizations and personal accounts are accepted; the account type is
    // captured into metadata so the settings UI can badge each install.
    const snapshot = await this.fetchGithubInstallationSnapshot(installationId)

    // Base the write on the existing row for THIS installation (multi-install: a
    // workspace can hold several), else a fresh default record for a first install.
    const existingInstalls = await WorkspaceIntegrationRepository.listByWorkspaceAndProvider(
      this.deps.pool,
      workspaceId,
      WorkspaceIntegrationProviders.GITHUB
    )
    const baseRecord = existingInstalls.find((record) => record.installationId === String(installationId)) ?? {
      id: workspaceIntegrationId(),
      workspaceId,
      provider: WorkspaceIntegrationProviders.GITHUB,
      status: WorkspaceIntegrationStatuses.INACTIVE,
      credentials: {},
      metadata: {},
      installedBy: installedByUserId,
      installationId: null,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    const refreshed = await this.refreshGithubCredentials(
      workspaceId,
      baseRecord,
      installationId,
      {
        organizationName: snapshot.accountLogin,
        accountType: snapshot.accountType,
        repositorySelection: snapshot.repositorySelection,
        configurationUrl: snapshot.configurationUrl,
        permissions: snapshot.permissions,
        repositories: [],
        rateLimitRemaining: null,
        rateLimitResetAt: null,
      },
      installedByUserId,
      true,
      String(installationId)
    )

    if (!refreshed) {
      throw new HttpError("Failed to activate GitHub integration", {
        status: 502,
        code: "GITHUB_INTEGRATION_ACTIVATION_FAILED",
      })
    }
  }

  /**
   * Commit a durable `github_route:register` event so `GithubRouteSyncHandler`
   * registers this workspace's installation in the control-plane routing table.
   * Emitted only when a region is configured (production); local single-region
   * dev has no control plane and nothing to route, so it degrades to a debug log.
   */
  private async emitRouteRegister(client: Querier, workspaceId: string, installationId: string): Promise<void> {
    const region = this.deps.region
    if (!region) {
      log.debug({ workspaceId, installationId }, "Skipping GitHub route register event — no region configured")
      return
    }
    await OutboxRepository.insert(client, "github_route:register", { workspaceId, installationId, region })
  }

  private async emitRouteUnregister(client: Querier, workspaceId: string, installationId: string): Promise<void> {
    const region = this.deps.region
    if (!region) {
      log.debug({ workspaceId, installationId }, "Skipping GitHub route unregister event — no region configured")
      return
    }
    await OutboxRepository.insert(client, "github_route:unregister", { workspaceId, installationId, region })
  }

  private async refreshGithubCredentials(
    workspaceId: string,
    record: WorkspaceIntegrationRecord,
    installationId: number,
    metadata: GitHubIntegrationMetadata,
    installedByOverride?: string,
    hydrateRepositories = false,
    /** When set, atomically replace the integration and synchronize its CP route. */
    routeInstallationId?: string
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

      const upsertParams = {
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
        installationId: String(installationId),
      }

      const updated = await this.persistGithubIntegration(
        upsertParams,
        record.installationId,
        routeInstallationId,
        record.version
      )
      if (!updated) {
        return null
      }

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

  /** Persist after all network work; install route events commit with the row. */
  private async persistGithubIntegration(
    params: UpsertWorkspaceIntegrationParams,
    installationScope: string | null,
    routeInstallationId?: string,
    expectedVersion?: number
  ): Promise<WorkspaceIntegrationRecord | null> {
    if (!routeInstallationId) {
      // CREDENTIAL WRITE (token refresh, no route change) — version-CAS. A blind
      // upsert here would resurrect a row a concurrent disconnect just cleared,
      // or clobber a row that reconnected to a DIFFERENT installation B back to A.
      // Scoped to the base record's installation_id column read before the token
      // round-trip (NULL for a pre-backfill row), guarded on status ACTIVE AND the
      // version read at the same point so a stale refresh can't overwrite a newer
      // same-row write (INV-66). A lost race matches 0 rows and surfaces as a
      // refresh failure the callers (401 retry, proactive refresh) already handle.
      return WorkspaceIntegrationRepository.update(
        this.deps.pool,
        params.workspaceId,
        WorkspaceIntegrationProviders.GITHUB,
        installationScope,
        {
          credentials: params.credentials,
          metadata: params.metadata,
          installedBy: params.installedBy,
          installationId: params.installationId,
        },
        {
          expectedStatus: WorkspaceIntegrationStatuses.ACTIVE,
          expectedVersion,
        }
      )
    }

    // LIFECYCLE WRITE (install) — NO version-CAS. This upsert expresses an absolute
    // install intent and serializes on the workspace lock; a concurrent background
    // refresh's version bump must not make it lose. Installs are additive: N rows
    // per (workspace, provider), so a new installation never unregisters a sibling.

    // Lock the workspace rather than the provider row: two first-time installs
    // must serialize even when no workspace_integrations row exists yet.
    return withTransaction(this.deps.pool, async (client) => {
      await WorkspaceIntegrationRepository.lockWorkspace(client, params.workspaceId)
      const updated = await WorkspaceIntegrationRepository.upsert(client, params)
      await this.emitRouteRegister(client, params.workspaceId, routeInstallationId)
      return updated
    })
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
      accountType: normalizeGithubAccountType(payload.accountType),
      repositorySelection: normalizeRepositorySelection(payload.repositorySelection),
      configurationUrl: normalizeGithubConfigurationUrl(payload.configurationUrl),
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
    if (!record) return

    try {
      const credentials = this.parseLinearCredentials(workspaceId, record.credentials)
      await revokeLinearToken({ accessToken: credentials.accessToken })
    } catch (error) {
      log.warn({ err: error, workspaceId }, "Linear token revocation failed; continuing with local disconnect")
    }

    // Scope to the installation_id column observed before the network call so a
    // disconnect for org A can't clobber a row that reconnected to a DIFFERENT org
    // B in between (INV-20). Not guarded on status — a disconnect must clear a row
    // in any status (active/error). A NULL scope covers a pre-column row whose
    // installation_id is still NULL.
    await WorkspaceIntegrationRepository.update(
      this.deps.pool,
      workspaceId,
      WorkspaceIntegrationProviders.LINEAR,
      record.installationId,
      {
        status: WorkspaceIntegrationStatuses.INACTIVE,
        credentials: {},
        metadata: {},
      }
    )
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
    installationScope: string | null,
    rateLimit: LinearRateLimit,
    expectedVersion?: number
  ): Promise<{ metadata: LinearIntegrationMetadata; version: number | null }> {
    const nextMetadata: LinearIntegrationMetadata = { ...metadata, rateLimit }

    // CACHE WRITE — version-CAS. This replaces the whole metadata object, so
    // guard on active status + the installation_id COLUMN value the client read
    // with its record (INV-20 — NULL for a legacy pre-population row, which
    // metadata.organizationId would miss) AND the version read at the same point
    // (INV-66): a stale rate-limit write can't land on a row a concurrent
    // disconnect cleared, a row reconnected to a different org, or a row a newer
    // same-org write already advanced. A lost race matches 0 rows; keep the
    // client's prior metadata rather than pretending the write stuck.
    const updated = await WorkspaceIntegrationRepository.update(
      this.deps.pool,
      workspaceId,
      WorkspaceIntegrationProviders.LINEAR,
      installationScope,
      { metadata: nextMetadata },
      {
        expectedStatus: WorkspaceIntegrationStatuses.ACTIVE,
        expectedVersion,
      }
    )

    // Return the new version on a win so a reused client advances its cached
    // version and its next capture CASes on the fresh generation rather than
    // self-colliding on the frozen one (see updateGithubRateLimitMetadata).
    return updated ? { metadata: nextMetadata, version: updated.version } : { metadata, version: null }
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
      await this.markLinearIntegrationError(workspaceId, record)
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
      await this.markLinearIntegrationError(workspaceId, record)
      return null
    }

    return this.persistLinearCredentials(workspaceId, record, tokens, metadata, { isInstall: false })
  }

  /**
   * Flip a broken Linear integration to ERROR. CREDENTIAL WRITE — version-CAS.
   * Guarded on active status + the observed org (INV-20) AND the version read
   * with the record (INV-66) so it can't resurrect a row a concurrent disconnect
   * already cleared, stamp ERROR onto a row reconnected to a different org, or
   * clobber a newer same-org write. A background error flip; a 0-row miss is a
   * no-op (nothing to surface).
   */
  private async markLinearIntegrationError(workspaceId: string, record: WorkspaceIntegrationRecord): Promise<void> {
    await WorkspaceIntegrationRepository.update(
      this.deps.pool,
      workspaceId,
      WorkspaceIntegrationProviders.LINEAR,
      record.installationId,
      { status: WorkspaceIntegrationStatuses.ERROR },
      {
        expectedStatus: WorkspaceIntegrationStatuses.ACTIVE,
        expectedVersion: record.version,
      }
    )
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
      installationId: null,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    await this.persistLinearCredentials(workspaceId, baseRecord, tokens, metadata, {
      installedByOverride: installedByUserId,
      isInstall: true,
    })
  }

  /**
   * Persist Linear credentials after the OAuth round-trip.
   *
   * `isInstall` (first-time authorize / re-authorize) creates or replaces the row
   * via an id-keyed upsert (ON CONFLICT (id)) so a reconnect to a different Linear
   * org rewrites the single Linear row in place rather than colliding on the
   * primary key — Linear stores its org id in `installation_id`, so an
   * installation-keyed arbiter would miss on an org switch and hit the PK. The
   * refresh path instead runs a guarded UPDATE scoped to the installation_id read
   * with the record: a blind upsert there would resurrect a row a concurrent
   * disconnect just cleared, or clobber a row reconnected to a different Linear org
   * back to this one (INV-20). A lost race matches 0 rows and returns null, which
   * callers (401 retry, proactive refresh) already handle as a refresh failure.
   */
  private async persistLinearCredentials(
    workspaceId: string,
    record: WorkspaceIntegrationRecord,
    tokens: LinearOAuthTokenResponse,
    metadata: LinearIntegrationMetadata,
    options: { installedByOverride?: string; isInstall: boolean }
  ): Promise<LinearRefreshResult | null> {
    const credentials: LinearIntegrationCredentials = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenType: tokens.tokenType,
      tokenExpiresAt: expiresAtFromNow(tokens.expiresIn),
      scope: tokens.scope,
      actor: "app",
    }
    const encryptedCredentials = encryptJson(this.deps.linear.integrationSecret, credentials, {
      workspaceId,
      provider: WorkspaceIntegrationProviders.LINEAR,
    })
    const organizationId = metadata.organizationId

    if (options.isInstall) {
      // Serialize on the workspace lock and re-read the row inside it: the id
      // arbiter cannot dedupe two concurrent FIRST-TIME connects (two fresh ULIDs
      // both insert cleanly), so without the lock a workspace could end up with
      // two Linear rows for different orgs. Mirrors persistGithubIntegration's
      // lifecycle branch.
      const updated = await withTransaction(this.deps.pool, async (client) => {
        await WorkspaceIntegrationRepository.lockWorkspace(client, workspaceId)
        const existing = await WorkspaceIntegrationRepository.findByWorkspaceAndProvider(
          client,
          workspaceId,
          WorkspaceIntegrationProviders.LINEAR
        )
        return WorkspaceIntegrationRepository.upsert(
          client,
          {
            id: existing?.id ?? record.id,
            workspaceId,
            provider: WorkspaceIntegrationProviders.LINEAR,
            status: WorkspaceIntegrationStatuses.ACTIVE,
            credentials: encryptedCredentials,
            metadata,
            installedBy: options.installedByOverride ?? record.installedBy,
            installationId: organizationId,
          },
          "id"
        )
      })
      return { record: updated, credentials, metadata }
    }

    // Refresh path — CREDENTIAL WRITE, version-CAS. Scoped to the installation_id
    // column read with the record (NULL for a pre-population row), so even a
    // malformed legacy client cannot overwrite a concurrently reconnected row that
    // shifted the column to a populated org id. The version read with the record
    // (INV-66) additionally stops a stale refresh clobbering a newer same-org write.
    // A 0-row miss returns null, which callers (401 retry, proactive refresh) handle
    // as a refresh failure.
    const updated = await WorkspaceIntegrationRepository.update(
      this.deps.pool,
      workspaceId,
      WorkspaceIntegrationProviders.LINEAR,
      record.installationId,
      {
        status: WorkspaceIntegrationStatuses.ACTIVE,
        credentials: encryptedCredentials,
        metadata,
        installedBy: options.installedByOverride ?? record.installedBy,
        installationId: organizationId,
      },
      {
        expectedStatus: WorkspaceIntegrationStatuses.ACTIVE,
        expectedVersion: record.version,
      }
    )
    if (!updated) return null
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

/** Only github.com URLs are accepted, so a poisoned metadata blob can't become an outbound link. */
function normalizeGithubConfigurationUrl(value: unknown): string | null {
  if (typeof value !== "string") return null
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.hostname === "github.com" ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * Where GitHub hosts an installation's repository-access settings. Preferred
 * source is the installation's own `html_url`; this reproduces it for rows that
 * predate capturing it, so an existing install gets a working link without first
 * being synced. Both shapes are fixed by GitHub: personal installs live under the
 * viewer's own settings, org installs under the org's.
 */
function deriveInstallationConfigurationUrl(
  installationId: string | null,
  accountType: "Organization" | "User" | null,
  accountLogin: string | null
): string | null {
  if (!installationId) return null
  if (accountType === "User") return `https://github.com/settings/installations/${installationId}`
  if (accountType === "Organization" && accountLogin) {
    return `https://github.com/organizations/${encodeURIComponent(accountLogin)}/settings/installations/${installationId}`
  }
  return null
}

function getInstallationAccountType(account: unknown): string | null {
  if (!account || typeof account !== "object") return null
  const type = (account as { type?: unknown }).type
  return typeof type === "string" ? type : null
}

function normalizeGithubAccountType(value: unknown): "Organization" | "User" | null {
  return value === "Organization" || value === "User" ? value : null
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
