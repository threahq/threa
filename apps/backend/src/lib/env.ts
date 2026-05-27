import { logger } from "./logger"
import type { WorkosConfig } from "@threa/backend-common"

export type { WorkosConfig } from "@threa/backend-common"

export interface AIConfig {
  openRouterApiKey: string
  /** Tavily API key for web search */
  tavilyApiKey: string
  /** ElevenLabs API key for realtime speech-to-text (voice dictation). Empty string disables voice. */
  elevenLabsApiKey: string
  /** Deepgram API key for realtime speech-to-text. Empty string disables Deepgram as a voice provider. */
  deepgramApiKey: string
  /** Model for stream auto-naming, in provider:model format (e.g., "openrouter:anthropic/claude-haiku-4.5") */
  namingModel: string
  /** Model for conversational boundary extraction, in provider:model format */
  extractionModel: string
}

export interface S3Config {
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** Optional endpoint for S3-compatible services (MinIO, R2, etc.) */
  endpoint?: string
}

export interface AttachmentSafetyConfig {
  /** Whether malware scanning is enabled for uploaded files. */
  malwareScanEnabled: boolean
}

export interface PushConfig {
  vapidPublicKey: string
  vapidPrivateKey: string
  /** mailto: URI for VAPID identification */
  vapidSubject: string
  enabled: boolean
}

export interface GitHubAppConfig {
  enabled: boolean
  appId: string
  appSlug: string
  privateKey: string
  integrationSecret: string
}

export interface LinearOAuthConfig {
  enabled: boolean
  clientId: string
  clientSecret: string
  /** Global (workspace-less) callback registered with Linear's OAuth app. */
  redirectUri: string
  /** Shared with GitHub: HMAC secret for signing install state round-trips. */
  integrationSecret: string
}

export interface MediaConvertConfig {
  /** IAM role ARN that MediaConvert assumes to access S3 */
  roleArn: string
  /** MediaConvert API endpoint (discovered via DescribeEndpoints, cached at runtime) */
  endpoint?: string
  /** Whether video transcoding is enabled (false in dev/test by default) */
  enabled: boolean
}

export interface Config {
  port: number
  databaseUrl: string
  /** Skip graceful shutdown for immediate termination (dev/test environments) */
  fastShutdown: boolean
  workspaceCreationRequiresInvite: boolean
  useStubAuth: boolean
  useStubCompanion: boolean
  useStubBoundaryExtraction: boolean
  /** Stub all AI features (naming, embedding, memo processing) */
  useStubAI: boolean
  /** Allowed CORS origins. In production, must be explicitly configured. */
  corsAllowedOrigins: string[]
  rateLimits: {
    globalMax: number
    authMax: number
  }
  workos: WorkosConfig
  ai: AIConfig
  s3: S3Config
  attachments: AttachmentSafetyConfig
  push: PushConfig
  github: GitHubAppConfig
  linear: LinearOAuthConfig
  mediaConvert: MediaConvertConfig
  /** Control-plane URL for inter-service communication (optional — only needed in multi-region) */
  controlPlaneUrl: string | null
  /** Shared secret for authenticating internal API calls from the control-plane */
  internalApiKey: string | null
  /** This instance's region name (e.g., "eu-north-1") */
  region: string | null
}

