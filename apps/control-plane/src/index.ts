import { startServer } from "./server"
import { logger } from "@threa/backend-common"

const { server, stop, fastShutdown, analyticsReporter } = await startServer()

if (fastShutdown) {
  logger.info("Fast shutdown enabled - graceful shutdown disabled")
}

let isShuttingDown = false
async function shutdown(code: number) {
  if (isShuttingDown) return
  isShuttingDown = true

  if (fastShutdown) {
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
  logger.fatal({ err }, "Uncaught exception in control plane")
  analyticsReporter.captureException(err, { properties: { source: "uncaughtException", fatal: true } })
  void shutdown(1)
})

process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "Unhandled rejection in control plane")
  analyticsReporter.captureException(reason, { properties: { source: "unhandledRejection", fatal: true } })
  void shutdown(1)
})
