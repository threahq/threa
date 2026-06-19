// MUST be first - OTEL needs to instrument LangChain before it loads
import { initLangfuse, shutdownLangfuse } from "./lib/langfuse"
initLangfuse()

import { startServer } from "./server"
import { logger } from "./lib/logger"
import { classifyGlobalCrash, serializeCrashReason } from "./lib/crash-policy"
import { runWithShutdownWatchdog } from "./lib/graceful-shutdown"

const { server, stop, fastShutdown } = await startServer()

// Hard ceiling on graceful shutdown. `stop()` drains the pools, and `pool.end()`
// blocks on an unreachable Postgres — that wedged the process half-dead for ~24
// min in the 2026-06-19 disk-full incident (no exit, no logs, no supervisor
// restart). Past this deadline we force-exit so the supervisor restarts us.
const configuredShutdownTimeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS)
const SHUTDOWN_TIMEOUT_MS =
  Number.isFinite(configuredShutdownTimeoutMs) && configuredShutdownTimeoutMs > 0 ? configuredShutdownTimeoutMs : 15_000

if (fastShutdown) {
  logger.info("Fast shutdown enabled - graceful shutdown disabled")
}

let isShuttingDown = false
async function shutdown(code: number) {
  if (isShuttingDown) return
  isShuttingDown = true

  if (fastShutdown) {
    logger.info("Fast shutdown - skipping graceful shutdown")
    process.exit(code)
  }

  await runWithShutdownWatchdog({
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    shutdown: async () => {
      try {
        await stop()
        await shutdownLangfuse()
      } catch (err) {
        logger.error({ err }, "Error during graceful shutdown")
      }
    },
    onComplete: () => process.exit(code),
    onTimeout: () => {
      logger.fatal({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, "Graceful shutdown timed out — forcing exit")
      process.exit(code)
    },
  })
}

process.on("SIGTERM", () => shutdown(0))
process.on("SIGINT", () => shutdown(0))
process.on("SIGHUP", () => shutdown(0))

process.on("uncaughtException", (err) => {
  const decision = classifyGlobalCrash("uncaughtException", err)
  if (!decision.isFatal) {
    logger.warn({ err, classification: decision.classification }, decision.logMessage)
    return
  }

  logger.fatal({ err, classification: decision.classification }, decision.logMessage)
  void shutdown(1)
})

process.on("unhandledRejection", (reason) => {
  const reasonInfo = serializeCrashReason(reason)
  const decision = classifyGlobalCrash("unhandledRejection", reason)
  if (!decision.isFatal) {
    logger.warn({ reason: reasonInfo, classification: decision.classification }, decision.logMessage)
    return
  }

  logger.fatal({ reason: reasonInfo, classification: decision.classification }, decision.logMessage)
  void shutdown(1)
})
