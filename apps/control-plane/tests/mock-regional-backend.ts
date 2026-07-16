/**
 * Lightweight mock HTTP server that simulates a regional backend.
 * Used by control-plane tests to avoid needing a real backend running.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http"

export interface MockRegionalBackend {
  url: string
  port: number
  /** All requests received by the mock */
  requests: Array<{ method: string; url: string; body: unknown }>
  /** Reset recorded requests */
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
    reset: () => {
      requests.length = 0
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}
