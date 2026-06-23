export interface WsHint {
  url: string
  path: string
  namespace: string
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/**
 * Normalize the `{ wsUrl }` the edge workspace-router returns from
 * `GET /api/workspaces/:id/config` into a connectable hint. Defaults match the
 * server: the default Socket.IO path and the `/bot` namespace.
 */
export function parseWsHint(value: unknown): WsHint | undefined {
  if (!isObject(value)) return undefined
  const url = typeof value.url === "string" ? value.url.trim() : ""
  if (!url) return undefined
  const path = typeof value.path === "string" && value.path.trim() ? value.path : "/socket.io/"
  const namespace = typeof value.namespace === "string" && value.namespace.trim() ? value.namespace : "/bot"
  return { url, path, namespace }
}

/**
 * Append the `/bot` namespace to the pathname while preserving any query string.
 * A naive `${url}${namespace}` concat breaks staging URLs that carry `?region=…`.
 */
export function buildBotSocketUrl(hint: WsHint): string {
  const parsed = new URL(hint.url)
  const trimmedPath = parsed.pathname.replace(/\/$/, "")
  parsed.pathname = `${trimmedPath}${hint.namespace}`
  return parsed.toString()
}
