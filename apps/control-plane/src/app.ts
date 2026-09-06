import express, { type Express } from "express"
import cors from "cors"
import helmet from "helmet"
import cookieParser from "cookie-parser"
import pinoHttp from "pino-http"
import { randomUUID } from "crypto"
import { INTERNAL_API_KEY_HEADER } from "@threahq/types"
import { logger, createCorsOriginChecker } from "@threahq/backend-common"
import { GITHUB_WEBHOOK_PATH } from "./features/github-webhooks"

interface CreateAppOptions {
  corsAllowedOrigins: string[]
}

export function createApp(options: CreateAppOptions): Express {
  const app = express()
  const isProduction = process.env.NODE_ENV === "production"
  const requestLoggingIgnoredPaths = ["/health", "/readyz"]

  app.set("trust proxy", 1)
  app.disable("x-powered-by")

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
        },
      },
      frameguard: { action: "deny" },
      hsts: isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    })
  )

  app.use(cors({ origin: createCorsOriginChecker(options.corsAllowedOrigins), credentials: true }))
  app.use(cookieParser())
  // The GitHub webhook route needs the raw request bytes for HMAC verification,
  // so the JSON parser must not consume its body first. The route mounts its own
  // express.raw() parser in registerRoutes.
  const jsonParser = express.json()
  app.use((req, res, next) => {
    // Match the trailing-slash tolerance of the webhook route (Express non-strict
    // routing) and the router regex, so a POST to `/webhook/` still skips the JSON
    // parser and reaches express.raw() with an intact body for HMAC verification.
    const path = req.path.length > 1 ? req.path.replace(/\/$/, "") : req.path
    if (path === GITHUB_WEBHOOK_PATH) return next()
    return jsonParser(req, res, next)
  })
  app.use(express.urlencoded({ extended: false }))

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
        // secret (backend → control-plane); Node lowercases header names, and the
        // path is derived from the constant so it can't drift.
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          // The referer carries the document URL, and `/connect?code=…` puts a
          // live device-flow user code there.
          "req.headers.referer",
          `req.headers["${INTERNAL_API_KEY_HEADER.toLowerCase()}"]`,
          "res.headers['set-cookie']",
        ],
        censor: "[REDACTED]",
      },
    })
  )

  app.get("/health", (_, res) => res.json({ status: "ok" }))

  return app
}
