import { describe, expect, it } from "bun:test"
import express from "express"
import type { AddressInfo } from "node:net"
import { assertAuditCoverage, createAuditMiddleware } from "./middleware"
import { setAuditSubjects } from "./subjects"
import type { AccessLogService } from "./service"

const noopService = { record() {} } as unknown as AccessLogService

function recordingService() {
  const rows: Record<string, unknown>[] = []
  const service = {
    record(row: Record<string, unknown>) {
      rows.push(row)
    },
  } as unknown as AccessLogService
  return { service, rows }
}

async function requestAndAwaitRow(app: express.Express, path: string, rows: unknown[]): Promise<void> {
  const server = app.listen(0)
  try {
    const port = (server.address() as AddressInfo).port
    await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST" })
    // The record hook fires on the response 'finish' event, after the fetch
    // resolves — poll briefly rather than racing it.
    const deadline = Date.now() + 2000
    while (rows.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5))
    }
  } finally {
    server.close()
  }
  expect(rows.length).toBe(1)
}

describe("audit() denied-row forensics", () => {
  it("records detail.status and route-param subject refs on a denial with no service subjects", async () => {
    const { service, rows } = recordingService()
    const audit = createAuditMiddleware(service)
    const app = express()
    app.post(
      "/api/workspaces/:workspaceId/scheduled/:id/send-now",
      audit("scheduled_messages.send_now", "write"),
      (_req, res) => void res.status(409).json({ error: "already sent" })
    )

    await requestAndAwaitRow(app, "/api/workspaces/ws_1/scheduled/sched_1/send-now", rows)

    expect(rows[0]).toMatchObject({
      operation: "scheduled_messages.send_now",
      outcome: "denied",
      workspaceId: "ws_1",
      detail: { status: 409 },
      subjects: [{ type: "param", id: "sched_1" }],
    })
  })

  it("keeps service-set subjects over the param fallback and omits detail on success", async () => {
    const { service, rows } = recordingService()
    const audit = createAuditMiddleware(service)
    const app = express()
    app.post(
      "/api/workspaces/:workspaceId/streams/:id/read",
      (req, _res, next) => {
        req.user = { id: "usr_1" } as NonNullable<express.Request["user"]>
        next()
      },
      audit("streams.get", "read"),
      (_req, res) => {
        setAuditSubjects(res, [{ type: "stream", id: "stream_1" }])
        res.status(200).json({ ok: true })
      }
    )

    await requestAndAwaitRow(app, "/api/workspaces/ws_1/streams/stream_9/read", rows)

    expect(rows[0]).toMatchObject({
      outcome: "success",
      detail: null,
      subjects: [{ type: "stream", id: "stream_1" }],
    })
  })
})

describe("audit() handler-declared no-op skip", () => {
  it("skips the row when a 2xx handler sets auditSkip (empty poll)", async () => {
    const { service, rows } = recordingService()
    const audit = createAuditMiddleware(service)
    const app = express()
    app.post("/api/workspaces/:workspaceId/claim", audit("public_api.claimBotInvocation", "read"), (_req, res) => {
      res.locals.auditSkip = true
      res.status(200).json({ data: null })
    })
    const server = app.listen(0)
    try {
      const port = (server.address() as AddressInfo).port
      await fetch(`http://127.0.0.1:${port}/api/workspaces/ws_1/claim`, { method: "POST" })
      await new Promise((r) => setTimeout(r, 100))
    } finally {
      server.close()
    }
    expect(rows).toHaveLength(0)
  })

  it("ignores auditSkip on a denial — a handler cannot opt a denied request out", async () => {
    const { service, rows } = recordingService()
    const audit = createAuditMiddleware(service)
    const app = express()
    app.post("/api/workspaces/:workspaceId/claim", audit("public_api.claimBotInvocation", "read"), (_req, res) => {
      res.locals.auditSkip = true
      res.status(403).json({ error: "bad key" })
    })

    await requestAndAwaitRow(app, "/api/workspaces/ws_1/claim", rows)

    expect(rows[0]).toMatchObject({ outcome: "denied", detail: { status: 403 } })
  })
})

describe("assertAuditCoverage", () => {
  it("passes when every /api route carries an audit annotation", () => {
    const audit = createAuditMiddleware(noopService)
    const app = express()
    app.get("/api/thing", audit("streams.get", "read"), (_req, res) => res.end())
    app.post("/api/other", audit("streams.create", "write"), (_req, res) => res.end())
    app.get("/api/avatar/:file", audit.none("unauthenticated avatar serve"), (_req, res) => res.end())
    // Non-/api routes are exempt from the guard.
    app.get("/readyz", (_req, res) => res.end())

    expect(() => assertAuditCoverage(app)).not.toThrow()
  })

  it("throws listing method+path for an unannotated /api route", () => {
    const audit = createAuditMiddleware(noopService)
    const app = express()
    app.get("/api/thing", audit("streams.get", "read"), (_req, res) => res.end())
    app.post("/api/unlogged", (_req, res) => res.end())

    expect(() => assertAuditCoverage(app)).toThrow(/POST \/api\/unlogged/)
  })

  it("throws on any mounted sub-router (its routes are invisible to the walk)", () => {
    const app = express()
    const sub = express.Router()
    sub.get("/hidden", (_req, res) => res.end())
    app.use("/api/v2", sub)

    expect(() => assertAuditCoverage(app)).toThrow(/mounted sub-router/)
  })

  it("throws on a router mounted outside /api too — Express 5 hides mount paths, strictness is deliberate", () => {
    const app = express()
    app.use("/apiary", express.Router())

    expect(() => assertAuditCoverage(app)).toThrow(/mounted sub-router/)
  })
})
