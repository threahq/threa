import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool } from "pg"
import type { Server } from "socket.io"
import * as db from "../../db"
import { AgentSessionRepository, SessionStatuses } from "./session-repository"
import { StreamRepository, StreamEventRepository } from "../streams"
import { OutboxRepository } from "../../lib/outbox"
import { failOrphanedSession } from "./orphan-session-cleanup"

const pool = {} as Pool

const ORPHAN = { id: "session_1", streamId: "stream_1", personaId: "persona_ariadne" }

afterEach(() => mock.restore())

function fakeIo() {
  const emit = mock((_event: string, _payload: unknown) => {})
  const io = { to: mock((_room: string) => ({ emit })) } as unknown as Server
  return { io, emit }
}

describe("failOrphanedSession", () => {
  it("marks FAILED only from RUNNING and emits the failed lifecycle (stream event + outbox + session room)", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue({ workspaceId: "ws_1" } as never)
    const tx = {} as never
    spyOn(db, "withTransaction").mockImplementation((async (_pool: unknown, fn: (client: never) => unknown) =>
      fn(tx)) as never)
    const update = spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue({ id: "session_1" } as never)
    spyOn(AgentSessionRepository, "findStepsBySession").mockResolvedValue([{}, {}] as never)
    const insertEvent = spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as never)
    const insertOutbox = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
    const { io, emit } = fakeIo()

    const won = await failOrphanedSession(pool, io, ORPHAN)

    expect(won).toBe(true)
    // Conditional transition: never clobbers a session that already left RUNNING.
    expect(update.mock.calls[0]![3]).toMatchObject({ onlyIfStatus: SessionStatuses.RUNNING })
    // The lifecycle event is what unblocks the inline indicator + keeps refresh consistent.
    expect(insertEvent.mock.calls[0]![1]).toMatchObject({
      streamId: "stream_1",
      eventType: "agent_session:failed",
      payload: { sessionId: "session_1", stepCount: 2 },
    })
    expect(insertOutbox.mock.calls[0]![1]).toBe("agent_session:failed")
    // And a live-open trace dialog (session room) is updated directly.
    expect(io.to).toHaveBeenCalledWith("ws:ws_1:agent_session:session_1")
    expect(emit.mock.calls.some((c) => c[0] === "agent_session:failed")).toBe(true)
  })

  it("does not emit when the session already left RUNNING (lost the race)", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue({ workspaceId: "ws_1" } as never)
    const tx = {} as never
    spyOn(db, "withTransaction").mockImplementation((async (_pool: unknown, fn: (client: never) => unknown) =>
      fn(tx)) as never)
    spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue(null) // transition not won
    const insertEvent = spyOn(StreamEventRepository, "insert")
    const insertOutbox = spyOn(OutboxRepository, "insert")
    const { io, emit } = fakeIo()

    const won = await failOrphanedSession(pool, io, ORPHAN)

    expect(won).toBe(false)
    expect(insertEvent).not.toHaveBeenCalled()
    expect(insertOutbox).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it("still marks FAILED durably when the stream is gone, without broadcasting", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue(null)
    const tx = {} as never
    spyOn(db, "withTransaction").mockImplementation((async (_pool: unknown, fn: (client: never) => unknown) =>
      fn(tx)) as never)
    const update = spyOn(AgentSessionRepository, "updateStatus").mockResolvedValue({ id: "session_1" } as never)
    const insertEvent = spyOn(StreamEventRepository, "insert")
    const { io, emit } = fakeIo()

    const won = await failOrphanedSession(pool, io, ORPHAN)

    expect(won).toBe(true)
    expect(update).toHaveBeenCalledTimes(1)
    expect(insertEvent).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })
})
