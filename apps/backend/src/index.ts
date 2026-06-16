// MUST be first - OTEL needs to instrument LangChain before it loads
import { initLangfuse, shutdownLangfuse } from "./lib/langfuse"
initLangfuse()

import { startServer } from "./server"
import { logger } from "./lib/logger"
import { classifyGlobalCrash, serializeCrashReason } from "./lib/crash-policy"

const { server, stop, fastShutdown } = await startServer()

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

  await stop()
  await shutdownLangfuse()
  process.exit(code)
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
