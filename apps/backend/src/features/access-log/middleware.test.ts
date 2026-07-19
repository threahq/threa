import { describe, expect, it } from "bun:test"
import express from "express"
import { assertAuditCoverage, createAuditMiddleware } from "./middleware"
import type { AccessLogService } from "./service"

const noopService = { record() {} } as unknown as AccessLogService

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
