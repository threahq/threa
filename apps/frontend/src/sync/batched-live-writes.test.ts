import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { renderHook, waitFor } from "@testing-library/react"
import type { StreamEvent } from "@threahq/types"
import { db, getActiveDb, type CachedEvent } from "@/db"
import { useStreamEvents } from "@/stores/stream-store"
import { MockSocket, asSocket, makeDeps } from "@/test/fixtures/sync-engine"
import { LIVE_WRITE_WINDOW_MS } from "./catch-up-batch"
import { computeTimelineHoles } from "./contiguity"
import { SocketEventGate } from "./socket-event-gate"
import { registerStreamSocketHandlers } from "./stream-sync"
import { LiveWritesContext } from "./live-writes-context"
import { SyncEngine } from "./sync-engine"

const WS = "ws_1"
const OPEN = "stream_open"
const BACKGROUND = "stream_background"

function wireEvent(id: string, streamId: string, sequence: number, eventType = "message_created"): StreamEvent {
  return {
    id,
    streamId,
    sequence: String(sequence),
    broadcastSequence: String(sequence),
    eventType,
    payload: { messageId: `msg_${id}`, contentMarkdown: `body ${id}` },
    actorId: "user_2",
    actorType: "user",
    createdAt: "2026-11-01T10:00:00.000Z",
  } as StreamEvent
}

async function seedTail(streamId: string, sequence: number): Promise<void> {
  const event = wireEvent(`evt_${streamId}_seed`, streamId, sequence)
  await db.events.put({ ...event, workspaceId: WS, _sequenceNum: sequence, _cachedAt: 1 })
}

async function streamRows(streamId: string): Promise<CachedEvent[]> {
  const rows = await db.events.filter((row) => row.workspaceId === WS && row.streamId === streamId).toArray()
  return rows.sort((a, b) => a._sequenceNum - b._sequenceNum)
}

async function rowIds(streamId: string): Promise<string[]> {
  return (await streamRows(streamId)).map((row) => row.id)
}