export function loadConfig(): Config {
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

  const useStubCompanion = process.env.USE_STUB_COMPANION === "true"
  const useStubBoundaryExtraction = process.env.USE_STUB_BOUNDARY_EXTRACTION === "true"
  const useStubAI = process.env.USE_STUB_AI === "true"
  const fastShutdown = process.env.FAST_SHUTDOWN === "true"

  const corsAllowedOrigins = process.env.CORS_ALLOWED_ORIGINS
    ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((s) => s.trim())
    : ["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:5173"]

  const config: Config = {
    port: Number(process.env.PORT) || 3001,
    databaseUrl: process.env.DATABASE_URL,
    fastShutdown,
    workspaceCreationRequiresInvite: process.env.WORKSPACE_CREATION_SKIP_INVITE !== "true",
    useStubAuth,
    useStubCompanion,
    useStubBoundaryExtraction,
    useStubAI,
    corsAllowedOrigins,
    rateLimits: {
      globalMax: Number(process.env.GLOBAL_RATE_LIMIT_MAX) || 300,
      authMax: Number(process.env.AUTH_RATE_LIMIT_MAX) || 20,
    },
    workos: {
      apiKey: process.env.WORKOS_API_KEY || "",
      clientId: process.env.WORKOS_CLIENT_ID || "",
      redirectUri: process.env.WORKOS_REDIRECT_URI || "",
      cookiePassword: process.env.WORKOS_COOKIE_PASSWORD || "",
    },
    ai: {
      openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
      tavilyApiKey: process.env.TAVILY_API_KEY || "",
      elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || "",
      deepgramApiKey: process.env.DEEPGRAM_API_KEY || "",
      namingModel: process.env.AI_NAMING_MODEL || "openrouter:openai/gpt-5-mini",
      extractionModel: process.env.AI_EXTRACTION_MODEL || "openrouter:openai/gpt-5-mini",
    },
    s3: {
      bucket: process.env.S3_BUCKET || "threa-uploads",
      region: process.env.S3_REGION || "us-east-1",
      accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
      endpoint: process.env.S3_ENDPOINT,
    },
    attachments: {
      malwareScanEnabled: process.env.ATTACHMENT_MALWARE_SCAN_ENABLED !== "false",
    },
    push: {
      vapidPublicKey: process.env.VAPID_PUBLIC_KEY || "",
      vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || "",
      vapidSubject: process.env.VAPID_SUBJECT || "",
      enabled: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT),
    },
    github: {
      enabled: !!(
        process.env.GITHUB_APP_ID &&
        process.env.GITHUB_APP_SLUG &&
        process.env.GITHUB_APP_PRIVATE_KEY &&
        process.env.WORKSPACE_INTEGRATIONS_SECRET
      ),
      appId: process.env.GITHUB_APP_ID || "",
      appSlug: process.env.GITHUB_APP_SLUG || "",
      privateKey: (process.env.GITHUB_APP_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
      integrationSecret: process.env.WORKSPACE_INTEGRATIONS_SECRET || "",
    },
    linear: {
      enabled: !!(
        process.env.LINEAR_OAUTH_CLIENT_ID &&
        process.env.LINEAR_OAUTH_CLIENT_SECRET &&
        process.env.LINEAR_OAUTH_REDIRECT_URI &&
        process.env.WORKSPACE_INTEGRATIONS_SECRET
      ),
      clientId: process.env.LINEAR_OAUTH_CLIENT_ID || "",
      clientSecret: process.env.LINEAR_OAUTH_CLIENT_SECRET || "",
      redirectUri: process.env.LINEAR_OAUTH_REDIRECT_URI || "",
      integrationSecret: process.env.WORKSPACE_INTEGRATIONS_SECRET || "",
    },
    mediaConvert: {
      roleArn: process.env.MEDIACONVERT_ROLE_ARN || "",
      endpoint: process.env.MEDIACONVERT_ENDPOINT || undefined,
      enabled: process.env.MEDIACONVERT_ENABLED === "true",
    },
    controlPlaneUrl: process.env.CONTROL_PLANE_URL || null,
    internalApiKey: process.env.INTERNAL_API_KEY || null,
    region: process.env.REGION || null,
  }

  // Validate co-presence: VAPID vars must all be set or all be absent (INV-11)
  const vapidVars = [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY, process.env.VAPID_SUBJECT]
  const vapidSetCount = vapidVars.filter(Boolean).length
  if (vapidSetCount > 0 && vapidSetCount < 3) {
    throw new Error(
      "VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT must all be set together — push notifications require all three"
    )
  }

  const githubVars = [
    process.env.GITHUB_APP_ID,
    process.env.GITHUB_APP_SLUG,
    process.env.GITHUB_APP_PRIVATE_KEY,
    process.env.WORKSPACE_INTEGRATIONS_SECRET,
  ]
  const githubSetCount = githubVars.filter(Boolean).length
  if (githubSetCount > 0 && githubSetCount < githubVars.length) {
    throw new Error(
      "GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY, and WORKSPACE_INTEGRATIONS_SECRET must all be set together"
    )
  }

  // Linear OAuth credentials must be co-present. WORKSPACE_INTEGRATIONS_SECRET is shared with
  // GitHub and excluded from the per-provider check so either provider can be enabled alone.
  const linearProviderVars = [
    process.env.LINEAR_OAUTH_CLIENT_ID,
    process.env.LINEAR_OAUTH_CLIENT_SECRET,
    process.env.LINEAR_OAUTH_REDIRECT_URI,
  ]
  const linearSetCount = linearProviderVars.filter(Boolean).length
  if (linearSetCount > 0 && linearSetCount < linearProviderVars.length) {
    throw new Error(
      "LINEAR_OAUTH_CLIENT_ID, LINEAR_OAUTH_CLIENT_SECRET, and LINEAR_OAUTH_REDIRECT_URI must all be set together"
    )
  }
  if (linearSetCount === linearProviderVars.length && !process.env.WORKSPACE_INTEGRATIONS_SECRET) {
    throw new Error("WORKSPACE_INTEGRATIONS_SECRET is required when Linear OAuth credentials are configured")
  }

  if (config.mediaConvert.enabled && !config.mediaConvert.roleArn) {
    throw new Error("MEDIACONVERT_ROLE_ARN is required when MEDIACONVERT_ENABLED=true")
  }
  if (!config.mediaConvert.enabled && (config.mediaConvert.roleArn || config.mediaConvert.endpoint)) {
    throw new Error("MEDIACONVERT_ENABLED=true is required when MediaConvert role ARN or endpoint is configured")
  }

  // Validate co-presence: REGION and INTERNAL_API_KEY are required when CONTROL_PLANE_URL is set (INV-11)
  if (config.controlPlaneUrl && !config.region) {
    throw new Error(
      "REGION is required when CONTROL_PLANE_URL is set — shadow sync needs to know this instance's region"
    )
  }
  if (config.controlPlaneUrl && !config.internalApiKey) {
    throw new Error(
      "INTERNAL_API_KEY is required when CONTROL_PLANE_URL is set — inter-service calls need authentication"
    )
  }

  if (useStubAuth) {
    logger.warn("Using stub auth service - NOT FOR PRODUCTION")
    if (config.workspaceCreationRequiresInvite) {
      logger.warn(
        "USE_STUB_AUTH is enabled while workspace creation invite checks are enabled; stub auth cannot verify WorkOS invites and will allow workspace creation. Set WORKSPACE_CREATION_SKIP_INVITE=true to make the bypass explicit."
      )
    }
  }

  if (useStubCompanion) {
    logger.warn("Using stub companion service - NOT FOR PRODUCTION")
  }

  if (useStubBoundaryExtraction) {
    logger.warn("Using stub boundary extraction - NOT FOR PRODUCTION")
  }

  if (useStubAI) {
    logger.warn("Using stub AI services (naming, embedding, memo) - NOT FOR PRODUCTION")
  }

  return config
}
