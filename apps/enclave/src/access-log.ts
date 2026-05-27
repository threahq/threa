import pinoHttp from "pino-http"
import pino from "pino"
import { randomUUID } from "crypto"

/**
 * Access logger. Never records request bodies or any plaintext content —
 * structured metadata only: timing, status, byte size, model fields ride
 * in alongside the sidecar response.
 *
 * Authorization headers and cookies are redacted at the pino layer.
 */
const baseLogger = pino({ name: "enclave-access" })

export const accessLog = pinoHttp({
  logger: baseLogger,
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
