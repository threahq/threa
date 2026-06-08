import express, { type Express } from "express"
import compression from "compression"
import cors from "cors"
import helmet from "helmet"
import cookieParser from "cookie-parser"
import pinoHttp from "pino-http"
import { randomUUID } from "crypto"
import { INTERNAL_API_KEY_HEADER } from "@threa/types"
import { logger } from "./lib/logger"
import { bigIntReplacer } from "@threa/backend-common"
import { createMetricsMiddleware } from "./middleware/metrics"
import { createCorsOriginChecker } from "./lib/cors"

interface CreateAppOptions {
  corsAllowedOrigins: string[]
  isProduction: boolean
}

export function createApp(options: CreateAppOptions): Express {
  const app = express()
  const requestLoggingIgnoredPaths = ["/health", "/readyz"]
  const metricsIgnoredPaths = [...requestLoggingIgnoredPaths, "/metrics"]

  // Configure JSON serialization to handle BigInt values
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

  app.use(cors({ origin: createCorsOriginChecker(options.corsAllowedOrigins), credentials: true }))
  app.use(cookieParser())
  app.use(express.json({ limit: "10mb" }))
  app.use(express.urlencoded({ extended: true, limit: "10mb" }))

  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req) => requestLoggingIgnoredPaths.includes(req.url),
      },
      customLogLevel: (_req, res, err) => {
        if (res.statusCode >= 500 || err) return "error"
        if (res.statusCode >= 400) return "warn"
        return "silent"
      },
      genReqId: (req) => (req.headers["x-request-id"] as string) || randomUUID(),
      redact: {
        // The default pino-http req serializer logs the full headers object, so
        // every secret-bearing header must be redacted here or it lands in the
        // log on any 4xx/5xx. `x-internal-api-key` is the shared internal-auth
        // secret (enclave/control-plane → backend); Node lowercases header names,
        // and the path is derived from the constant so it can't drift.
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          `req.headers["${INTERNAL_API_KEY_HEADER.toLowerCase()}"]`,
          "res.headers['set-cookie']",
        ],
        censor: "[REDACTED]",
      },
      customSuccessMessage: (req, res) => {
        return `${req.method} ${req.url} ${res.statusCode}`
      },
      customErrorMessage: (req, res, err) => {
        return `${req.method} ${req.url} ${res.statusCode} - ${err?.message || "Error"}`
      },
    })
  )

  app.get("/health", (_, res) => res.json({ status: "ok" }))

  return app
}
