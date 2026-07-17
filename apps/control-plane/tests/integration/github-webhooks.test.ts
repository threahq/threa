import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { createHmac } from "crypto"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import express from "express"
import type { Pool } from "pg"
import { createRateLimit, getClientIp } from "@threa/backend-common"
import { createApp } from "../../src/app"
import {
  createGithubWebhookHandlers,
  GithubWebhookDispatchService,
  GithubWebhookService,
  GITHUB_WEBHOOK_PATH,
  verifyGithubSignature,
} from "../../src/features/github-webhooks"
import { IntegrationRouteRepository } from "../../src/features/integration-routes"
import type { RegionalClient } from "../../src/lib/regional-client"
import { setupTestDatabase } from "./setup"

const SECRET = "webhook-secret"

function sign(body: string, secret = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex")
}

function prPayload(installationId: number, prNumber: number, action = "synchronize"): string {
  return JSON.stringify({
    action,
    installation: { id: installationId },
    repository: { full_name: "acme/widgets" },
    pull_request: { number: prNumber, html_url: `https://github.com/acme/widgets/pull/${prNumber}` },
  })
}

async function addRoute(pool: Pool, installationId: number, region: string, workspaceId: string): Promise<void> {
  await IntegrationRouteRepository.upsert(pool, {
    id: `iroute_${region}_${workspaceId}`,
    provider: "github",
    externalId: String(installationId),
    region,
    workspaceId,
  })
}

async function dispatchRows(pool: Pool): Promise<Array<{ deliveryId: string; region: string }>> {
  const result = await pool.query<{ payload: { deliveryId: string; region: string } }>(
    "SELECT payload FROM outbox WHERE event_type = 'github_webhook_dispatch' ORDER BY id"
  )
  return result.rows.map((r) => r.payload)
}

describe("verifyGithubSignature", () => {
  const body = Buffer.from(prPayload(1, 1), "utf8")

  test("accepts a signature computed over the exact raw bytes", () => {
    expect(verifyGithubSignature(SECRET, body, sign(body.toString("utf8")))).toBe(true)
  })

  test("rejects a signature made with the wrong secret", () => {
    expect(verifyGithubSignature(SECRET, body, sign(body.toString("utf8"), "other"))).toBe(false)
  })

  test("rejects a missing header", () => {
    expect(verifyGithubSignature(SECRET, body, undefined)).toBe(false)
  })

  test("rejects a header whose length differs from the computed digest", () => {
    expect(verifyGithubSignature(SECRET, body, "sha256=deadbeef")).toBe(false)
  })

  test("rejects a tampered body", () => {
    const signature = sign(body.toString("utf8"))
    expect(verifyGithubSignature(SECRET, Buffer.from(prPayload(1, 2), "utf8"), signature)).toBe(false)
  })
})

