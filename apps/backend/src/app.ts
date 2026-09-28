import express, { type Express, type Request } from "express"
import compression from "compression"
import cors from "cors"
import helmet from "helmet"
import cookieParser from "cookie-parser"
import pinoHttp from "pino-http"
import { randomUUID } from "crypto"
import { THREA_VERSION_HEADER, isPushRequestPath } from "@threahq/types"
import { logger } from "./lib/logger"
import { bigIntReplacer, requestLogLevel, requestLogSerializers, sanitizeRoutePath } from "@threahq/backend-common"
import { createMetricsMiddleware } from "./middleware/metrics"
import type { ApiVersionLog } from "./middleware/api-version"
import { createCorsOriginChecker } from "./lib/cors"
import { isInboundWebhookUrl } from "./features/incoming-webhooks"
import { isPushReceiptPath } from "./features/push"

/** pino-http hands over the raw URL, and the query string is not part of the route. */
function routeTemplate(url: string | undefined): string {
  return sanitizeRoutePath((url ?? "").split("?")[0] ?? "")
}

/**
 * Requests logged and error-reported anonymously: route template, method and
 * status only. No request id (the client can set it), user agent, origin,
 * error text, or ids in the path.
 */
function isAnonymousRequest(req: Pick<Request, "path">): boolean {
  return typeof req.path === "string" && isPushRequestPath(req.path)
}

function anonymousRequestMessage(req: Request, statusCode: number): string {
  return `${req.method} ${sanitizeRoutePath(req.path)} ${statusCode}`
}

interface CreateAppOptions {
  corsAllowedOrigins: string[]
  isProduction: boolean
}

export function createApp(options: CreateAppOptions): Express {
  const app = express()
  const requestLoggingIgnoredPaths = ["/health", "/readyz"]
  const metricsIgnoredPaths = [...requestLoggingIgnoredPaths, "/metrics"]

  app.set("json replacer", bigIntReplacer)

  // Trust X-Forwarded-For from the workspace router proxy so req.ip reflects the real client
  app.set("trust proxy", 1)

  app.disable("x-powered-by")

  // Metrics middleware (before everything else to capture all requests)
  app.use(createMetricsMiddleware({ ignoredPaths: metricsIgnoredPaths }))

  // Compress responses before they leave the origin. Event/message list payloads
  // are large JSON (full ProseMirror docs per message) and travel an extra
  // origin->edge hop through the Cloudflare workspace-router, which forwards our
  // Content-Encoding unchanged. The default 1KB threshold skips tiny responses.
  app.use(compression())

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "blob:"],
          connectSrc: ["'self'", "ws:", "wss:"],
        },
      },
      frameguard: { action: "deny" },
      hsts: options.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    })
  )

  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req) => requestLoggingIgnoredPaths.includes(req.url),
      },
      customLogLevel: (_req, res, err) => requestLogLevel(res.statusCode, err),
      genReqId: (req) => (req.headers["x-request-id"] as string) || randomUUID(),
      // Public API version telemetry — the api-version gate stashes the requested
      // version, its source (header override vs key pin), the key id, and the
      // operationId on res.locals; empty object for every non-public-API request.
      customProps: (req, res) =>
        isAnonymousRequest(req as Request)
          ? {}
          : ((res as { locals?: { apiVersionLog?: ApiVersionLog } }).locals?.apiVersionLog ?? {}),
      serializers: {
        ...requestLogSerializers,
        // Also what the request logger's child bindings carry.
        req: (req: Parameters<typeof requestLogSerializers.req>[0] & { raw: Request }) =>
          isAnonymousRequest(req.raw)
            ? { method: req.method, url: sanitizeRoutePath(req.raw.path) }
            : requestLogSerializers.req(req),
      },
      // The route template, not the URL: a message carrying prefixed ULIDs is
      // unique per request, so nothing groups downstream and 600 identical 4xx
      // read as 600 unrelated ones. The full URL stays in the `req` attribute.
      customSuccessMessage: (req, res) => {
        if (isAnonymousRequest(req as Request)) return anonymousRequestMessage(req as Request, res.statusCode)
        return `${req.method} ${routeTemplate(req.url)} ${res.statusCode}`
      },
      customErrorObject: (req, _res, _err, val: Record<string, unknown>) => {
        if (!isAnonymousRequest(req as Request)) return val
        const { err: _dropped, ...anonymous } = val
        return anonymous
      },
      customErrorMessage: (req, res, err) => {
        if (isAnonymousRequest(req as Request)) return anonymousRequestMessage(req as Request, res.statusCode)
        return `${req.method} ${routeTemplate(req.url)} ${res.statusCode} - ${err?.message || "Error"}`
      },
    })
  )

  app.use(
    cors({
      origin: createCorsOriginChecker(options.corsAllowedOrigins),
      credentials: true,
      // Cross-origin callers (developer playground) must be able to read the
      // resolved public API version the gate echoes back.
      exposedHeaders: [THREA_VERSION_HEADER],
    })
  )
  app.use(cookieParser())
  // Inbound webhook and push receipt routes parse their own body: unauthenticated, so a far
  // smaller limit, and the Slack route must answer a malformed body in text/plain rather than
  // through this parser's JSON error.
  const jsonParser = express.json({ limit: "10mb" })
  const urlencodedParser = express.urlencoded({ extended: true, limit: "10mb" })
  const ownsBodyParser = (req: Request) => isInboundWebhookUrl(req.url) || isPushReceiptPath(req.path)
  app.use((req, res, next) => (ownsBodyParser(req) ? next() : jsonParser(req, res, next)))
  app.use((req, res, next) => (ownsBodyParser(req) ? next() : urlencodedParser(req, res, next)))

  app.get("/health", (_, res) => res.json({ status: "ok" }))

  return app
}
