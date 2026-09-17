import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import { OutboxRepository } from "@threahq/backend-common"
import { AISpendControlsService, OUTBOX_AI_SPEND_CONTROLS_SYNC } from "../../src/features/ai-spend-controls"
import { WorkspaceRegistryRepository } from "../../src/features/workspaces"
import type { RegionalClient } from "../../src/lib/regional-client"
import { setupTestDatabase } from "./setup"

describe("AISpendControlsService", () => {
  let pool: Pool
  const workspaceIds: string[] = []

  function recordingClient() {
    const calls: unknown[][] = []
    const client = {
      async syncAISpendControls(...args: unknown[]) {
        calls.push(args)
      },
    } as unknown as RegionalClient
    return { client, calls }
  }

  async function seedWorkspace(): Promise<string> {
    const id = `ws_aispend_${crypto.randomUUID().replaceAll("-", "")}`
    workspaceIds.push(id)
    await WorkspaceRegistryRepository.insert(pool, {
      id,
      name: "AI spend",
      slug: id.replaceAll("_", "-"),
      region: "eu",
      createdByWorkosUserId: "workos_user_1",
    })
    return id
  }

  async function syncEvents(workspaceId: string) {
    const result = await pool.query<{ payload: unknown }>(
      `SELECT payload FROM outbox WHERE event_type = $1 AND payload->>'workspaceId' = $2 ORDER BY id`,
      [OUTBOX_AI_SPEND_CONTROLS_SYNC, workspaceId]
    )
    return result.rows.map((row) => row.payload)
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterEach(() => {
    mock.restore()
  })

  afterAll(async () => {
    await pool.query("DELETE FROM workspace_ai_spend_controls WHERE workspace_id = ANY($1)", [workspaceIds])
    await pool.query("DELETE FROM workspace_registry WHERE id = ANY($1)", [workspaceIds])
    await pool.query("DELETE FROM outbox WHERE event_type = $1", [OUTBOX_AI_SPEND_CONTROLS_SYNC])
    await pool.end()
  })

  test("reports defaults, stores a set with its sync event, and pushes the re-read snapshot to the region", async () => {
    const workspaceId = await seedWorkspace()
    const { client, calls } = recordingClient()
    const service = new AISpendControlsService({ pool, regionalClient: client })

    const before = await service.get(workspaceId)
    await service.set(workspaceId, { operatorCeilingUsd: 10, operatorAiDisabled: false })
    const returned = await service.set(workspaceId, { operatorCeilingUsd: 250.5, operatorAiDisabled: true })
    await service.syncToRegion({ workspaceId })

    expect({ before, returned, events: await syncEvents(workspaceId), calls }).toEqual({
      before: { operatorCeilingUsd: 100, operatorAiDisabled: false },
      returned: { operatorCeilingUsd: 250.5, operatorAiDisabled: true },
      events: [{ workspaceId }, { workspaceId }],
      calls: [["eu", { workspaceId, operatorCeilingUsd: 250.5, operatorAiDisabled: true }]],
    })
  })

  test("rolls the controls write back when the outbox insert fails", async () => {
    const workspaceId = await seedWorkspace()
    const service = new AISpendControlsService({ pool, regionalClient: recordingClient().client })
    spyOn(OutboxRepository, "insert").mockRejectedValue(new Error("outbox down"))

    await expect(service.set(workspaceId, { operatorCeilingUsd: 5, operatorAiDisabled: true })).rejects.toThrow(
      "outbox down"
    )
    expect(await service.get(workspaceId)).toEqual({ operatorCeilingUsd: 100, operatorAiDisabled: false })
  })

  test("404s for a workspace outside the registry and skips syncing one that is gone", async () => {
    const { client, calls } = recordingClient()
    const service = new AISpendControlsService({ pool, regionalClient: client })

    await expect(service.set("ws_missing", { operatorCeilingUsd: 1, operatorAiDisabled: false })).rejects.toMatchObject(
      { status: 404, code: "NOT_FOUND" }
    )
    await service.syncToRegion({ workspaceId: "ws_missing" })
    expect(calls).toEqual([])
  })
})
