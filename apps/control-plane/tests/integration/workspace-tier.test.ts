import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import { OutboxRepository, type WorkosOrgService } from "@threahq/backend-common"
import type { WorkspaceTier } from "@threahq/types"
import type { InvitationShadowService } from "../../src/features/invitation-shadows"
import type { PlatformAdminSyncService } from "../../src/features/platform-admin"
import {
  ControlPlaneWorkspaceService,
  createWorkspaceHandlers,
  OUTBOX_WORKSPACE_TIER_SYNC,
  WorkspaceRegistryRepository,
} from "../../src/features/workspaces"
import type { KvClient } from "../../src/lib/cloudflare-kv-client"
import type { RegionalClient } from "../../src/lib/regional-client"
import { setupTestDatabase } from "./setup"

describe("workspace tier", () => {
  let pool: Pool
  const workspaceIds: string[] = []

  function recordingClient() {
    const calls: unknown[][] = []
    const client = {
      async syncWorkspaceTier(...args: unknown[]) {
        calls.push(args)
      },
    } as unknown as RegionalClient
    return { client, calls }
  }

  function createService(regionalClient: RegionalClient) {
    return new ControlPlaneWorkspaceService({
      pool,
      regionalClient,
      workosOrgService: {} as WorkosOrgService,
      kvClient: {} as KvClient,
      platformAdminSync: {} as PlatformAdminSyncService,
      availableRegions: ["eu"],
      requireWorkspaceCreationInvite: false,
    })
  }

  async function seedWorkspace(): Promise<string> {
    const id = `ws_tier_${crypto.randomUUID().replaceAll("-", "")}`
    workspaceIds.push(id)
    await WorkspaceRegistryRepository.insert(pool, {
      id,
      name: "Tier",
      slug: id.replaceAll("_", "-"),
      region: "eu",
      createdByWorkosUserId: "workos_user_1",
    })
    return id
  }

  async function storedTier(workspaceId: string): Promise<WorkspaceTier | undefined> {
    return (await WorkspaceRegistryRepository.findById(pool, workspaceId))?.tier
  }

  async function syncEvents(workspaceId: string) {
    const result = await pool.query<{ payload: unknown }>(
      `SELECT payload FROM outbox WHERE event_type = $1 AND payload->>'workspaceId' = $2 ORDER BY id`,
      [OUTBOX_WORKSPACE_TIER_SYNC, workspaceId]
    )
    return result.rows.map((row) => row.payload)
  }

  async function callSetTier(service: ControlPlaneWorkspaceService, workspaceId: string, body: unknown) {
    const handlers = createWorkspaceHandlers({
      workspaceService: service,
      shadowService: {} as InvitationShadowService,
    })
    const responses: unknown[] = []
    const res = { json: (payload: unknown) => responses.push(payload) } as unknown as Response
    const req = { params: { id: workspaceId }, body } as unknown as Request
    await handlers.setTier(req, res)
    return responses
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterEach(() => {
    mock.restore()
  })

  afterAll(async () => {
    await pool.query("DELETE FROM workspace_registry WHERE id = ANY($1)", [workspaceIds])
    await pool.query("DELETE FROM outbox WHERE event_type = $1 AND payload->>'workspaceId' = ANY($2)", [
      OUTBOX_WORKSPACE_TIER_SYNC,
      workspaceIds,
    ])
    await pool.end()
  })

  test("stores a set with its sync event and pushes the current tier, not the event-time one", async () => {
    const workspaceId = await seedWorkspace()
    const { client, calls } = recordingClient()
    const service = createService(client)

    const before = await storedTier(workspaceId)
    const first = await service.setTier(workspaceId, "connect")
    const second = await service.setTier(workspaceId, "full")
    await service.syncTierToRegion({ workspaceId })

    expect({
      before,
      first,
      second,
      stored: await storedTier(workspaceId),
      events: await syncEvents(workspaceId),
      calls,
    }).toEqual({
      before: "full",
      first: "connect",
      second: "full",
      stored: "full",
      events: [{ workspaceId }, { workspaceId }],
      calls: [["eu", { workspaceId, tier: "full" }]],
    })
  })

  test("rolls the tier write back when the outbox insert fails", async () => {
    const workspaceId = await seedWorkspace()
    const service = createService(recordingClient().client)
    spyOn(OutboxRepository, "insert").mockRejectedValue(new Error("outbox down"))

    await expect(service.setTier(workspaceId, "connect")).rejects.toThrow("outbox down")
    expect({ stored: await storedTier(workspaceId), events: await syncEvents(workspaceId) }).toEqual({
      stored: "full",
      events: [],
    })
  })

  test("404s for a workspace outside the registry and skips syncing one that is gone", async () => {
    const { client, calls } = recordingClient()
    const service = createService(client)

    await expect(service.setTier("ws_missing", "connect")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" })
    await service.syncTierToRegion({ workspaceId: "ws_missing" })
    expect(calls).toEqual([])
  })

  test("accepts a listed tier through the handler and rejects anything else without writing", async () => {
    const workspaceId = await seedWorkspace()
    const service = createService(recordingClient().client)

    const accepted = await callSetTier(service, workspaceId, { tier: "connect" })
    const rejections = await Promise.all(
      [{ tier: "enterprise" }, { tier: "full", extra: true }, {}].map((body) =>
        callSetTier(service, workspaceId, body).catch((error: unknown) => error)
      )
    )

    expect({ accepted, rejections, stored: await storedTier(workspaceId) }).toEqual({
      accepted: [{ tier: "connect" }],
      rejections: [1, 2, 3].map(() => expect.objectContaining({ status: 400, code: "VALIDATION_ERROR" })),
      stored: "connect",
    })
  })
})