describe("GithubWebhookService.receive", () => {
  let pool: Pool
  let service: GithubWebhookService

  beforeAll(async () => {
    pool = await setupTestDatabase()
    service = new GithubWebhookService({ pool, webhookSecret: SECRET })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("TRUNCATE integration_routes")
    await pool.query("TRUNCATE github_webhook_deliveries")
    await pool.query("DELETE FROM outbox WHERE event_type = 'github_webhook_dispatch'")
  })

  test("rejects an invalid signature and records nothing", async () => {
    const body = prPayload(42, 7)
    const result = await service.receive({
      rawBody: Buffer.from(body, "utf8"),
      signature: sign(body, "wrong-secret"),
      eventType: "pull_request",
      deliveryGuid: "guid-1",
    })
    expect(result).toEqual({ kind: "unauthorized" })

    const rows = await pool.query("SELECT COUNT(*)::int AS n FROM github_webhook_deliveries")
    expect(rows.rows[0].n).toBe(0)
  })

  test("rejects a missing signature", async () => {
    const body = prPayload(42, 7)
    const result = await service.receive({
      rawBody: Buffer.from(body, "utf8"),
      signature: undefined,
      eventType: "pull_request",
      deliveryGuid: "guid-1",
    })
    expect(result).toEqual({ kind: "unauthorized" })
  })

  test("answers a ping without dispatching", async () => {
    const body = JSON.stringify({ zen: "Keep it logically awesome." })
    const result = await service.receive({
      rawBody: Buffer.from(body, "utf8"),
      signature: sign(body),
      eventType: "ping",
      deliveryGuid: "guid-ping",
    })
    expect(result).toEqual({ kind: "pong" })
    expect(await dispatchRows(pool)).toEqual([])
  })

  test("ignores a non-forwarded event type and records nothing", async () => {
    const body = prPayload(42, 7)
    const result = await service.receive({
      rawBody: Buffer.from(body, "utf8"),
      signature: sign(body),
      eventType: "push",
      deliveryGuid: "guid-push",
    })
    expect(result).toEqual({ kind: "ignored" })

    const rows = await pool.query("SELECT COUNT(*)::int AS n FROM github_webhook_deliveries")
    expect(rows.rows[0].n).toBe(0)
  })

  test("acknowledges an unknown installation with no routes — records the delivery, dispatches nothing", async () => {
    const body = prPayload(999, 3)
    const result = await service.receive({
      rawBody: Buffer.from(body, "utf8"),
      signature: sign(body),
      eventType: "pull_request",
      deliveryGuid: "guid-unknown",
    })
    expect(result).toEqual({ kind: "accepted", matchedRegions: [] })

    const row = await pool.query(
      "SELECT status, matched_regions FROM github_webhook_deliveries WHERE delivery_guid = 'guid-unknown'"
    )
    expect(row.rows[0].status).toBe("no_routes")
    expect(row.rows[0].matched_regions).toEqual([])
    expect(await dispatchRows(pool)).toEqual([])
  })

  test("fans out one dispatch event per distinct region and records the delivery", async () => {
    await addRoute(pool, 42, "us-east-1", "ws_a")
    await addRoute(pool, 42, "eu-north-1", "ws_b")
    // Second workspace in an already-matched region — deduped by DISTINCT.
    await addRoute(pool, 42, "us-east-1", "ws_c")

    const body = prPayload(42, 12)
    const result = await service.receive({
      rawBody: Buffer.from(body, "utf8"),
      signature: sign(body),
      eventType: "pull_request",
      deliveryGuid: "guid-fanout",
    })
    expect(result.kind).toBe("accepted")
    expect(result.kind === "accepted" && [...result.matchedRegions].sort()).toEqual(["eu-north-1", "us-east-1"])

    const delivery = await pool.query<{
      id: string
      action: string
      installation_id: string
      repository_full_name: string
    }>(
      "SELECT id, action, installation_id, repository_full_name FROM github_webhook_deliveries WHERE delivery_guid = 'guid-fanout'"
    )
    expect(delivery.rows[0].action).toBe("synchronize")
    expect(delivery.rows[0].installation_id).toBe("42")
    expect(delivery.rows[0].repository_full_name).toBe("acme/widgets")

    const deliveryId = delivery.rows[0].id
    const dispatched = await dispatchRows(pool)
    expect([...dispatched].sort((a, b) => a.region.localeCompare(b.region))).toEqual([
      { deliveryId, region: "eu-north-1" },
      { deliveryId, region: "us-east-1" },
    ])
  })

  test("is idempotent on the delivery GUID — a retry dispatches nothing new", async () => {
    await addRoute(pool, 42, "us-east-1", "ws_a")
    const body = prPayload(42, 15)
    const input = {
      rawBody: Buffer.from(body, "utf8"),
      signature: sign(body),
      eventType: "pull_request",
      deliveryGuid: "guid-dupe",
    }

    const first = await service.receive(input)
    expect(first.kind).toBe("accepted")

    const second = await service.receive(input)
    expect(second).toEqual({ kind: "duplicate" })

    const count = await pool.query(
      "SELECT COUNT(*)::int AS n FROM github_webhook_deliveries WHERE delivery_guid = 'guid-dupe'"
    )
    expect(count.rows[0].n).toBe(1)
    // Exactly one dispatch event survives the retry.
    expect(await dispatchRows(pool)).toHaveLength(1)
  })

  test("a redelivery of a no_routes delivery dispatches once routes exist", async () => {
    const body = prPayload(42, 18)
    const input = {
      rawBody: Buffer.from(body, "utf8"),
      signature: sign(body),
      eventType: "pull_request",
      deliveryGuid: "guid-late-route",
    }

    // First delivery lands during the rollout window: no routes yet.
    const first = await service.receive(input)
    expect(first).toEqual({ kind: "accepted", matchedRegions: [] })
    const preStatus = await pool.query(
      "SELECT status FROM github_webhook_deliveries WHERE delivery_guid = 'guid-late-route'"
    )
    expect(preStatus.rows[0].status).toBe("no_routes")
    expect(await dispatchRows(pool)).toEqual([])

    // Route registers, then GitHub's manual Redeliver replays the same GUID.
    await addRoute(pool, 42, "us-east-1", "ws_late")
    const redelivery = await service.receive(input)
    expect(redelivery).toEqual({ kind: "accepted", matchedRegions: ["us-east-1"] })

    const row = await pool.query<{ id: string; status: string; matched_regions: string[] }>(
      "SELECT id, status, matched_regions FROM github_webhook_deliveries WHERE delivery_guid = 'guid-late-route'"
    )
    expect(row.rows[0].status).toBe("dispatched")
    expect(row.rows[0].matched_regions).toEqual(["us-east-1"])
    expect(await dispatchRows(pool)).toEqual([{ deliveryId: row.rows[0].id, region: "us-east-1" }])

    // A second redelivery is now a plain duplicate — no double dispatch.
    const third = await service.receive(input)
    expect(third).toEqual({ kind: "duplicate" })
    expect(await dispatchRows(pool)).toHaveLength(1)
  })
})

