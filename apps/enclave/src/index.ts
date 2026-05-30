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
    createSessionsHandler({ keyPair, rawChat, callbacks, inFlight, toolConfig: { tavilyApiKey: config.tavilyApiKey } })
  )

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err }, "Enclave request failed")
    res.status(500).json({ error: "Internal Server Error" })
  })

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, selfUrl: config.selfUrl }, "Enclave listening")
  })

  // Initial registration is best-effort: in local/dev every service boots at
  // once, so the backend may not be listening yet. Retry briefly, then serve
  // regardless — the heartbeat (backend 404 → re-register) brings us into the
  // live set once the backend is reachable, so a slow or absent backend at boot
  // never crashes the enclave (the HTTP server is already up for liveness).
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await registerWithBackend(config, keyPair)
      break
    } catch (err) {
      if (attempt === 10) {
        logger.warn({ err }, "Initial registration failed after retries; relying on heartbeat re-registration")
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  }

  const heartbeat = startHeartbeat(config, keyPair, async () => {
    await registerWithBackend(config, keyPair)
  })

  // On a graceful signal, how long to let in-flight sessions finish before exit.
  const SHUTDOWN_DRAIN_MS = 10_000

  let shuttingDown = false
  const shutdown = async (code: number) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info("Enclave shutting down")
    heartbeat.stop()
    server.close() // stop accepting new assignments; in-flight sessions run detached

    // Session work outlives the HTTP request now, so on a graceful stop (e.g. a
    // deploy) give running turns a bounded window to finish and ack rather than
    // cutting them mid-flight. Orphan-cleanup reclaims any that don't drain in time.
    if (code === 0 && inFlight.size > 0) {
      const deadline = Date.now() + SHUTDOWN_DRAIN_MS
      while (inFlight.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      if (inFlight.size > 0) {
        logger.warn({ inFlight: inFlight.size }, "Shutting down with sessions still in flight")
      }
    }

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
