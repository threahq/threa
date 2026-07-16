export interface WorkosConfig {
  apiKey: string
  clientId: string
  redirectUri: string
  cookiePassword: string
}

/**
 * Timeout for every WorkOS API call. The SDK's default is 60s, which turned
 * the 2026-07-16 WorkOS platform incident into 60-second request hangs on the
 * auth hot path (session refresh runs inside request middleware): the browser's
 * per-origin connection pool filled with hung requests and the whole app froze
 * ("Sending…", reconnect pill, archival timeouts). Failing fast keeps a WorkOS
 * blip a quick 401 the client can retry instead of a minute-long stall.
 */
export const WORKOS_REQUEST_TIMEOUT_MS = 10_000
