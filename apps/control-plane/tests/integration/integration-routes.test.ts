import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import { HttpError } from "@threa/backend-common"
import { createIntegrationRouteHandlers, IntegrationRouteRepository } from "../../src/features/integration-routes"
import { setupTestDatabase } from "./setup"

interface CapturedResponse {
  statusCode: number
  body: unknown
}

function mockResponse(): { res: Response; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 0, body: undefined }
  const res = {
    status(code: number) {
      captured.statusCode = code
      return this
    },
    json(payload: unknown) {
      captured.body = payload
      return this
    },
  } as unknown as Response
  return { res, captured }
}

/**
 * CP owns the installation -> region routing table. Registration is a race-safe
 * upsert keyed on (provider, external_id, workspace_id); fan-out reads DISTINCT
 * regions; disconnect deletes the precise (provider, external_id, workspace_id)
 * row. Multiple workspaces per installation is the normal case.
 */
describe("IntegrationRouteRepository", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("TRUNCATE integration_routes")
  })

  test("upsert is idempotent on (provider, external_id, workspace_id) and refreshes region", async () => {
    const first = await IntegrationRouteRepository.upsert(pool, {
      id: "iroute_1",
      provider: "github",
      externalId: "42",
      region: "us-east-1",
      workspaceId: "ws_a",
    })
    expect(first.region).toBe("us-east-1")

    const second = await IntegrationRouteRepository.upsert(pool, {
      id: "iroute_2",
      provider: "github",
      externalId: "42",
      region: "eu-north-1",
      workspaceId: "ws_a",
    })
    // Same natural key — the original row is updated, not duplicated.
    expect(second.id).toBe("iroute_1")
    expect(second.region).toBe("eu-north-1")

    const count = await pool.query("SELECT COUNT(*)::int AS n FROM integration_routes")
    expect(count.rows[0].n).toBe(1)
  })

  test("listRegions returns the distinct regions of every subscribed workspace", async () => {
    await IntegrationRouteRepository.upsert(pool, {
      id: "iroute_a",
      provider: "github",
      externalId: "42",
      region: "us-east-1",
      workspaceId: "ws_a",
    })
    await IntegrationRouteRepository.upsert(pool, {
      id: "iroute_b",
      provider: "github",
      externalId: "42",
      region: "eu-north-1",
      workspaceId: "ws_b",
    })
    // Third workspace, same installation, same region as the first — deduped.
    await IntegrationRouteRepository.upsert(pool, {
      id: "iroute_c",
      provider: "github",
      externalId: "42",
      region: "us-east-1",
      workspaceId: "ws_c",
    })

    const regions = await IntegrationRouteRepository.listRegions(pool, "github", "42")
    expect([...regions].sort()).toEqual(["eu-north-1", "us-east-1"])
  })

  test("delete removes only the targeted workspace's route", async () => {
    await IntegrationRouteRepository.upsert(pool, {
      id: "iroute_a",
      provider: "github",
      externalId: "42",
      region: "us-east-1",
      workspaceId: "ws_a",
    })
    await IntegrationRouteRepository.upsert(pool, {
      id: "iroute_b",
      provider: "github",
      externalId: "42",
      region: "eu-north-1",
      workspaceId: "ws_b",
    })

    const deleted = await IntegrationRouteRepository.delete(pool, {
      provider: "github",
      externalId: "42",
      workspaceId: "ws_a",
    })
    expect(deleted).toBe(1)

    const regions = await IntegrationRouteRepository.listRegions(pool, "github", "42")
    expect(regions).toEqual(["eu-north-1"])
  })

  test("delete of a non-existent route reports zero rows removed", async () => {
    const deleted = await IntegrationRouteRepository.delete(pool, {
      provider: "github",
      externalId: "does-not-exist",
      workspaceId: "ws_a",
    })
    expect(deleted).toBe(0)
  })
})

describe("integration-route handlers", () => {
  let pool: Pool
  let handlers: ReturnType<typeof createIntegrationRouteHandlers>

  beforeAll(async () => {
    pool = await setupTestDatabase()
    handlers = createIntegrationRouteHandlers({ pool })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("TRUNCATE integration_routes")
  })

  test("register persists the route and returns it with a 200", async () => {
    const { res, captured } = mockResponse()
    await handlers.register(
      { body: { provider: "github", externalId: "42", region: "us-east-1", workspaceId: "ws_a" } } as Request,
      res
    )

    expect(captured.statusCode).toBe(200)
    const route = (captured.body as { route: { region: string; workspace_id: string } }).route
    expect(route.region).toBe("us-east-1")
    expect(route.workspace_id).toBe("ws_a")

    const regions = await IntegrationRouteRepository.listRegions(pool, "github", "42")
    expect(regions).toEqual(["us-east-1"])
  })

  test("register rejects an invalid body with a 400 VALIDATION_ERROR", async () => {
    const { res } = mockResponse()
    const promise = handlers.register({ body: { provider: "github" } } as Request, res)
    await expect(promise).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" })
    await expect(promise).rejects.toBeInstanceOf(HttpError)
  })

  test("unregister parses the request body and deletes the matching route", async () => {
    await IntegrationRouteRepository.upsert(pool, {
      id: "iroute_del",
      provider: "github",
      externalId: "42",
      region: "us-east-1",
      workspaceId: "ws_a",
    })

    const { res, captured } = mockResponse()
    await handlers.unregister({ body: { provider: "github", externalId: "42", workspaceId: "ws_a" } } as Request, res)

    expect(captured.statusCode).toBe(200)
    expect(captured.body).toEqual({ deleted: 1 })

    const regions = await IntegrationRouteRepository.listRegions(pool, "github", "42")
    expect(regions).toEqual([])
  })

  test("unregister rejects an invalid body with a 400 VALIDATION_ERROR", async () => {
    const { res } = mockResponse()
    const promise = handlers.unregister({ body: {} } as Request, res)
    await expect(promise).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" })
    await expect(promise).rejects.toBeInstanceOf(HttpError)
  })
})
