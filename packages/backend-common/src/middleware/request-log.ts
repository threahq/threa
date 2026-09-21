/**
 * 400 is our own frontend<->backend contract breaking (VALIDATION_ERROR); 429 is a client
 * hitting a limit. Both warrant a warn that ships; other 4xx is noise, kept at info.
 */
export function requestLogLevel(statusCode: number, err?: unknown): "error" | "warn" | "info" | "silent" {
  if (statusCode >= 500 || err) return "error"
  if (statusCode === 400 || statusCode === 429) return "warn"
  if (statusCode >= 400) return "info"
  return "silent"
}

/** An incoming-webhook URL carries its credential in the path segment after the hook id. */
const HOOK_SECRET_SEGMENT = /(\/hooks\/[^/?#]+\/)[^/?#]+/i

export function redactHookSecret(url: string): string {
  return url.replace(HOOK_SECRET_SEGMENT, "$1[redacted]")
}

/**
 * Default pino-http serializers dump every header, so a new secret header
 * leaks by omission; this allowlist means only these fields ever reach a log.
 */
export const requestLogSerializers = {
  req(req: { id?: string; method: string; url: string; headers: Record<string, string | undefined> }) {
    return {
      id: req.id,
      method: req.method,
      url: redactHookSecret(req.url),
      userAgent: req.headers["user-agent"],
      origin: req.headers["origin"],
    }
  },
  res(res: { statusCode: number }) {
    return { statusCode: res.statusCode }
  },
}
