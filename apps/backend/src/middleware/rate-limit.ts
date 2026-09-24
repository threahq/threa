import { createHash } from "crypto"
import type { Request, RequestHandler, Response } from "express"
import { createRateLimit, getClientIp, type RateLimitRejection } from "@threahq/backend-common"
import { BOT_KEY_PREFIX } from "@threahq/types"
import { isInboundWebhookUrl, isSlackWebhookUrl } from "../features/incoming-webhooks"

export interface RateLimiterSet {
  globalBaseline: RequestHandler
  auth: RequestHandler
  search: RequestHandler
  upload: RequestHandler
  messageCreate: RequestHandler
  commandDispatch: RequestHandler
  pushTest: RequestHandler
  calls: RequestHandler
  callsStart: RequestHandler
  perfCapture: RequestHandler
  publicApiWorkspace: RequestHandler
  publicApiKey: RequestHandler
  publicApiBotKey: RequestHandler
  incomingWebhookIp: RequestHandler
  incomingWebhookHook: RequestHandler
}

function respondToWebhookLimit(req: Request, res: Response, rejection: RateLimitRejection): void {
  res.setHeader("Retry-After", String(rejection.retryAfterSeconds))
  if (isSlackWebhookUrl(req.originalUrl)) {
    res.status(429).type("text/plain").send("rate_limited")
    return
  }
  res.status(429).json({ error: "Rate limit exceeded", limit: rejection.limit, windowMs: rejection.windowMs })
}

export interface RateLimiterConfig {
  globalMax: number
  authMax: number
}

function userScopeKey(req: Request): string {
  return req.workosUserId || getClientIp(req, "unknown")
}

function bearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization
  return authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null
}

function isBotKey(req: Request): boolean {
  return bearerToken(req)?.startsWith(BOT_KEY_PREFIX) ?? false
}

function publicApiKeyScopeKey(req: Request): string {
  const token = bearerToken(req)
  if (!token) return getClientIp(req, "unknown")
  // Hash the token to avoid storing raw credentials in memory
  const hash = createHash("sha256").update(token).digest("hex").slice(0, 16)
  return `apikey:${hash}`
}

export function createRateLimiters(config: RateLimiterConfig): RateLimiterSet {
  return {
    globalBaseline: createRateLimit({
      name: "global",
      windowMs: 60_000,
      max: config.globalMax,
      key: (req) => getClientIp(req, "unknown"),
      // Inbound webhooks have their own per-IP ceiling. The baseline would answer first,
      // in JSON, where a Slack sender expects text/plain `rate_limited`.
      skip: (req) => isInboundWebhookUrl(req.originalUrl),
    }),

    auth: createRateLimit({
      name: "auth",
      windowMs: 60_000,
      max: config.authMax,
      key: (req) => getClientIp(req, "unknown"),
    }),

    search: createRateLimit({
      name: "search",
      windowMs: 60_000,
      max: 30,
      key: userScopeKey,
    }),

    upload: createRateLimit({
      name: "upload",
      windowMs: 60_000,
      // Every file costs two requests (reserve + content), so this is a
      // 30-file-per-minute budget — the composer tray is designed around
      // ~20-attachment batches, and the client paces itself (3 concurrent
      // transfers, 429-aware backoff) rather than bursting.
      max: 60,
      // Bearer callers (API keys, sandbox tokens) share egress IPs, so each token gets its own budget.
      key: (req) => req.workosUserId || publicApiKeyScopeKey(req),
    }),

    messageCreate: createRateLimit({
      name: "message-create",
      windowMs: 60_000,
      max: 120,
      key: userScopeKey,
    }),

    commandDispatch: createRateLimit({
      name: "command-dispatch",
      windowMs: 60_000,
      max: 30,
      key: userScopeKey,
    }),

    // The test push triggers up to MAX_SUBSCRIPTIONS_PER_USER outbound webpush
    // calls per request, so cap aggressively — a user shouldn't need to test
    // more than a few times a minute, and this prevents hammering FCM/Mozilla.
    pushTest: createRateLimit({
      name: "push-test",
      windowMs: 60_000,
      max: 6,
      key: userScopeKey,
    }),

    // CF media-proxy pass-throughs: renegotiation + track pulls churn on a bad
    // network, so the ceiling is generous; it only trips a runaway client.
    calls: createRateLimit({
      name: "calls",
      windowMs: 60_000,
      max: 240,
      key: userScopeKey,
    }),

    // Ring-capable call creation (POST /calls) is high-urgency push spam if abused,
    // so it gets its own tight budget instead of sharing the generous proxy limiter
    // (S9). 12/min covers legit start + leave-retry churn and kills spam.
    callsStart: createRateLimit({
      name: "calls-start",
      windowMs: 60_000,
      max: 12,
      key: userScopeKey,
    }),

    // User-triggered diagnostics upload: a handful of sends a minute is the
    // whole legitimate pattern, and each row is up to 512KB of JSONB.
    perfCapture: createRateLimit({
      name: "perf-capture",
      windowMs: 60_000,
      max: 6,
      key: userScopeKey,
    }),

    // Public API rate limiters run BEFORE auth middleware, so use
    // req.params (populated by Express route matching) and the raw
    // Authorization header instead of req.workspaceId / req.apiKey.
    publicApiWorkspace: createRateLimit({
      name: "public-api-workspace",
      windowMs: 60_000,
      max: 600,
      key: (req) => req.params.workspaceId || getClientIp(req, "unknown"),
    }),

    publicApiKey: createRateLimit({
      name: "public-api-key",
      windowMs: 60_000,
      max: 60,
      key: publicApiKeyScopeKey,
      skip: isBotKey,
    }),

    // Agent sessions poll and post on their own clock, not a human's — a
    // single busy session already burns the shared 60/min budget above.
    publicApiBotKey: createRateLimit({
      name: "public-api-bot-key",
      windowMs: 60_000,
      max: 300,
      key: publicApiKeyScopeKey,
      skip: (req) => !isBotKey(req),
    }),

    // The per-IP ceiling runs before authentication and caps secret-guessing; the per-hook
    // one caps a single noisy sender once the hook is known.
    incomingWebhookIp: createRateLimit({
      name: "incoming-webhook-ip",
      windowMs: 60_000,
      max: 300,
      key: (req) => getClientIp(req, "unknown"),
      respond: respondToWebhookLimit,
    }),

    incomingWebhookHook: createRateLimit({
      name: "incoming-webhook-hook",
      windowMs: 60_000,
      max: 60,
      key: (req) => req.params.hookId,
      respond: respondToWebhookLimit,
    }),
  }
}
