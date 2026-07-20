import { createHash } from "crypto"
import type { Request, RequestHandler } from "express"
import { createRateLimit, getClientIp } from "@threa/backend-common"

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
  publicApiWorkspace: RequestHandler
  publicApiKey: RequestHandler
}

export interface RateLimiterConfig {
  globalMax: number
  authMax: number
}

function userScopeKey(req: Request): string {
  return req.workosUserId || getClientIp(req, "unknown")
}

export function createRateLimiters(config: RateLimiterConfig): RateLimiterSet {
  return {
    globalBaseline: createRateLimit({
      name: "global",
      windowMs: 60_000,
      max: config.globalMax,
      key: (req) => getClientIp(req, "unknown"),
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
      max: 20,
      key: userScopeKey,
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
      key: (req) => {
        const authHeader = req.headers.authorization
        if (authHeader?.startsWith("Bearer ")) {
          // Hash the token to avoid storing raw credentials in memory
          const hash = createHash("sha256").update(authHeader.slice(7)).digest("hex").slice(0, 16)
          return `apikey:${hash}`
        }
        return getClientIp(req, "unknown")
      },
    }),
  }
}
