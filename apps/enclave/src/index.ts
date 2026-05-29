import express from "express"
import pino from "pino"
import { loadEnclaveConfig } from "./config"
import { createEnclaveKeyPair } from "./keystore"
import { registerWithBackend, revokeWithBackend } from "./register"
import { startHeartbeat } from "./heartbeat"
import { accessLog } from "./access-log"
import { createOpenRouterClient } from "./llm"
import { createInvokeHandler } from "./invoke"

const logger = pino({ name: "enclave" })

async function main() {
  const config = loadEnclaveConfig()
  const keyPair = await createEnclaveKeyPair()
  logger.info({ instanceId: keyPair.instanceId, keyId: keyPair.keyId }, "Enclave EIK generated")

  await registerWithBackend(config, keyPair)

  const app = express()
  app.disable("x-powered-by")
  app.use(express.json({ limit: "4mb" }))
  app.use(accessLog)

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

  // The only content-bearing route: decrypt the forwarded turn, call the LLM,
  // seal the reply. The LLM client is the enclave's sole outbound dependency.
  const chatCompletion = createOpenRouterClient(config)
  app.post("/invoke", createInvokeHandler({ keyPair, chatCompletion }, config.internalApiKey))

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