/** Counts readwrite IndexedDB transactions opened — a nested Dexie transaction reuses its parent's. */
function countReadwriteTransactions(): () => number {
  const spy = vi.spyOn(getActiveDb().core, "transaction")
  return () => spy.mock.calls.filter((call) => call[1] === "readwrite").length
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Mirrors the gate's live path: handlers run without the emitter awaiting them. */
function createSource() {
  const handlers = new Map<string, Set<(payload: unknown) => unknown>>()
  return {
    source: {
      on(event: string, handler: (payload: unknown) => unknown) {
        const set = handlers.get(event) ?? new Set()
        set.add(handler)
        handlers.set(event, set)
      },
      off(event: string, handler: (payload: unknown) => unknown) {
        handlers.get(event)?.delete(handler)
      },
    },
    emit(event: string, payload: unknown): Promise<unknown> {
      return Promise.all(Array.from(handlers.get(event) ?? []).map((handler) => handler(payload)))
    },
  }
}

let deps: ReturnType<typeof makeDeps>
let engine: SyncEngine
let cleanups: Array<() => void>

function wire(streamId: string, source = createSource(), onSequenceGap = vi.fn()) {
  cleanups.push(
    registerStreamSocketHandlers(source.source, WS, streamId, deps.queryClient, {
      liveWrites: engine.getLiveWrites(),
      onSequenceGap,
    })
  )
  return { ...source, onSequenceGap }
}

function created(streamId: string, sequence: number) {
  return { workspaceId: WS, streamId, event: wireEvent(`evt_${streamId}_${sequence}`, streamId, sequence) }
}

beforeEach(async () => {
  await Promise.all([db.events.clear(), db.pendingMessages.clear(), db.pendingOperations.clear(), db.slots.clear()])
  deps = makeDeps()
  engine = new SyncEngine(deps)
  engine.setCurrentStreamId(OPEN)
  cleanups = []
})

afterEach(() => {
  for (const cleanup of cleanups) cleanup()
  engine.destroy()
  vi.restoreAllMocks()
})

describe("batched live writes", () => {
  it("should commit a background stream's burst in one transaction when the window ends", async () => {
    await seedTail(BACKGROUND, 1)
    const { emit, onSequenceGap } = wire(BACKGROUND)
    const transactions = countReadwriteTransactions()

    const applied = [
      emit("message:created", created(BACKGROUND, 2)),
      emit("message:created", created(BACKGROUND, 3)),
      emit("stream:member_joined", {
        workspaceId: WS,
        streamId: BACKGROUND,
        event: wireEvent(`evt_${BACKGROUND}_4`, BACKGROUND, 4, "member_joined"),
      }),
      emit("message:created", created(BACKGROUND, 5)),
    ]

    await pause(LIVE_WRITE_WINDOW_MS / 4)
    expect({ rows: await rowIds(BACKGROUND), transactions: transactions() }).toEqual({
      rows: [`evt_${BACKGROUND}_seed`],
      transactions: 0,
    })

    await Promise.all(applied)
    const rows = await streamRows(BACKGROUND)
    expect({
      rows: rows.map((row) => row.id),
      transactions: transactions(),
      gaps: onSequenceGap.mock.calls,
      holes: computeTimelineHoles(rows),
    }).toEqual({
      rows: [
        `evt_${BACKGROUND}_seed`,
        `evt_${BACKGROUND}_2`,
        `evt_${BACKGROUND}_3`,
        `evt_${BACKGROUND}_4`,
        `evt_${BACKGROUND}_5`,
      ],
      transactions: 1,
      gaps: [],
      holes: [],
    })
  })

  it("should write the open stream's events as they arrive", async () => {
    const { emit } = wire(OPEN)
    const started = performance.now()

    await emit("message:created", created(OPEN, 1))

    expect(performance.now() - started).toBeLessThan(LIVE_WRITE_WINDOW_MS / 2)
    expect(await rowIds(OPEN)).toEqual([`evt_${OPEN}_1`])
  })

  it("should give a stream opened mid-window its waiting rows on the first read", async () => {
    await seedTail(BACKGROUND, 1)
    const { emit } = wire(BACKGROUND)
    void emit("message:created", created(BACKGROUND, 2))
    void emit("message:created", created(BACKGROUND, 3))
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(LiveWritesContext.Provider, { value: engine.getLiveWrites() }, children)

    const reads: Array<CachedEvent[] | undefined> = []
    const started = performance.now()
    const { result } = renderHook(
      () => {
        const events = useStreamEvents(WS, BACKGROUND)
        reads.push(events)
        return events
      },
      { wrapper }
    )

    await waitFor(() => expect(result.current).toBeDefined())
    expect(performance.now() - started).toBeLessThan(LIVE_WRITE_WINDOW_MS)
    expect(reads.find((events) => events !== undefined)?.map((event) => event.id)).toEqual([
      `evt_${BACKGROUND}_seed`,
      `evt_${BACKGROUND}_2`,
      `evt_${BACKGROUND}_3`,
    ])
  })

  it("should keep arrival order when a waiting stream comes on screen", async () => {
    await seedTail(BACKGROUND, 1)
    const { emit, onSequenceGap } = wire(BACKGROUND)
    const waiting = [emit("message:created", created(BACKGROUND, 2)), emit("message:created", created(BACKGROUND, 3))]

    engine.setCurrentStreamId(BACKGROUND)
    const onScreen = emit("message:created", created(BACKGROUND, 4))

    await Promise.all([...waiting, onScreen])
    expect({ rows: await rowIds(BACKGROUND), gaps: onSequenceGap.mock.calls }).toEqual({
      rows: [`evt_${BACKGROUND}_seed`, `evt_${BACKGROUND}_2`, `evt_${BACKGROUND}_3`, `evt_${BACKGROUND}_4`],
      gaps: [],
    })
  })

  it("should apply an edit after the create it targets that is still waiting", async () => {
    const { emit } = wire(BACKGROUND)
    void emit("message:created", created(BACKGROUND, 1))

    await emit("message:edited", {
      workspaceId: WS,
      streamId: BACKGROUND,
      event: {
        ...wireEvent("evt_edit", BACKGROUND, 2, "message_edited"),
        payload: { messageId: `msg_evt_${BACKGROUND}_1`, contentJson: null, contentMarkdown: "edited" },
      },
    })

    const row = await db.events.get([WS, `evt_${BACKGROUND}_1`])
    expect((row?.payload as { contentMarkdown?: string }).contentMarkdown).toBe("edited")
  })

  it("should write every event in its own transaction with the flag off, committing what was waiting", async () => {
    const { emit } = wire(BACKGROUND)
    const waiting = emit("message:created", created(BACKGROUND, 1))
    await pause(10)
    const started = performance.now()

    engine.setBatchedLiveWrites(false)
    await waiting
    expect(performance.now() - started).toBeLessThan(LIVE_WRITE_WINDOW_MS / 2)

    const transactions = countReadwriteTransactions()
    await emit("message:created", created(BACKGROUND, 2))
    await emit("message:created", created(BACKGROUND, 3))
    expect({ rows: await rowIds(BACKGROUND), transactions: transactions() }).toEqual({
      rows: [`evt_${BACKGROUND}_1`, `evt_${BACKGROUND}_2`, `evt_${BACKGROUND}_3`],
      transactions: 2,
    })
  })

  it.each([
    ["pagehide", () => window.dispatchEvent(new Event("pagehide"))],
    [
      "visibilitychange to hidden",
      () => {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
        document.dispatchEvent(new Event("visibilitychange"))
      },
    ],
  ])("should commit waiting writes on %s", async (_trigger, hide) => {
    const { emit } = wire(BACKGROUND)
    const waiting = emit("message:created", created(BACKGROUND, 1))
    await pause(10)
    const started = performance.now()

    hide()
    await waiting

    expect(performance.now() - started).toBeLessThan(LIVE_WRITE_WINDOW_MS / 2)
    expect(await rowIds(BACKGROUND)).toEqual([`evt_${BACKGROUND}_1`])
  })

  it("should advance the sync cursor only once the waiting write commits", async () => {
    const socket = new MockSocket()
    const applied: string[] = []
    const gate = new SocketEventGate(WS, { onApplied: (syncId) => applied.push(syncId) })
    gate.attach(asSocket(socket))
    cleanups.push(
      registerStreamSocketHandlers(gate, WS, BACKGROUND, deps.queryClient, { liveWrites: engine.getLiveWrites() })
    )

    socket.trigger("message:created", { ...created(BACKGROUND, 1), syncId: "7" })
    await pause(LIVE_WRITE_WINDOW_MS / 4)
    expect({ applied: [...applied], rows: await rowIds(BACKGROUND) }).toEqual({ applied: [], rows: [] })

    await waitFor(() => expect(applied).toEqual(["7"]))
    expect(await rowIds(BACKGROUND)).toEqual([`evt_${BACKGROUND}_1`])
    gate.dispose()
  })
})
