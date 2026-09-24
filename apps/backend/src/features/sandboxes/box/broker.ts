import http from "node:http"
import https from "node:https"

export interface BrokerOptions {
  /** The exec's sandbox token. Only the broker holds it; the command never sees it. */
  token: string
  workspaceId: string
  /** `https://host` for Threa's public origin, or `unix:/path` for a socket relayed to a local backend. */
  upstream: string
  port: number
}

/** Where commands in the box reach the Threa API. */
export const BROKER_PORT = 7171

const REQUEST_HEADERS = ["content-type", "content-length", "accept"]
const RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-disposition",
  "cache-control",
  "retry-after",
  "x-content-type-options",
]

// Any dot segment, encoded dot, or backslash could step out of the workspace
// prefix once the upstream normalizes the path.
const UNSAFE_PATH = /(^|\/)\.\.?(\/|\?|$)|%2e|\\/i

function pick(headers: http.IncomingHttpHeaders, names: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const name of names) {
    const value = headers[name]
    if (value !== undefined) out[name] = value
  }
  return out
}

/**
 * Loopback proxy from code in the box to Threa's public API. It forwards
 * workspace API paths only, to one fixed upstream, with the exec's token in
 * place of whatever the caller sent, and follows no redirects: the box gets no
 * general route out, and the token never enters the command's environment.
 */
export function startBroker(options: BrokerOptions): http.Server {
  const prefix = `/api/v1/workspaces/${options.workspaceId}/`
  const socketPath = options.upstream.startsWith("unix:") ? options.upstream.slice("unix:".length) : null
  const origin = socketPath ? null : new URL(options.upstream)
  const transport = origin?.protocol === "http:" ? http : https

  const server = http.createServer((req, res) => {
    const path = req.url ?? ""
    if (!path.startsWith(prefix) || UNSAFE_PATH.test(path)) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "Not found", code: "NOT_FOUND" }))
      req.resume()
      return
    }
    const headers = { ...pick(req.headers, REQUEST_HEADERS), authorization: `Bearer ${options.token}` }
    const upstreamRequest = socketPath
      ? http.request({ socketPath, path, method: req.method, headers: { ...headers, host: "localhost" } })
      : transport.request({
          protocol: origin!.protocol,
          hostname: origin!.hostname,
          port: origin!.port,
          path,
          method: req.method,
          headers,
        })
    upstreamRequest.on("response", (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, pick(upstreamResponse.headers, RESPONSE_HEADERS))
      upstreamResponse.pipe(res)
    })
    upstreamRequest.on("error", () => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(502, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "Threa API unreachable", code: "UPSTREAM_UNREACHABLE" }))
    })
    req.pipe(upstreamRequest)
  })

  server.listen(options.port, "127.0.0.1")
  return server
}
