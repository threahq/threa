import express from "express"
import pino from "pino"
import { loadEnclaveConfig } from "./config"
import { createEnclaveKeyPair } from "./keystore"
import { registerWithBackend, revokeWithBackend } from "./register"
import { startHeartbeat } from "./heartbeat"
import { accessLog } from "./access-log"
import { createOpenRouterChat } from "./llm"
import { createBackendCallbacks } from "./agent/backend-callbacks"
import { createSessionsHandler, requireInternalKey } from "./sessions"

const logger = pino({ name: "enclave" })

async function main() {
  const config = loadEnclaveConfig()
  const keyPair = await createEnclaveKeyPair()
  logger.info({ instanceId: keyPair.instanceId, keyId: keyPair.keyId }, "Enclave EIK generated")

  await registerWithBackend(config, keyPair)

  const app = express()
  app.disable("x-powered-by")
  app.use(accessLog)
  // No app-wide body parser: only /invoke takes a body, and it mounts its own
  // parser *after* the auth gate so an unauthorized caller never costs us a
  // (multi-MB) JSON parse. The GET routes below need no body.

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" })
  })

  app.get("/pubkey", (_req, res) => {
    res.json({
      instanceId: keyPair.instanceId,
      keyId: keyPair.keyId,
      publicKey: keyPair.publicKeyBase64,
    })
  })

  app.get("/attestation", (_req, res) => {
    res.json({
      sourceCommitSha: config.sourceCommitSha,
      buildHash: config.buildHash,
    })
  })

  // The only content-bearing route: the backend assigns a turn, we ack 202 and
  // run the agent loop asynchronously, reporting replies back over the session
  // callbacks. OpenRouter is the enclave's sole outbound LLM dependency.
  const rawChat = createOpenRouterChat(config)
  const callbacks = createBackendCallbacks(config)
  const inFlight = new Set<string>()
  app.post(
    "/sessions",
    requireInternalKey(config.internalApiKey),
    express.json({ limit: "4mb" }),
    createSessionsHandler({ keyPair, rawChat, callbacks, inFlight })
  )

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err }, "Enclave request failed")
    res.status(500).json({ error: "Internal Server Error" })
  })

  const heartbeat = startHeartbeat(config, keyPair, async () => {
    await registerWithBackend(config, keyPair)
  })

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, selfUrl: config.selfUrl }, "Enclave listening")
  })

  let shuttingDown = false
  const shutdown = async (code: number) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info("Enclave shutting down")
    heartbeat.stop()
    server.close()
    await revokeWithBackend(config, keyPair)
    process.exit(code)
  }

  process.on("SIGTERM", () => shutdown(0))
  process.on("SIGINT", () => shutdown(0))
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception")
    void shutdown(1)
  })
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ reason }, "Unhandled rejection")
    void shutdown(1)
  })
}

await main()
