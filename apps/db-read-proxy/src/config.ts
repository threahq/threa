export interface ProxyConfig {
  port: number
  databaseUrl: string
  /** Shared secret required in the `X-Proxy-Secret` header on /query requests. */
  proxySecret: string
  /** Per-statement timeout in ms enforced via `SET LOCAL statement_timeout`. */
  statementTimeoutMs: number
  /** Hard upper bound on rows returned by /query (post-LIMIT wrap). */
  maxRows: number
  /** Per-IP rate limit: max requests per `rateLimitWindowMs`. */
  rateLimitMax: number
  rateLimitWindowMs: number
  fastShutdown: boolean
}

export function loadConfig(): ProxyConfig {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required")
  }
  const secret = process.env.DB_READ_PROXY_SECRET?.trim()
  if (!secret) {
    throw new Error("DB_READ_PROXY_SECRET is required")
  }
  if (secret.length < 32) {
    throw new Error("DB_READ_PROXY_SECRET must be at least 32 characters")
  }

  return {
    port: Number(process.env.PORT) || 3010,
    databaseUrl: process.env.DATABASE_URL,
    proxySecret: secret,
    statementTimeoutMs: Number(process.env.STATEMENT_TIMEOUT_MS) || 5000,
    maxRows: Number(process.env.MAX_ROWS) || 5000,
    rateLimitMax: Number(process.env.RATE_LIMIT_MAX) || 30,
    rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 10_000,
    fastShutdown: process.env.FAST_SHUTDOWN === "true",
  }
}
