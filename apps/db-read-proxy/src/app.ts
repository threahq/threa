import express, { type Express, type Request, type Response } from "express"
import helmet from "helmet"
import pinoHttp from "pino-http"
import { randomUUID } from "crypto"
import { z } from "zod"
import type { Pool } from "pg"
import { logger, createRateLimit, getClientIp } from "@threa/backend-common"
import { createSecretAuthMiddleware } from "./auth"
import { executeReadOnly, QueryExecutionError, QueryValidationError } from "./query"
import type { ProxyConfig } from "./config"

const querySchema = z.object({
  sql: z.string(),
  params: z.array(z.unknown()).max(64).optional(),
})

export interface CreateAppOptions {
  pool: Pool
  config: ProxyConfig
}

export function createApp({ pool, config }: CreateAppOptions): Express {
  const app = express()
  app.set("trust proxy", 1)
  app.disable("x-powered-by")

  app.use(helmet({ contentSecurityPolicy: false }))
  app.use(express.json({ limit: "256kb" }))
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req.headers["x-request-id"] as string) || randomUUID(),
      autoLogging: { ignore: (req) => req.url === "/health" || req.url === "/readyz" },
      customLogLevel: (_req, res, err) => {
        if (res.statusCode >= 500 || err) return "error"
        if (res.statusCode >= 400) return "warn"
        return "info"
      },
    })
  )

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true })
  })

  app.get("/readyz", async (_req: Request, res: Response) => {
    try {
      await pool.query("SELECT 1")
      res.json({ ok: true })
    } catch (err) {
      logger.error({ err }, "db-read-proxy readyz failed")
      res.status(503).json({ ok: false })
    }
  })

  const rateLimit = createRateLimit({
    name: "db-read-proxy",
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
    key: (req) => getClientIp(req, "unknown"),
  })

  const auth = createSecretAuthMiddleware(config.proxySecret)

  app.post("/query", rateLimit, auth, async (req: Request, res: Response) => {
    const parsed = querySchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid request body", issues: parsed.error.issues })
      return
    }
    try {
      const result = await executeReadOnly(parsed.data, {
        pool,
        statementTimeoutMs: config.statementTimeoutMs,
        maxRows: config.maxRows,
      })
      logger.info(
        { rowCount: result.rowCount, truncated: result.truncated, durationMs: result.durationMs },
        "db-read-proxy query ok"
      )
      res.json(result)
    } catch (err) {
      if (err instanceof QueryValidationError) {
        res.status(err.status).json({ error: err.message })
        return
      }
      if (err instanceof QueryExecutionError) {
        res.status(err.status).json({ error: err.message, pgCode: err.pgCode })
        return
      }
      logger.error({ err }, "db-read-proxy unhandled error")
      res.status(500).json({ error: "internal error" })
    }
  })

  return app
}
