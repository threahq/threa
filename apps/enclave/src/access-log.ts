import pinoHttp from "pino-http"
import { logger as baseLogger } from "@threa/agent-runtime/logger"
import { randomUUID } from "crypto"

/**
 * Access logger. Never records request bodies or any plaintext content —
 * structured metadata only: timing, status, byte size.
 *
 * Authorization headers and cookies are redacted at the pino layer.
 */
export const accessLog = pinoHttp({
  // Share the regional backend's logger config (level, pretty-in-dev / JSON-in-prod,
  // error serializer) via a named child, so enclave access logs match the backend's.
  logger: baseLogger.child({ name: "enclave-access" }),
  autoLogging: {
    ignore: (req) => req.url === "/healthz" || req.url === "/pubkey",
  },
  customLogLevel: (_req, res, err) => {
    if (res.statusCode >= 500 || err) return "error"
    if (res.statusCode >= 400) return "warn"
    return "info"
  },
  genReqId: (req) => (req.headers["x-request-id"] as string) || randomUUID(),
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']", "req.body", "res.body"],
    censor: "[REDACTED]",
  },
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      // intentionally do NOT log body
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
  },
})
