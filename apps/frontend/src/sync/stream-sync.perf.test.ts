import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Socket } from "socket.io-client"
import type { PerformanceSample, StreamEvent } from "@threa/types"
import { db } from "@/db"
import { NO_CAPTURE, PerfCapture, armPerfCapture, getPerfCapture } from "@/lib/perf/capture"
import { registerStreamSocketHandlers } from "./stream-sync"
import { primeEventWriteFlags, resetEventWriteFlags } from "@/db/event-writes"

function createTestSocket() {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const socket = {
    on(event: string, handler: (payload: unknown) => void) {
      const set = handlers.get(event) ?? new Set()
      set.add(handler)
      handlers.set(event, set)
      return this
    },
    off(event: string, handler: (payload: unknown) => void) {
      handlers.get(event)?.delete(handler)
      return this
    },
  } as unknown as Socket
  return {
    socket,
    async emit(event: string, payload: unknown) {
      await Promise.all(Array.from(handlers.get(event) ?? []).map((handler) => handler(payload)))
    },
  }
}

function makeWireEvent(id: string, streamId: string, sequence: string): StreamEvent {
  return {
    id,
    streamId,
    sequence,
    eventType: "message_created",
    payload: { messageId: id, contentMarkdown: "hi", contentJson: { type: "doc", content: [] } },
    actorId: "user_2",
    actorType: "user",
    createdAt: "2026-08-04T10:00:00.000Z",
  }
}

async function deliver(streamId: string, ids: string[]): Promise<void> {
  const { socket, emit } = createTestSocket()
  const queryClient = new QueryClient()
  const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)
  for (const [index, id] of ids.entries()) {
    await emit("message:created", {
      workspaceId: "ws_1",
      streamId,
      event: makeWireEvent(id, streamId, String(100 + index)),
    })
  }
  cleanup()
}

function samplesNamed(capture: PerfCapture, name: string): PerformanceSample[] {
  return capture.snapshot().filter((sample) => sample.name === name)
}

async function resetTables(): Promise<void> {
  await Promise.all([db.events.clear(), db.streams.clear(), db.pendingMessages.clear(), db.slots.clear()])
  await db.streams.put({
    id: "stream_perf",
    workspaceId: "ws_1",
    type: "channel",
    displayName: "perf",
    slug: "perf",
    description: null,
    visibility: "public",
    parentStreamId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "user_1",
    createdAt: "2026-08-04T09:00:00.000Z",
    updatedAt: "2026-08-04T09:00:00.000Z",
    archivedAt: null,
    _cachedAt: 1,
  })
}

beforeEach(async () => {
  await resetTables()
  primeEventWriteFlags("ws_1", { workspace: { singlePreviewWriter: "off" }, user: {} })
})

afterEach(() => {
  armPerfCapture(NO_CAPTURE)
  resetEventWriteFlags()
})

describe("message:created sub-marks", () => {
  it("an applied message records one eventTx and one previewWrite sample", async () => {
    const capture = new PerfCapture()
    armPerfCapture(capture)

    await deliver("stream_perf", ["evt_1"])

    expect(samplesNamed(capture, "stream.eventTx")).toHaveLength(1)
    expect(samplesNamed(capture, "stream.previewWrite")).toHaveLength(1)
    expect(samplesNamed(capture, "stream.contextRows")).toHaveLength(1)
    for (const name of ["stream.eventTx", "stream.previewWrite", "stream.contextRows"] as const) {
      expect(samplesNamed(capture, name)[0].value).toBeTypeOf("number")
    }
    expect(samplesNamed(capture, "stream.eventDuplicate")).toEqual([])
  })

  it("a re-delivered message records eventDuplicate", async () => {
    const capture = new PerfCapture()
    armPerfCapture(capture)

    const { socket, emit } = createTestSocket()
    const queryClient = new QueryClient()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", "stream_perf", queryClient)
    const event = makeWireEvent("evt_dup", "stream_perf", "100")
    await emit("message:created", { workspaceId: "ws_1", streamId: "stream_perf", event })
    const afterFirst = samplesNamed(capture, "stream.eventDuplicate")
    await emit("message:created", { workspaceId: "ws_1", streamId: "stream_perf", event })
    cleanup()

    expect(afterFirst).toEqual([])
    expect(samplesNamed(capture, "stream.eventDuplicate").map((sample) => sample.count)).toEqual([1])
    expect(samplesNamed(capture, "stream.eventApply")).toHaveLength(2)
  })

  it("an unarmed capture records nothing and applies the message identically", async () => {
    const capture = new PerfCapture()
    armPerfCapture(capture)
    await deliver("stream_perf", ["evt_same"])
    const armedEvents = await db.events.where("streamId").equals("stream_perf").toArray()
    const armedStream = await db.streams.get("stream_perf")

    const armedCount = capture.snapshot().length

    armPerfCapture(NO_CAPTURE)
    await resetTables()
    await deliver("stream_perf", ["evt_same"])
    const unarmedEvents = await db.events.where("streamId").equals("stream_perf").toArray()
    const unarmedStream = await db.streams.get("stream_perf")

    // Asserted against the previously-armed capture, not against the disarmed
    // one: `NO_CAPTURE.snapshot()` is a literal `[]`, so asking it can never go
    // red — a handler that kept writing into a stale capture would pass.
    expect(getPerfCapture()).toBe(NO_CAPTURE)
    expect(capture.snapshot()).toHaveLength(armedCount)
    expect(stripCachedAt(unarmedEvents)).toEqual(stripCachedAt(armedEvents))
    expect({ ...unarmedStream, _cachedAt: 0 }).toEqual({ ...armedStream, _cachedAt: 0 })
  })
})

function stripCachedAt<T extends { _cachedAt?: number }>(rows: T[]): T[] {
  return rows.map((row) => ({ ...row, _cachedAt: 0 }))
}
