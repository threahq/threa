import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool, PoolClient } from "pg"
import { FollowUpStatuses } from "@threa/types"
import { AgentFollowUpService } from "./follow-up-service"
import { AgentFollowUpRepository, type AgentFollowUp } from "./follow-up-repository"
import { JobQueues, QueueRepository } from "../../lib/queue"
import * as dbModule from "../../db"
import { DEFAULT_MAX_PENDING_FOLLOW_UPS } from "./config"

const NOW = new Date("2026-07-02T12:00:00.000Z")
const SCHEDULED_FOR = new Date("2026-07-03T12:00:00.000Z")

function fakeFollowUp(overrides: Partial<AgentFollowUp> = {}): AgentFollowUp {
  return {
    id: "agfu_01",
    workspaceId: "ws_1",
    streamId: "stream_1",
    personaId: "persona_system_ariadne",
    sessionId: "session_1",
    sourceConversationId: null,
    note: "check back on the deploy",
    scheduledFor: SCHEDULED_FOR,
    status: FollowUpStatuses.PENDING,
    queueMessageId: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    statusChangedAt: NOW,
    ...overrides,
  }
}

function makeService() {
  return new AgentFollowUpService({ pool: {} as Pool })
}

const scheduleParams = {
  workspaceId: "ws_1",
  streamId: "stream_1",
  personaId: "persona_system_ariadne",
  sessionId: "session_1",
  sourceConversationId: null,
  note: "check back on the deploy",
  scheduledFor: SCHEDULED_FOR,
}

describe("AgentFollowUpService.schedule", () => {
  afterEach(() => mock.restore())

  it("inserts under the cap, enqueues a fire job, and reports the cap + count", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    spyOn(AgentFollowUpRepository, "acquireStreamCapLock").mockResolvedValue(undefined)
    spyOn(AgentFollowUpRepository, "insertIfUnderCap").mockResolvedValue(fakeFollowUp())
    spyOn(AgentFollowUpRepository, "setQueueMessageId").mockResolvedValue(undefined)
    spyOn(AgentFollowUpRepository, "countPending").mockResolvedValue(1)
    const queueInsert = spyOn(QueueRepository, "insert").mockResolvedValue({} as never)

    const result = await makeService().schedule(scheduleParams)

    expect(result).toEqual({
      ok: true,
      followUp: expect.objectContaining({ id: "agfu_01" }),
      pendingCount: 1,
      limit: DEFAULT_MAX_PENDING_FOLLOW_UPS,
    })
    const fireEnqueue = queueInsert.mock.calls.find(
      (call) => (call[1] as { queueName: string }).queueName === JobQueues.AGENT_FOLLOW_UP_FIRE
    )
    expect(fireEnqueue).toBeDefined()
  })

  it("returns cap_reached without enqueuing when the guarded insert writes nothing", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    spyOn(AgentFollowUpRepository, "acquireStreamCapLock").mockResolvedValue(undefined)
    spyOn(AgentFollowUpRepository, "insertIfUnderCap").mockResolvedValue(null)
    spyOn(AgentFollowUpRepository, "countPending").mockResolvedValue(DEFAULT_MAX_PENDING_FOLLOW_UPS)
    const queueInsert = spyOn(QueueRepository, "insert").mockResolvedValue({} as never)

    const result = await makeService().schedule(scheduleParams)

    expect(result).toEqual({
      ok: false,
      reason: "cap_reached",
      pendingCount: DEFAULT_MAX_PENDING_FOLLOW_UPS,
      limit: DEFAULT_MAX_PENDING_FOLLOW_UPS,
    })
    expect(queueInsert).not.toHaveBeenCalled()
  })
})

describe("AgentFollowUpService.cancel", () => {
  afterEach(() => mock.restore())

  it("cancels the fire queue row when the CAS wins", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    spyOn(AgentFollowUpRepository, "markCancelled").mockResolvedValue(
      fakeFollowUp({ status: FollowUpStatuses.CANCELLED, queueMessageId: "agfuq_1" })
    )
    const queueCancel = spyOn(QueueRepository, "cancelById").mockResolvedValue(true)

    const result = await makeService().cancel({ workspaceId: "ws_1", id: "agfu_01" })

    expect(result?.status).toBe(FollowUpStatuses.CANCELLED)
    expect(queueCancel).toHaveBeenCalledWith(expect.anything(), "agfuq_1")
  })

  it("returns null and cancels nothing when it loses the race to the fire worker", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    spyOn(AgentFollowUpRepository, "markCancelled").mockResolvedValue(null)
    const queueCancel = spyOn(QueueRepository, "cancelById").mockResolvedValue(true)

    const result = await makeService().cancel({ workspaceId: "ws_1", id: "agfu_01" })

    expect(result).toBeNull()
    expect(queueCancel).not.toHaveBeenCalled()
  })
})

describe("AgentFollowUpService.fire", () => {
  afterEach(() => mock.restore())

  it("CASes to fired and enqueues a PERSONA_AGENT job carrying followUpId", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    spyOn(AgentFollowUpRepository, "markFired").mockResolvedValue(fakeFollowUp({ status: FollowUpStatuses.FIRED }))
    const queueInsert = spyOn(QueueRepository, "insert").mockResolvedValue({} as never)

    const result = await makeService().fire({ workspaceId: "ws_1", followUpId: "agfu_01" })

    expect(result).toEqual({ fired: true })
    const personaEnqueue = queueInsert.mock.calls.find(
      (call) => (call[1] as { queueName: string }).queueName === JobQueues.PERSONA_AGENT
    )
    expect(personaEnqueue).toBeDefined()
    expect((personaEnqueue?.[1] as { payload: { followUpId?: string } }).payload.followUpId).toBe("agfu_01")
  })

  it("no-ops when the row is no longer pending (cancelled before firing)", async () => {
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    spyOn(AgentFollowUpRepository, "markFired").mockResolvedValue(null)
    const queueInsert = spyOn(QueueRepository, "insert").mockResolvedValue({} as never)

    const result = await makeService().fire({ workspaceId: "ws_1", followUpId: "agfu_01" })

    expect(result).toEqual({ fired: false })
    expect(queueInsert).not.toHaveBeenCalled()
  })
})

describe("AgentFollowUpService.getById", () => {
  afterEach(() => mock.restore())

  it("reads the row workspace-scoped via the pool (roadmap 1.2 context load)", async () => {
    const row = fakeFollowUp()
    const findById = spyOn(AgentFollowUpRepository, "findById").mockResolvedValue(row)

    const result = await makeService().getById({ workspaceId: "ws_1", followUpId: "agfu_01" })

    expect(result).toEqual(row)
    expect(findById.mock.calls[0]?.slice(1)).toEqual(["ws_1", "agfu_01"])
  })

  it("returns null when the row is gone", async () => {
    spyOn(AgentFollowUpRepository, "findById").mockResolvedValue(null)

    const result = await makeService().getById({ workspaceId: "ws_1", followUpId: "agfu_missing" })

    expect(result).toBeNull()
  })
})
