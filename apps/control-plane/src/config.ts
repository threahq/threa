import { logger, type WorkosConfig } from "@threa/backend-common"

export interface RegionConfig {
  internalUrl: string
}

export interface CloudflareKvConfig {
  accountId: string
  namespaceId: string
  apiToken: string
}

export interface ControlPlaneConfig {
  port: number
  databaseUrl: string
  useStubAuth: boolean
  corsAllowedOrigins: string[]
  workos: WorkosConfig
  internalApiKey: string
  regions: Record<string, RegionConfig>
  cloudflareKv: CloudflareKvConfig | null
  workspaceCreationRequiresInvite: boolean
  fastShutdown: boolean
  /**
   * WorkOS user IDs to auto-seed into `platform_roles` with role='admin' on
   * startup. Comma-separated `PLATFORM_ADMIN_WORKOS_USER_IDS` env var.
   * Idempotent: re-running the server with the same value is a no-op.
   */
  platformAdminWorkosUserIds: string[]
  /** Base URL of the frontend app. Used for post-auth redirects when the frontend is on a different origin. */
  frontendUrl: string
  /**
   * WorkOS dashboard environment id (e.g. `environment_01KA3BVADMEYB99HGDHBJM1SE7`).
   * Optional. Surfaced through the backoffice config endpoint so the
   * platform-admin UI can render direct links into the WorkOS dashboard.
   *
   * The WorkOS Node SDK has no introspection API for this — it lives only in
   * the dashboard URL — so we set it explicitly per environment via
   * `WORKOS_ENVIRONMENT_ID`. Null when unset; the backoffice falls back to
   * plain text instead of a link.
   */
  workosEnvironmentId: string | null
  /** Allowed domain for forwarded-host redirects (e.g. "staging.threa.io"). Empty disables the feature. */
  allowedRedirectDomain: string
  /**
   * Forwarded hosts that should receive a dedicated WorkOS redirect URI
   * (`https://${host}/api/auth/callback`) instead of the default
   * `WORKOS_REDIRECT_URI`. Use this when an origin can't share cookies with
   * the default redirect host (e.g. the backoffice at admin.threa.io when the
   * main app is on a different TLD). Comma-separated env var
   * `WORKOS_DEDICATED_REDIRECT_HOSTS`.
   *
   * Every host listed here must be registered as an allowed redirect URI in
   * the WorkOS dashboard for the active client, otherwise WorkOS will reject
   * the authorize call with "invalid_redirect_uri".
   */
  workosDedicatedRedirectHosts: string[]
  rateLimits: {
    globalMax: number
    authMax: number
  }
  waitlist: {
    /**
     * Resend API key for the waitlist confirmation email. Null falls back to a
     * stub sender that logs instead of sending — the signup still succeeds.
     */
    resendApiKey: string | null
    /** From address for the confirmation (a verified Resend sender/domain). */
    fromEmail: string
  }
}

export function loadControlPlaneConfig(): ControlPlaneConfig {
  const isProduction = process.env.NODE_ENV === "production"
  const useStubAuth = process.env.USE_STUB_AUTH === "true"

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required")
  }

  if (isProduction && useStubAuth) {
    throw new Error("USE_STUB_AUTH must be false in production")
  }

  if (isProduction && !process.env.CORS_ALLOWED_ORIGINS) {
    throw new Error("CORS_ALLOWED_ORIGINS is required in production")
  }

  if (!useStubAuth) {
    const required = ["WORKOS_API_KEY", "WORKOS_CLIENT_ID", "WORKOS_REDIRECT_URI", "WORKOS_COOKIE_PASSWORD"]
    const missing = required.filter((key) => !process.env[key])
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(", ")}`)
    }
  }

  const regionsRaw = process.env.REGIONS
  let regions: Record<string, RegionConfig> = {}
  if (regionsRaw) {
    try {
      regions = JSON.parse(regionsRaw)
    } catch {
      throw new Error("REGIONS must be valid JSON: Record<string, { internalUrl: string }>")
    }
  }

  if (!process.env.INTERNAL_API_KEY) {
    throw new Error("INTERNAL_API_KEY is required")
  }

  const corsAllowedOrigins = process.env.CORS_ALLOWED_ORIGINS
    ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((s) => s.trim())
    : ["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:5173"]

  // Cloudflare KV — required in production, noop client in dev
  let cloudflareKv: CloudflareKvConfig | null = null
  if (process.env.CLOUDFLARE_KV_ACCOUNT_ID) {
    const namespaceId = process.env.CLOUDFLARE_KV_NAMESPACE_ID
    const apiToken = process.env.CLOUDFLARE_KV_API_TOKEN
    if (!namespaceId || !apiToken) {
      throw new Error(
        "CLOUDFLARE_KV_ACCOUNT_ID is set but CLOUDFLARE_KV_NAMESPACE_ID and CLOUDFLARE_KV_API_TOKEN are also required"
      )
    }
    cloudflareKv = {
      accountId: process.env.CLOUDFLARE_KV_ACCOUNT_ID,
      namespaceId,
      apiToken,
    }
  } else if (isProduction) {
    throw new Error("CLOUDFLARE_KV_ACCOUNT_ID is required in production")
  }

  const config: ControlPlaneConfig = {
    port: Number(process.env.PORT) || 3003,
    databaseUrl: process.env.DATABASE_URL,
    useStubAuth,
    corsAllowedOrigins,
    workos: {
      apiKey: process.env.WORKOS_API_KEY || "",
      clientId: process.env.WORKOS_CLIENT_ID || "",
      redirectUri: process.env.WORKOS_REDIRECT_URI || "",
      cookiePassword: process.env.WORKOS_COOKIE_PASSWORD || "",
    },
    internalApiKey: process.env.INTERNAL_API_KEY,
    regions,
    cloudflareKv,
    workspaceCreationRequiresInvite: process.env.WORKSPACE_CREATION_SKIP_INVITE !== "true",
    fastShutdown: process.env.FAST_SHUTDOWN === "true",
    platformAdminWorkosUserIds: (process.env.PLATFORM_ADMIN_WORKOS_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    frontendUrl: (process.env.FRONTEND_URL ?? "").replace(/\/+$/, ""),
    workosEnvironmentId: process.env.WORKOS_ENVIRONMENT_ID?.trim() || null,
    allowedRedirectDomain: process.env.ALLOWED_REDIRECT_DOMAIN ?? "",
    workosDedicatedRedirectHosts: (process.env.WORKOS_DEDICATED_REDIRECT_HOSTS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    rateLimits: {
      globalMax: Number(process.env.GLOBAL_RATE_LIMIT_MAX) || 300,
      authMax: Number(process.env.AUTH_RATE_LIMIT_MAX) || 20,
    },
    waitlist: {
      resendApiKey: process.env.RESEND_API_KEY?.trim() || null,
      fromEmail: process.env.WAITLIST_FROM_EMAIL?.trim() || "Threa <hello@threa.io>",
    },
  }

  if (useStubAuth) {
    logger.warn("Control plane: Using stub auth service - NOT FOR PRODUCTION")
  }

  if (isProduction && !config.waitlist.resendApiKey) {
    logger.warn("Control plane: RESEND_API_KEY unset — waitlist confirmation emails will not send")
  }

  return config
}
