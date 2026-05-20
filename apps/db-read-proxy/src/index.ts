import { logger } from "@threa/backend-common"
import { startServer } from "./server"

const { stop, config } = await startServer()

let isShuttingDown = false
async function shutdown(code: number): Promise<void> {
  if (isShuttingDown) return
  isShuttingDown = true

  if (config.fastShutdown) {
    logger.info("Fast shutdown - exiting immediately")
    process.exit(code)
  }

  await stop()
  process.exit(code)
}

process.on("SIGTERM", () => shutdown(0))
process.on("SIGINT", () => shutdown(0))
process.on("SIGHUP", () => shutdown(0))

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception in db-read-proxy")
  void shutdown(1)
})

process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "Unhandled rejection in db-read-proxy")
  void shutdown(1)
})