interface RecordedDispatch {
  region: string
  data: {
    deliveryGuid: string
    eventType: string
    action: string | null
    installationId: string | null
    repositoryFullName: string | null
    payload: Record<string, unknown>
  }
}

class RecordingRegionalClient {
  calls: RecordedDispatch[] = []
  async dispatchGithubWebhook(region: string, data: RecordedDispatch["data"]): Promise<void> {
    this.calls.push({ region, data })
  }
}

describe("GithubWebhookDispatchService.dispatch", () => {
  let pool: Pool
  let service: GithubWebhookService
  let regionalClient: RecordingRegionalClient
  let dispatchService: GithubWebhookDispatchService

  beforeAll(async () => {
    pool = await setupTestDatabase()
    service = new GithubWebhookService({ pool, webhookSecret: SECRET })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("TRUNCATE integration_routes")
    await pool.query("TRUNCATE github_webhook_deliveries")
    await pool.query("DELETE FROM outbox WHERE event_type = 'github_webhook_dispatch'")
    regionalClient = new RecordingRegionalClient()
    dispatchService = new GithubWebhookDispatchService({
      pool,
      regionalClient: regionalClient as unknown as RegionalClient,
    })
  })

  test("reads the delivery row and forwards its payload to the target region", async () => {
    await addRoute(pool, 42, "us-east-1", "ws_a")
    const body = prPayload(42, 20, "opened")
    await service.receive({
      rawBody: Buffer.from(body, "utf8"),
      signature: sign(body),
      eventType: "pull_request",
      deliveryGuid: "guid-dispatch",
    })
    const [event] = await dispatchRows(pool)

    await dispatchService.dispatch(event)

    expect(regionalClient.calls).toHaveLength(1)
    expect(regionalClient.calls[0]).toMatchObject({
      region: "us-east-1",
      data: {
        deliveryGuid: "guid-dispatch",
        eventType: "pull_request",
        action: "opened",
        installationId: "42",
        repositoryFullName: "acme/widgets",
      },
    })
    expect(regionalClient.calls[0].data.payload).toMatchObject({
      pull_request: { number: 20 },
    })
  })

  test("no-ops when the delivery row is missing", async () => {
    await dispatchService.dispatch({ deliveryId: "ghwd_missing", region: "us-east-1" })
    expect(regionalClient.calls).toEqual([])
  })
})

/**
 * End-to-end through the real createApp middleware chain: proves the JSON parser
 * is skipped for the webhook path so express.raw receives the exact bytes the
 * signature was computed over (the load-bearing wiring for HMAC verification).
 */
