import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool } from "pg"
import type { Server } from "socket.io"
import { AgentStepTypes } from "@threa/types"
import * as db from "../../db"
import { AgentSessionRepository, type AgentSessionStep } from "../agents"
import { botInvocationStepEvents, createBotInvocationTraceProjector } from "./trace-steps"

afterEach(() => mock.restore())

describe("botInvocationStepEvents", () => {
  it("maps a thinking frame to the runtime's thinking event", () => {
    const events = botInvocationStepEvents({ stepType: AgentStepTypes.THINKING, content: "Pondering…" })

    expect(events).toEqual([{ type: "thinking", content: "Pondering…", durationMs: 0 }])
  })

  it("maps a tool_call frame to a back-to-back tool:start + tool:complete pair", () => {
    const events = botInvocationStepEvents({ stepType: AgentStepTypes.TOOL_CALL, content: '{"headline":"ran ls"}' })

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: "tool:start", stepType: AgentStepTypes.TOOL_CALL })
    expect(events[1]).toMatchObject({
      type: "tool:complete",
      trace: { stepType: AgentStepTypes.TOOL_CALL, content: '{"headline":"ran ls"}' },
    })
    // The pair correlates on one toolCallId so the projector finalizes the step it opened.
    const start = events[0] as { toolCallId: string }
    const complete = events[1] as { toolCallId: string }
    expect(complete.toolCallId).toBe(start.toolCallId)
  })

  it("keeps a tool_error frame's pre-rendered content verbatim (no tool:error re-wrapping)", () => {
    const content = '{"format":"pi-tool-trace.v1","headline":"boom","sections":[]}'
    const events = botInvocationStepEvents({ stepType: AgentStepTypes.TOOL_ERROR, content })

    expect(events[1]).toMatchObject({
      type: "tool:complete",
      trace: { stepType: AgentStepTypes.TOOL_ERROR, content },
    })
  })
})

function arrangeSink() {
  const emit = mock((_event: string, _payload: unknown) => {})
  const rooms: string[] = []
  const io = {
    to: (room: string) => {
      rooms.push(room)
      return { emit }
    },
  } as unknown as Server

  spyOn(db, "withTransaction").mockImplementation((async (_pool: unknown, fn: (client: never) => unknown) =>
    fn({} as never)) as never)

  const persisted: AgentSessionStep = {
    id: "step_persisted",
    sessionId: "binv_1",
    stepNumber: 3,
    stepType: AgentStepTypes.TOOL_CALL,
    content: '{"headline":"ran ls"}',
    sources: null,
    messageId: null,
    tokensUsed: null,
    startedAt: new Date("2026-06-11T09:00:00.000Z"),
    completedAt: new Date("2026-06-11T09:00:00.000Z"),
    contentCiphertext: null,
    contentEnvelope: null,
  } as unknown as AgentSessionStep
  const appendStep = spyOn(AgentSessionRepository, "appendStep").mockResolvedValue(persisted)
  const updateCurrentStepType = spyOn(AgentSessionRepository, "updateCurrentStepType").mockResolvedValue(
    undefined as never
  )

  const { projector, sink } = createBotInvocationTraceProjector({
    pool: {} as Pool,
    io,
    workspaceId: "ws_1",
    sessionId: "binv_1",
    streamId: "stream_1",
    triggerMessageId: "msg_trigger",
    personaName: "Pi",
  })

  return { projector, sink, emit, rooms, appendStep, updateCurrentStepType, persisted }
}

describe("BotInvocationTraceSink via the shared projector", () => {
  it("persists one completed row per frame and advances current_step_type in the same transaction", async () => {
    const { projector, sink, appendStep, updateCurrentStepType } = arrangeSink()

    for (const event of botInvocationStepEvents({
      stepType: AgentStepTypes.TOOL_CALL,
      content: '{"headline":"ran ls"}',
    })) {
      await projector.handle(event)
    }

    expect(appendStep).toHaveBeenCalledTimes(1)
    const params = appendStep.mock.calls[0]?.[1] as unknown as Record<string, unknown>
    expect(params).toMatchObject({
      sessionId: "binv_1",
      stepType: AgentStepTypes.TOOL_CALL,
      content: '{"headline":"ran ls"}',
    })
    // Post-hoc frame: the row lands already completed.
    expect(params.completedAt).toEqual(params.startedAt)
    expect(updateCurrentStepType).toHaveBeenCalledWith(expect.anything(), "binv_1", AgentStepTypes.TOOL_CALL)
    expect(sink.lastStep?.id).toBe("step_persisted")
  })

  it("emits step:completed to the session room and progress to the stream room", async () => {
    const { projector, emit, rooms } = arrangeSink()

    for (const event of botInvocationStepEvents({ stepType: AgentStepTypes.TOOL_CALL, content: '{"headline":"x"}' })) {
      await projector.handle(event)
    }

    expect(rooms).toEqual(["ws:ws_1:agent_session:binv_1", "ws:ws_1:stream:stream_1"])
    const [completedCall, progressCall] = emit.mock.calls
    expect(completedCall?.[0]).toBe("agent_session:step:completed")
    expect(completedCall?.[1]).toMatchObject({
      sessionId: "binv_1",
      step: { id: "step_persisted", stepNumber: 3, stepType: AgentStepTypes.TOOL_CALL },
    })
    expect(progressCall?.[0]).toBe("agent_session:progress")
    expect(progressCall?.[1]).toEqual({
      workspaceId: "ws_1",
      streamId: "stream_1",
      sessionId: "binv_1",
      triggerMessageId: "msg_trigger",
      personaName: "Pi",
      stepCount: 3,
      messageCount: 0,
      currentStepType: AgentStepTypes.TOOL_CALL,
    })
  })

  it("records a thinking frame as a single completed THINKING row", async () => {
    const { projector, appendStep } = arrangeSink()

    for (const event of botInvocationStepEvents({ stepType: AgentStepTypes.THINKING, content: "Pondering…" })) {
      await projector.handle(event)
    }

    expect(appendStep).toHaveBeenCalledTimes(1)
    expect(appendStep.mock.calls[0]?.[1]).toMatchObject({
      stepType: AgentStepTypes.THINKING,
      content: "Pondering…",
    })
  })
})
