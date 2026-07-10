import { describe, test, expect, afterEach, spyOn, mock } from "bun:test"
import type { Server } from "socket.io"
import type { Pool } from "pg"
import { TraceEmitter } from "./trace-emitter"
import { AgentSessionRepository } from "./session-repository"

interface CapturedEmit {
  rooms: string[]
  event: string
  payload: Record<string, unknown>
}

function fakeIo() {
  const emits: CapturedEmit[] = []
  function operator(rooms: string[]) {
    return {
      to: (room: string) => operator([...rooms, room]),
      emit: (event: string, payload: Record<string, unknown>) => {
        emits.push({ rooms, event, payload })
      },
    }
  }
  const io = { to: (room: string) => operator([room]) } as unknown as Server
  return { io, emits }
}

function sessionTrace(io: Server, overrides?: Partial<{ parentStreamId: string; parentMessageId: string }>) {
  return new TraceEmitter({ io, pool: {} as Pool }).forSession({
    sessionId: "session_1",
    workspaceId: "ws_1",
    streamId: "thread_1",
    triggerMessageId: "msg_trigger",
    personaName: "Ariadne",
    ...overrides,
  })
}

afterEach(() => {
  mock.restore()
})

describe("SessionTrace parent-stream routing", () => {
  test("startStep emits progress to the thread room AND the parent room with parentMessageId", async () => {
    spyOn(AgentSessionRepository, "upsertStep").mockResolvedValue({
      id: "step_1",
      sessionId: "session_1",
      stepNumber: 1,
      stepType: "thinking",
      content: undefined,
      startedAt: new Date("2026-07-09T10:00:00.000Z"),
    } as never)
    spyOn(AgentSessionRepository, "updateCurrentStepType").mockResolvedValue(undefined as never)

    const { io, emits } = fakeIo()
    const trace = sessionTrace(io, { parentStreamId: "stream_dm_1", parentMessageId: "msg_parent" })
    await trace.startStep({ stepType: "thinking" })

    const progress = emits.find((e) => e.event === "agent_session:progress")
    expect(progress).toMatchObject({
      rooms: ["ws:ws_1:stream:thread_1", "ws:ws_1:stream:stream_dm_1"],
      payload: {
        sessionId: "session_1",
        triggerMessageId: "msg_trigger",
        parentMessageId: "msg_parent",
        threadStreamId: "thread_1",
        stepCount: 1,
      },
    })
  })

  test("activity_started reaches the parent room with parentMessageId; no parent → no emit", () => {
    const { io, emits } = fakeIo()
    sessionTrace(io, { parentStreamId: "stream_dm_1", parentMessageId: "msg_parent" }).notifyActivityStarted()
    expect(emits).toEqual([
      {
        rooms: ["ws:ws_1:stream:stream_dm_1"],
        event: "agent_session:activity_started",
        payload: {
          sessionId: "session_1",
          triggerMessageId: "msg_trigger",
          personaName: "Ariadne",
          threadStreamId: "thread_1",
          parentMessageId: "msg_parent",
        },
      },
    ])

    const bare = fakeIo()
    sessionTrace(bare.io).notifyActivityStarted()
    expect(bare.emits).toEqual([])
  })

  test("substeps fan out to the parent room for in-thread sessions", () => {
    const { io, emits } = fakeIo()
    sessionTrace(io, { parentStreamId: "stream_dm_1", parentMessageId: "msg_parent" }).emitSubstep({
      stepType: "workspace_search",
      substep: "Planning queries",
    })

    const roomsHit = emits.filter((e) => e.event === "agent_session:substep").flatMap((e) => e.rooms)
    expect(roomsHit).toContain("ws:ws_1:stream:stream_dm_1")
    expect(roomsHit).toContain("ws:ws_1:stream:thread_1")
    expect(roomsHit).toContain("ws:ws_1:agent_session:session_1")
  })
})
