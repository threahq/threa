/**
 * The control plane's AI spending service over the real workspace registry and
 * the real `RegionalClient`, talking HTTP to controlled local regional
 * endpoints. Proves region routing, acknowledged-only results, structured
 * rejection passthrough and 502 on anything the region did not acknowledge.
 * Route auth and HTTP statuses at the CP edge are covered by the e2e suite.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http"
import type { Pool } from "pg"
import { HttpError, INTERNAL_API_KEY_HEADER } from "@threahq/backend-common"
import { AI_SPENDING_COVERAGE, type AISpendingPolicyUpdate, type AISpendingPolicyWire } from "@threahq/types"
import { ControlPlaneAISpendingService } from "../../src/features/ai-spending"
import { RegionalClient } from "../../src/lib/regional-client"
import { setupTestDatabase } from "./setup"

const INTERNAL_KEY = "ai-spending-internal-key"
const OPERATOR = "workos_user_operator"
const runId = crypto.randomUUID().slice(0, 8)

interface RecordedRequest {
  method: string
  url: string
  internalKey: string | undefined
  body: unknown
}

type Responder = (req: RecordedRequest, res: ServerResponse) => void

interface ControlledRegion {
  url: string
  requests: RecordedRequest[]
  respond: Responder
  stop: () => Promise<void>
}

async function startRegion(): Promise<ControlledRegion> {
  const region: ControlledRegion = {
    url: "",
    requests: [],
    respond: (_req, res) => json(res, 500, { error: "no responder" }),
    stop: async () => {},
  }
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString()
      const recorded = {
        method: req.method ?? "",
        url: req.url ?? "",
        internalKey: req.headers[INTERNAL_API_KEY_HEADER.toLowerCase()] as string | undefined,
        body: raw ? JSON.parse(raw) : undefined,
      }
      region.requests.push(recorded)
      region.respond(recorded, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address !== "object") throw new Error("controlled region has no address")
  region.url = `http://127.0.0.1:${address.port}`
  region.stop = () => new Promise((resolve) => server.close(() => resolve()))
  return region
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

function policy(workspaceId: string, version: number): AISpendingPolicyWire {
  return {
    workspaceId,
    status: "enforced",
    version,
    limits: {
      agentCutoffUsd: "0.00000001",
      enrichmentCutoffUsd: "1.5",
      coreCutoffUsd: "2",
      embeddingCutoffUsd: "3",
      operatorCeilingUsd: "999999999999.99999999",
    },
    coverageProfile: AI_SPENDING_COVERAGE.profile,
    emergencyLatched: false,
    statusChangedAt: "2026-09-16T10:00:00.000Z",
    statusChangedBy: OPERATOR,
    updatedBy: OPERATOR,
  }
}

const UPDATE: AISpendingPolicyUpdate = {
  expectedVersion: 1,
  status: "enforced",
  coverageProfile: AI_SPENDING_COVERAGE.profile,
  limits: {
    agentCutoffUsd: "0.00000001",
    enrichmentCutoffUsd: "1.50",
    coreCutoffUsd: "2",
    embeddingCutoffUsd: "3",
    operatorCeilingUsd: "999999999999.99999999",
  },
}

async function rejection(promise: Promise<unknown>): Promise<{ status: number; code: string | undefined }> {
  try {
    await promise
  } catch (err) {
    if (!(err instanceof HttpError)) throw err
    return { status: err.status, code: err.code }
  }
  throw new Error("expected a rejection")
}

describe("ControlPlaneAISpendingService", () => {
  let pool: Pool
  let owning: ControlledRegion
  let other: ControlledRegion
  let service: ControlPlaneAISpendingService
  let seq = 0

  beforeAll(async () => {
    pool = await setupTestDatabase()
    owning = await startRegion()
    other = await startRegion()
    other.respond = (_req, res) => json(res, 500, { error: "wrong region contacted" })
    const closed = await startRegion()
    await closed.stop()
    const regionalClient = new RegionalClient(
      {
        "region-owning": { internalUrl: owning.url },
        "region-other": { internalUrl: other.url },
        "region-down": { internalUrl: closed.url },
      },
      INTERNAL_KEY
    )
    service = new ControlPlaneAISpendingService({ pool, regionalClient })
  })

  afterAll(async () => {
    await owning.stop()
    await other.stop()
    await pool.end()
  })

  async function registeredWorkspace(region = "region-owning"): Promise<string> {
    seq += 1
    const id = `ws_aispend_${runId}_${seq}`
    await pool.query(
      `INSERT INTO workspace_registry (id, name, slug, region, created_by_workos_user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, "AI spend", `ai-spend-${runId}-${seq}`, region, "workos_user_owner"]
    )
    owning.requests.length = 0
    other.requests.length = 0
    return id
  }

  test("should forward the versioned command with the operator to the owning region only", async () => {
    const workspaceId = await registeredWorkspace()
    owning.respond = (_req, res) => json(res, 200, { policy: policy(workspaceId, 2) })

    const saved = await service.setWorkspacePolicy({ workspaceId, operatorWorkosUserId: OPERATOR, update: UPDATE })

    expect(saved).toEqual(policy(workspaceId, 2))
    expect(owning.requests).toEqual([
      {
        method: "PUT",
        url: `/internal/ai-spending/workspaces/${workspaceId}`,
        internalKey: INTERNAL_KEY,
        body: { ...UPDATE, operatorWorkosUserId: OPERATOR },
      },
    ])
    expect(other.requests).toEqual([])
  })

  test("should return the region's overview as acknowledged", async () => {
    const workspaceId = await registeredWorkspace()
    const overview = {
      workspaceId,
      policy: null,
      currentPeriod: null,
      coverage: AI_SPENDING_COVERAGE,
    }
    owning.respond = (_req, res) => json(res, 200, overview)

    expect(await service.getWorkspaceSpending(workspaceId)).toEqual(overview)
    expect(owning.requests.map((r) => ({ method: r.method, url: r.url, internalKey: r.internalKey }))).toEqual([
      { method: "GET", url: `/internal/ai-spending/workspaces/${workspaceId}`, internalKey: INTERNAL_KEY },
    ])
  })

  test("should return 404 for a workspace missing from the registry without contacting any region", async () => {
    const workspaceId = `ws_aispend_absent_${runId}`
    owning.requests.length = 0

    expect(await rejection(service.getWorkspaceSpending(workspaceId))).toEqual({ status: 404, code: "NOT_FOUND" })
    expect(
      await rejection(service.setWorkspacePolicy({ workspaceId, operatorWorkosUserId: OPERATOR, update: UPDATE }))
    ).toEqual({ status: 404, code: "NOT_FOUND" })
    expect(owning.requests).toEqual([])
    expect(other.requests).toEqual([])
  })

  test("should preserve structured regional 400, 404 and 409 rejections", async () => {
    const workspaceId = await registeredWorkspace()
    const results = []
    for (const [status, code] of [
      [409, "STALE_SPEND_POLICY"],
      [409, "SPEND_COVERAGE_NOT_ACKNOWLEDGED"],
      [400, "INVALID_USD"],
      [404, "WORKSPACE_NOT_FOUND"],
    ] as const) {
      owning.respond = (_req, res) => json(res, status, { error: "rejected", code })
      results.push(
        await rejection(service.setWorkspacePolicy({ workspaceId, operatorWorkosUserId: OPERATOR, update: UPDATE }))
      )
    }
    expect(results).toEqual([
      { status: 409, code: "STALE_SPEND_POLICY" },
      { status: 409, code: "SPEND_COVERAGE_NOT_ACKNOWLEDGED" },
      { status: 400, code: "INVALID_USD" },
      { status: 404, code: "WORKSPACE_NOT_FOUND" },
    ])
  })

  test("should report 502 for anything the region did not acknowledge", async () => {
    const workspaceId = await registeredWorkspace()
    const responders: Responder[] = [
      (_req, res) => json(res, 500, { error: "Internal server error", code: "INTERNAL_ERROR" }),
      (_req, res) => json(res, 503, { error: "unavailable" }),
      (_req, res) => json(res, 401, { error: "Unauthorized", code: "UNAUTHORIZED" }),
      (_req, res) => json(res, 404, { error: "Not found" }),
      (_req, res) => json(res, 200, { policy: { ...policy(workspaceId, 2), limits: { agentCutoffUsd: 1 } } }),
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end("<html>proxy</html>")
      },
    ]
    const results = []
    for (const responder of responders) {
      owning.respond = responder
      results.push(
        await rejection(service.setWorkspacePolicy({ workspaceId, operatorWorkosUserId: OPERATOR, update: UPDATE }))
      )
    }
    expect(results).toEqual(responders.map(() => ({ status: 502, code: "REGION_UNAVAILABLE" })))

    const down = await registeredWorkspace("region-down")
    const unconfigured = await registeredWorkspace("region-retired")
    expect(await rejection(service.getWorkspaceSpending(down))).toEqual({ status: 502, code: "REGION_UNAVAILABLE" })
    expect(
      await rejection(
        service.setWorkspacePolicy({ workspaceId: unconfigured, operatorWorkosUserId: OPERATOR, update: UPDATE })
      )
    ).toEqual({ status: 502, code: "REGION_UNAVAILABLE" })
    expect(other.requests).toEqual([])

    const cpTables = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name ILIKE '%spend%'"
    )
    expect(cpTables.rows).toEqual([])
  })

  test("should report 502 for a well-formed answer that does not acknowledge this workspace or command", async () => {
    const workspaceId = await registeredWorkspace()
    const foreignId = `ws_aispend_foreign_${runId}`
    const coverage = AI_SPENDING_COVERAGE
    const period = {
      id: "spendperiod_1",
      workspaceId: foreignId,
      startsAt: "2026-09-01T00:00:00.000Z",
      endsAt: "2026-10-01T00:00:00.000Z",
      timezone: "UTC",
      settledUsd: "0",
      committedUsd: "0",
    }
    const overviews = [
      { workspaceId: foreignId, policy: null, currentPeriod: null, coverage },
      { workspaceId, policy: policy(foreignId, 2), currentPeriod: null, coverage },
      { workspaceId, policy: null, currentPeriod: period, coverage },
    ]
    const acks: AISpendingPolicyWire[] = [
      policy(foreignId, 2),
      policy(workspaceId, 7),
      { ...policy(workspaceId, 2), updatedBy: "workos_user_someone_else" },
      { ...policy(workspaceId, 2), status: "disabled" },
    ]

    const results = []
    for (const overview of overviews) {
      owning.respond = (_req, res) => json(res, 200, overview)
      results.push(await rejection(service.getWorkspaceSpending(workspaceId)))
    }
    for (const ack of acks) {
      owning.respond = (_req, res) => json(res, 200, { policy: ack })
      results.push(
        await rejection(service.setWorkspacePolicy({ workspaceId, operatorWorkosUserId: OPERATOR, update: UPDATE }))
      )
    }
    expect(results).toEqual([...overviews, ...acks].map(() => ({ status: 502, code: "REGION_UNAVAILABLE" })))
  })

  // A reused keep-alive socket that dies mid-request is retried by fetch itself,
  // so a lost acknowledgement surfaces as either 502 or the retry's stale 409.
  test("should never report success for a lost acknowledgement and apply the write at most once", async () => {
    const workspaceId = await registeredWorkspace()
    let stored: AISpendingPolicyWire = {
      ...policy(workspaceId, 1),
      status: "unprotected",
      limits: null,
      coverageProfile: null,
    }
    let appliedWrites = 0
    owning.respond = (req, res) => {
      if (req.method === "GET") {
        json(res, 200, {
          workspaceId,
          policy: stored,
          currentPeriod: null,
          coverage: AI_SPENDING_COVERAGE,
        })
        return
      }
      if ((req.body as { expectedVersion: number }).expectedVersion !== stored.version) {
        json(res, 409, { error: "stale", code: "STALE_SPEND_POLICY" })
        return
      }
      stored = policy(workspaceId, stored.version + 1)
      appliedWrites += 1
      res.socket?.destroy()
    }

    const lost = await rejection(
      service.setWorkspacePolicy({ workspaceId, operatorWorkosUserId: OPERATOR, update: UPDATE })
    )
    expect<{ status: number; code: string | undefined }[]>([
      { status: 502, code: "REGION_UNAVAILABLE" },
      { status: 409, code: "STALE_SPEND_POLICY" },
    ]).toContainEqual(lost)
    expect((await service.getWorkspaceSpending(workspaceId)).policy).toEqual(policy(workspaceId, 2))
    expect(
      await rejection(service.setWorkspacePolicy({ workspaceId, operatorWorkosUserId: OPERATOR, update: UPDATE }))
    ).toEqual({ status: 409, code: "STALE_SPEND_POLICY" })
    expect(appliedWrites).toBe(1)
  })
})
