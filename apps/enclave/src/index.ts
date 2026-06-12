import express from "express"
import { logger as baseLogger } from "@threa/agent-runtime/logger"
import { loadEnclaveConfig } from "./config"
import { createEnclaveKeyPair } from "./keystore"
import { registerWithBackend, revokeWithBackend } from "./register"
import { startHeartbeat } from "./heartbeat"
import { accessLog } from "./access-log"
import { createOpenRouterChat } from "./llm"
import { createBackendCallbacks } from "./agent/backend-callbacks"
import { runEnclaveSession } from "./agent/session-runner"
import { startClaimLoop } from "./claim-loop"

const logger = baseLogger.child({ name: "enclave" })

async function main() {
  const config = loadEnclaveConfig()
  const keyPair = await createEnclaveKeyPair()
  logger.info({ instanceId: keyPair.instanceId, keyId: keyPair.keyId }, "Enclave EIK generated")

  // The enclave runs no inbound content routes (§2.7 pull transport): turns
  // are claimed from the backend, mid-turn cancel rides the session-heartbeat
  // response, and replies flow out over the session callbacks. What remains
  // inbound is read-only liveness/identity metadata — no body parser at all.
  const app = express()
  app.disable("x-powered-by")
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

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err }, "Enclave request failed")
    res.status(500).json({ error: "Internal Server Error" })
  })

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, "Enclave listening")
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

  // Work intake: poll the backend and claim turns this EIK can serve.
  // OpenRouter is the enclave's sole outbound LLM dependency.
  const rawChat = createOpenRouterChat(config)
  const inFlight = new Set<string>()
  const claimLoop = startClaimLoop({
    config,
    keyPair,
    inFlight,
    runSession: (assignment) =>
      runEnclaveSession(
        {
          keyPair,
          rawChat,
          // Per-session callbacks: the claim's callbackToken rides a header on
          // every callback, binding the turn to the runner that won it
          // (Phase 2.4b, E2EE-21).
          callbacks: createBackendCallbacks(config, assignment.callbackToken),
          toolConfig: { tavilyApiKey: config.tavilyApiKey },
        },
        assignment
      ),
  })

  // On a graceful signal, how long to let in-flight sessions finish before exit.
  const SHUTDOWN_DRAIN_MS = 10_000

  let shuttingDown = false
  const shutdown = async (code: number) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info("Enclave shutting down")
    claimLoop.stop() // stop taking new turns; in-flight sessions run detached
    heartbeat.stop()
    server.close()

    // Session work runs detached from the claim loop, so on a graceful stop
    // (e.g. a deploy) give running turns a bounded window to finish and ack
    // rather than cutting them mid-flight. The claim TTL + attempt budget
    // recycle any that don't drain in time.
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
