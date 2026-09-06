import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool } from "pg"
import type { Namespace, Server } from "socket.io"
import { CursorLock } from "@threahq/backend-common"
import { BroadcastHandler } from "./broadcast-handler"
import { OutboxRepository, type OutboxEvent } from "./repository"
import {
  outboxBatchSize,
  outboxDispatchLagSeconds,
  outboxEventsEmitted,
  outboxBatchProcessSeconds,
} from "../observability"

const pool = {} as Pool

function fakeIo() {
  const emit = mock(() => true)
  const to = mock(() => ({ emit, to: () => ({ emit }) }))
  return { io: { to } as unknown as Server, botNs: { to } as unknown as Namespace, emit }
}

/** prom-client histograms expose `<name>_sum` / `<name>_count` samples. */
async function histogram(metric: typeof outboxBatchSize, suffix: "sum" | "count"): Promise<number> {
  const collected = await metric.get()
  const sample = collected.values.find((v) => v.metricName?.endsWith(`_${suffix}`))
  return sample ? sample.value : 0
}

async function counterFor(eventType: string): Promise<number> {
  const collected = await outboxEventsEmitted.get()
  return collected.values.find((v) => v.labels.event_type === eventType)?.value ?? 0
}

function event(id: bigint, createdAt: Date): OutboxEvent {
  return {
    id,
    // Bot-scoped: routed to the /bot namespace and deliberately kept off the
    // sync log, so this exercises the emit path without a database.
    eventType: "bot_invocation:claimed",
    payload: { workspaceId: "ws_1", botId: "bot_1" },
    createdAt,
  } as unknown as OutboxEvent
}

/** Drives one batch through the real handler without a database cursor. */
function runOneBatch(handler: BroadcastHandler): Promise<void> {
  return (handler as unknown as { processEvents(): Promise<void> }).processEvents()
}

describe("BroadcastHandler outbox metrics", () => {
  beforeEach(() => {
    outboxBatchSize.reset()
    outboxDispatchLagSeconds.reset()
    outboxBatchProcessSeconds.reset()
    outboxEventsEmitted.reset()

    spyOn(CursorLock.prototype, "run").mockImplementation(async function (
      this: CursorLock,
      fn: (cursor: bigint, processedIds: bigint[]) => Promise<unknown>
    ) {
      await fn(0n, [])
    } as never)
  })

  afterEach(() => {
    mock.restore()
  })

  it("observes batch size once and lag per event", async () => {
    const now = Date.now()
    const events = [event(1n, new Date(now - 2000)), event(2n, new Date(now - 4000))]
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue(events)
    const { io, botNs } = fakeIo()
    await runOneBatch(new BroadcastHandler(pool, io, botNs))

    expect(await histogram(outboxBatchSize, "count")).toBe(1)
    expect(await histogram(outboxBatchSize, "sum")).toBe(2)
    expect(await histogram(outboxDispatchLagSeconds, "count")).toBe(2)
    // 2s + 4s of lag, plus whatever the batch itself took.
    expect(await histogram(outboxDispatchLagSeconds, "sum")).toBeGreaterThanOrEqual(6)
    expect(await histogram(outboxDispatchLagSeconds, "sum")).toBeLessThan(8)
    expect(await counterFor("bot_invocation:claimed")).toBe(2)
    expect(await histogram(outboxBatchProcessSeconds, "count")).toBe(1)
  })

  it("observes nothing on an empty batch", async () => {
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([])
    const { io, botNs } = fakeIo()
    await runOneBatch(new BroadcastHandler(pool, io, botNs))

    expect(await histogram(outboxBatchSize, "count")).toBe(0)
    expect(await histogram(outboxDispatchLagSeconds, "count")).toBe(0)
    expect(await histogram(outboxBatchProcessSeconds, "count")).toBe(0)
    expect((await outboxEventsEmitted.get()).values).toEqual([])
  })
})
