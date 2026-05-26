import express, { type Express } from "express"
import cors from "cors"
import helmet from "helmet"
import cookieParser from "cookie-parser"
import pinoHttp from "pino-http"
import { randomUUID } from "crypto"
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
        paths: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"],
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
