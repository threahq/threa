/**
 * Real client IP for a socket.io handshake. `trust proxy` only rewrites
 * `req.ip` for HTTP requests; the handshake object is not run through it, so
 * the workspace-router's `X-Forwarded-For` (rewritten from `CF-Connecting-IP`)
 * is read explicitly, falling back to the transport's remote address.
 */
export function socketHandshakeIp(handshake: {
  headers: Record<string, string | string[] | undefined>
  address: string
}): string {
  const forwarded = handshake.headers["x-forwarded-for"]
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (typeof raw === "string" && raw.length > 0) return raw.split(",")[0]!.trim()
  return handshake.address
}
