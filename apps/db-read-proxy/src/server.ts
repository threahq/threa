import { createServer, type Server } from "http"
import type { Pool } from "pg"
import { createDatabasePool, logger } from "@threa/backend-common"
import { createApp } from "./app"
import { loadConfig, type ProxyConfig } from "./config"

export interface ProxyInstance {
  server: Server
  pool: Pool
  port: number
  config: ProxyConfig
  stop: () => Promise<void>
}

export async function startServer(): Promise<ProxyInstance> {
  const config = loadConfig()
  const pool = createDatabasePool(config.databaseUrl, { max: 5 })

  // Fail fast on a bad connection string / DNS / role rather than surfacing as
  // 503 on the first /query request. Close the pool on failure so we don't
  // leak the idle connections it already opened.
  try {
    await pool.query("SELECT 1")
  } catch (err) {
    await pool.end()
    throw err
  }

  const app = createApp({ pool, config })
  const server = createServer(app)

  await new Promise<void>((resolve) => server.listen(config.port, resolve))
  logger.info({ port: config.port }, "db-read-proxy listening")

  const stop = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await pool.end()
  }

  return { server, pool, port: config.port, config, stop }
}
