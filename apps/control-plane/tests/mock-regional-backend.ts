/**
 * Lightweight mock HTTP server that simulates a regional backend.
 * Used by control-plane tests to avoid needing a real backend running.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http"
import { orgWorkspaceEnsureSchema, streamConnectionSnapshotSchema, type StreamConnectionChannel } from "@threahq/types"

export interface MockRegionalBackend {
  url: string
  port: number
  /** All requests received by the mock */
  requests: Array<{ method: string; url: string; body: unknown }>
  /** Status the stream-connection sync endpoint answers a valid snapshot with; 204 by default. */
  setStreamConnectionStatus: (status: number) => void
  /** What the channel lookup answers, or "error" for a 503; a shareable channel named Launch by default. */
  setStreamChannel: (answer: StreamConnectionChannel | "error") => void
  /** Reset recorded requests and configured statuses */
  reset: () => void
  stop: () => Promise<void>
}

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString()
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve(raw || null)
      }
    })
  })
}

export async function startMockRegionalBackend(): Promise<MockRegionalBackend> {
  const requests: MockRegionalBackend["requests"] = []
  let streamConnectionStatus = 204
  const shareableChannel: StreamConnectionChannel = { shareable: true, slug: "launch", displayName: "Launch" }
  let streamChannel: StreamConnectionChannel | "error" = shareableChannel

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await parseBody(req)
    requests.push({ method: req.method || "GET", url: req.url || "/", body })

    const url = req.url || ""

    // POST /internal/workspaces — mock workspace creation
    if (req.method === "POST" && url === "/internal/workspaces") {
      const data = body as Record<string, unknown>
      res.writeHead(201, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ workspace: { id: data?.id, name: data?.name, slug: data?.slug } }))
      return
    }

    // POST /internal/invitations/:id/accept — mock invitation acceptance
    if (req.method === "POST" && url.match(/^\/internal\/invitations\/[^/]+\/accept$/)) {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ workspaceId: "ws_mock" }))
      return
    }

    // POST /internal/github/webhook-events — mock the regional webhook ingress so
    // outbox dispatch of github_webhook_dispatch events succeeds cleanly (the real
    // endpoint arrives in Step 3).
    if (req.method === "POST" && url === "/internal/github/webhook-events") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    // POST /internal/stream-connections — snapshot fan-out from stream_connection_sync,
    // validated against the same schema the region applies.
    if (req.method === "POST" && url === "/internal/stream-connections") {
      const status = streamConnectionSnapshotSchema.safeParse(body).success ? streamConnectionStatus : 400
      res.writeHead(status)
      res.end()
      return
    }

    // POST /internal/org-workspaces — org workspace fan-out, validated against the schema the region applies.
    if (req.method === "POST" && url === "/internal/org-workspaces") {
      const parsed = orgWorkspaceEnsureSchema.safeParse(body)
      res.writeHead(parsed.success ? 200 : 400, { "Content-Type": "application/json" })
      res.end(JSON.stringify(parsed.success ? { workspaceId: parsed.data.workspaceId } : { code: "VALIDATION_ERROR" }))
      return
    }

    // GET /internal/stream-connections/channel — the host channel, for the invite page and before an accept.
    // Requires the keys the region's channelQuerySchema requires.
    if (req.method === "GET" && url.startsWith("/internal/stream-connections/channel?")) {
      const query = new URL(url, "http://mock").searchParams
      if (!["workspaceId", "streamId", "invitedBy"].every((key) => query.get(key))) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Invalid query", code: "VALIDATION_ERROR" }))
        return
      }
      if (streamChannel === "error") {
        res.writeHead(503)
        res.end()
        return
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(streamChannel))
      return
    }

    // Fallback 404
    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "Not found" }))
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr === "object") {
        resolve(addr.port)
      } else {
        reject(new Error("Could not get mock server address"))
      }
    })
    server.on("error", reject)
  })

  return {
    url: `http://localhost:${port}`,
    port,
    requests,
    setStreamConnectionStatus: (status) => {
      streamConnectionStatus = status
    },
    setStreamChannel: (answer) => {
      streamChannel = answer
    },
    reset: () => {
      requests.length = 0
      streamConnectionStatus = 204
      streamChannel = shareableChannel
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}