describe("github webhook HTTP route (raw body)", () => {
  let pool: Pool
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    const app = createApp({ corsAllowedOrigins: ["http://localhost"] })
    const service = new GithubWebhookService({ pool, webhookSecret: SECRET })
    const handlers = createGithubWebhookHandlers({ service })
    app.post(GITHUB_WEBHOOK_PATH, express.raw({ type: "application/json", limit: "5mb" }), handlers.receive)

    server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const { port } = server.address() as AddressInfo
    baseUrl = `http://localhost:${port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("TRUNCATE integration_routes")
    await pool.query("TRUNCATE github_webhook_deliveries")
    await pool.query("DELETE FROM outbox WHERE event_type = 'github_webhook_dispatch'")
  })

  async function post(body: string, headers: Record<string, string>): Promise<Response> {
    return fetch(`${baseUrl}${GITHUB_WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    })
  }

  test("accepts a correctly signed delivery and records the raw payload", async () => {
    await addRoute(pool, 77, "us-east-1", "ws_http")
    const body = prPayload(77, 31, "opened")
    const res = await post(body, {
      "X-Hub-Signature-256": sign(body),
      "X-GitHub-Event": "pull_request",
      "X-GitHub-Delivery": "guid-http-ok",
    })
    expect(res.status).toBe(202)

    const row = await pool.query<{ installation_id: string; action: string }>(
      "SELECT installation_id, action FROM github_webhook_deliveries WHERE delivery_guid = 'guid-http-ok'"
    )
    expect(row.rows[0]).toMatchObject({ installation_id: "77", action: "opened" })
    expect(await dispatchRows(pool)).toHaveLength(1)
  })

  test("rejects a delivery whose signature does not match the transmitted bytes with a 401", async () => {
    const body = prPayload(77, 31)
    const res = await post(body, {
      "X-Hub-Signature-256": sign(prPayload(77, 999)),
      "X-GitHub-Event": "pull_request",
      "X-GitHub-Delivery": "guid-http-bad",
    })
    expect(res.status).toBe(401)

    const count = await pool.query("SELECT COUNT(*)::int AS n FROM github_webhook_deliveries")
    expect(count.rows[0].n).toBe(0)
  })
})

/**
 * The global per-IP rate limit must never touch the webhook path. GitHub
 * delivers from a small pool of source IPs and a delivery storm can exceed the
 * cap; a 429 makes GitHub auto-disable the App's single webhook URL. This mounts
 * globalLimit before the webhook route with the same skip predicate registerRoutes
 * uses, plus the dedicated generous `cp-github-webhook` limiter registerRoutes mounts
 * in front of the route, proving a flood on the webhook path stays 2xx (exempt from
 * the global cap, under the dedicated one) while an ordinary path 429s.
 */
describe("github webhook is exempt from the global rate limit", () => {
  let pool: Pool
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    const app = createApp({ corsAllowedOrigins: ["http://localhost"] })
    const globalLimit = createRateLimit({
      name: "cp-global",
      windowMs: 60_000,
      max: 2,
      key: (req) => getClientIp(req, "unknown"),
      skip: (req) => {
        const path = req.path.length > 1 ? req.path.replace(/\/$/, "") : req.path
        return path === GITHUB_WEBHOOK_PATH
      },
    })
    const webhookLimit = createRateLimit({
      name: "cp-github-webhook",
      windowMs: 60_000,
      max: 5000,
      key: (req) => getClientIp(req, "unknown"),
    })
    app.use(globalLimit)
    app.get("/api/_ratelimit_probe", (_req, res) => res.json({ ok: true }))
    const service = new GithubWebhookService({ pool, webhookSecret: SECRET })
    const handlers = createGithubWebhookHandlers({ service })
    app.post(
      GITHUB_WEBHOOK_PATH,
      webhookLimit,
      express.raw({ type: "application/json", limit: "5mb" }),
      handlers.receive
    )

    server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const { port } = server.address() as AddressInfo
    baseUrl = `http://localhost:${port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("TRUNCATE integration_routes")
    await pool.query("TRUNCATE github_webhook_deliveries")
    await pool.query("DELETE FROM outbox WHERE event_type = 'github_webhook_dispatch'")
  })

  test("an ordinary path 429s past the cap but the webhook path never does", async () => {
    // Control: the same limiter throttles a normal path past max=2.
    const probeStatuses: number[] = []
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${baseUrl}/api/_ratelimit_probe`)
      probeStatuses.push(res.status)
    }
    expect(probeStatuses).toEqual([200, 200, 429, 429])

    // Webhook: well past the cap, every delivery is accepted (never 429).
    await addRoute(pool, 88, "us-east-1", "ws_flood")
    const webhookStatuses: number[] = []
    for (let i = 0; i < 6; i++) {
      const body = prPayload(88, 40 + i, "synchronize")
      const res = await post(body, {
        "X-Hub-Signature-256": sign(body),
        "X-GitHub-Event": "pull_request",
        "X-GitHub-Delivery": `guid-flood-${i}`,
      })
      webhookStatuses.push(res.status)
    }
    expect(webhookStatuses).toEqual([202, 202, 202, 202, 202, 202])
  })

  async function post(body: string, headers: Record<string, string>): Promise<Response> {
    return fetch(`${baseUrl}${GITHUB_WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    })
  }
})
