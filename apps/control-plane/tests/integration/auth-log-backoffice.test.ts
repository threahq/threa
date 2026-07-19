import { EventEmitter } from "events"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import type { Request, Response } from "express"
import { AuthLogService, createBackofficeAuditMiddleware } from "../../src/features/auth-log"
import { setupTestDatabase } from "./setup"

function fakeReqRes(overrides: Partial<Request>): { req: Request; res: Response & EventEmitter } {
  const req = {
    method: "GET",
    path: "/workspaces/ws_1/members",
    ip: "203.0.113.5",
    headers: { "user-agent": "backoffice-ua" },
    ...overrides,
  } as unknown as Request
  const res = new EventEmitter() as Response & EventEmitter
  ;(res as { statusCode: number }).statusCode = 200
  return { req, res }
}

describe("backoffice audit middleware", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  async function pollRow(where: string, params: unknown[]): Promise<Record<string, unknown> | null> {
    for (let attempt = 0; attempt < 40; attempt++) {
      const { rows } = await pool.query(
        `SELECT workos_user_id, email, outcome, detail FROM auth_log
         WHERE event_type = 'cp.backoffice_request' AND ${where} ORDER BY occurred_at DESC LIMIT 1`,
        params
      )
      if (rows.length > 0) return rows[0]
      await new Promise((r) => setTimeout(r, 50))
    }
    return null
  }

  test("records an admin read with identity, path detail, and success outcome", async () => {
    const service = new AuthLogService({ pool })
    const middleware = createBackofficeAuditMiddleware(service)
    const { req, res } = fakeReqRes({
      workosUserId: "user_admin_1",
      authUser: { id: "user_admin_1", email: "admin@threa.io" },
    } as Partial<Request>)

    middleware(req, res, () => {})
    res.emit("finish")

    const row = await pollRow("workos_user_id = $1", ["user_admin_1"])
    expect(row).toMatchObject({
      workos_user_id: "user_admin_1",
      email: "admin@threa.io",
      outcome: "success",
      detail: { method: "GET", path: "/workspaces/ws_1/members", status: 200 },
    })
  })

  test("records a denied hit without identity", async () => {
    const service = new AuthLogService({ pool })
    const middleware = createBackofficeAuditMiddleware(service)
    const { req, res } = fakeReqRes({ path: "/config", ip: "203.0.113.9" })
    ;(res as { statusCode: number }).statusCode = 403

    middleware(req, res, () => {})
    res.emit("finish")

    const row = await pollRow("detail->>'path' = $1 AND outcome = 'denied'", ["/config"])
    expect(row).toMatchObject({
      workos_user_id: null,
      outcome: "denied",
      detail: { method: "GET", path: "/config", status: 403 },
    })
  })
})
