import { describe, expect, it } from "bun:test"
import { AgentStepTypes, type TraceSource } from "@threa/types"
import type { NewMessageInfo } from "./agent-events"
import {
  TraceProjector,
  type TraceStepFinalize,
  type TraceStepRecord,
  type TraceStepSink,
  type TraceSubstepEntry,
} from "./trace-projector"

/**
 * Records every sink call so tests assert on the projected step lifecycle —
 * the single state machine all three surfaces (companion, enclave, bot
 * invocations) share.
 */
function createSinkStub() {
  let nextId = 0
  const records: TraceStepRecord[] = []
  const opened: Array<{ id: number; stepType: string }> = []
  const completed: Array<{ id: number; final: TraceStepFinalize }> = []
  const substeps: Array<{
    id: number
    stepType: string
    text: string
    snapshot: TraceSubstepEntry[]
    toolCallId: string
    toolName: string
  }> = []

  const sink: TraceStepSink<{ id: number }> = {
    async record(step) {
      records.push(step)
    },
    async open(params) {
      const handle = { id: ++nextId }
      opened.push({ id: handle.id, stepType: params.stepType })
      return handle
    },
    async complete(step, final) {
      completed.push({ id: step.id, final })
    },
    async substep(params) {
      substeps.push({
        id: params.step.id,
        stepType: params.stepType,
        text: params.text,
        snapshot: params.snapshot,
        toolCallId: params.toolCallId,
        toolName: params.toolName,
      })
    },
  }

  return { sink, records, opened, completed, substeps }
}

const toolStart = (toolCallId: string, hidden?: boolean) =>
  ({
    type: "tool:start",
    toolCallId,
    toolName: "workspace_research",
    stepType: AgentStepTypes.WORKSPACE_SEARCH,
    input: {},
    ...(hidden !== undefined ? { hidden } : {}),
  }) as const

const newMessage = (overrides?: Partial<NewMessageInfo>): NewMessageInfo => ({
  sequence: 1n,
  messageId: "msg_1",
  changeType: "message_created",
  content: "hello",
  authorId: "user_1",
  authorName: "Kris",
  authorType: "user",
  createdAt: "2026-06-11T09:00:00.000Z",
  ...overrides,
})

describe("TraceProjector atomic steps", () => {
  it("records thinking with its duration", async () => {
    const { sink, records } = createSinkStub()
    const projector = new TraceProjector(sink)

    await projector.handle({ type: "thinking", content: "Let me reason.", durationMs: 42 })

    expect(records).toEqual([{ stepType: AgentStepTypes.THINKING, content: "Let me reason.", durationMs: 42 }])
  })

  it("records message:sent with messageId and sources", async () => {
    const { sink, records } = createSinkStub()
    const projector = new TraceProjector(sink)

    const sources: TraceSource[] = [{ type: "web", title: "Tide Atlas", url: "https://tides.example/atlas" }]
    await projector.handle({ type: "message:sent", messageId: "msg_reply", content: "Paris.", sources })

    expect(records).toEqual([
      { stepType: AgentStepTypes.MESSAGE_SENT, content: "Paris.", messageId: "msg_reply", sources },
    ])
  })

  it("records message:edited with messageId and sources", async () => {
    const { sink, records } = createSinkStub()
    const projector = new TraceProjector(sink)

    await projector.handle({ type: "message:edited", messageId: "msg_reply", content: "Paris, France." })

    expect(records).toEqual([
      {
        stepType: AgentStepTypes.MESSAGE_EDITED,
        content: "Paris, France.",
        messageId: "msg_reply",
        sources: undefined,
      },
    ])
  })

  it("records response:kept as a RECONSIDERING step with the kept decision", async () => {
    const { sink, records } = createSinkStub()
    const projector = new TraceProjector(sink)

    await projector.handle({ type: "response:kept", reason: "new message did not change the answer" })

    expect(records).toHaveLength(1)
    expect(records[0]!.stepType).toBe(AgentStepTypes.RECONSIDERING)
    expect(JSON.parse(records[0]!.content)).toEqual({
      decision: "kept_previous_response",
      reason: "new message did not change the answer",
    })
  })

  it("records context:received with messages truncated to 300 chars", async () => {
    const { sink, records } = createSinkStub()
    const projector = new TraceProjector(sink)

    await projector.handle({
      type: "context:received",
      messages: [newMessage({ content: "x".repeat(500) })],
    })

    const parsed = JSON.parse(records[0]!.content) as { messages: Array<Record<string, unknown>> }
    expect(records[0]!.stepType).toBe(AgentStepTypes.CONTEXT_RECEIVED)
    expect(parsed.messages).toEqual([
      {
        messageId: "msg_1",
        changeType: "message_created",
        authorName: "Kris",
        authorType: "user",
        createdAt: "2026-06-11T09:00:00.000Z",
        content: "x".repeat(300),
      },
    ])
  })

  it("serializes turn-start context:received with isTrigger and extras, byte-compatible with the companion's step", async () => {
    const { sink, records } = createSinkStub()
    const projector = new TraceProjector(sink)

    const rerunContext = { cause: "invoking_message_edited", editedMessageId: "msg_1" }
    const attachedContext = { refs: [{ streamId: "stream_ctx", messages: [] }] }
    await projector.handle({
      type: "context:received",
      messages: [
        {
          messageId: "msg_0",
          authorName: "Kris",
          authorType: "user",
          createdAt: "2026-06-11T08:59:00.000Z",
          content: "earlier",
          isTrigger: false,
        },
        {
          messageId: "msg_1",
          authorName: "Kris",
          authorType: "user",
          createdAt: "2026-06-11T09:00:00.000Z",
          content: "trigger",
          isTrigger: true,
        },
      ],
      extras: { rerunContext, attachedContext },
    })

    // Exact string: turn-start messages must serialize without a changeType key
    // (it would render a change label) and with extras after `messages`, exactly
    // as the companion's hand-built step did before the runtime emitted this.
    expect(records[0]!.content).toBe(
      JSON.stringify({
        messages: [
          {
            messageId: "msg_0",
            authorName: "Kris",
            authorType: "user",
            createdAt: "2026-06-11T08:59:00.000Z",
            content: "earlier",
            isTrigger: false,
          },
          {
            messageId: "msg_1",
            authorName: "Kris",
            authorType: "user",
            createdAt: "2026-06-11T09:00:00.000Z",
            content: "trigger",
            isTrigger: true,
          },
        ],
        rerunContext,
        attachedContext,
      })
    )
  })

  it("records reconsidering with the draft and truncated new messages", async () => {
    const { sink, records } = createSinkStub()
    const projector = new TraceProjector(sink)

    await projector.handle({
      type: "reconsidering",
      draft: "draft answer",
      newMessages: [newMessage({ content: "y".repeat(500) })],
    })

    const parsed = JSON.parse(records[0]!.content) as { draftResponse: string; newMessages: Array<{ content: string }> }
    expect(records[0]!.stepType).toBe(AgentStepTypes.RECONSIDERING)
    expect(parsed.draftResponse).toBe("draft answer")
    expect(parsed.newMessages[0]!.content).toBe("y".repeat(300))
  })

  it("passes orchestration-driven steps through record()", async () => {
    const { sink, records } = createSinkStub()
    const projector = new TraceProjector(sink)

    await projector.record({ stepType: AgentStepTypes.TURN_DIGEST, content: '{"findings":"…"}' })

    expect(records).toEqual([{ stepType: AgentStepTypes.TURN_DIGEST, content: '{"findings":"…"}' }])
  })

  it("ignores non-step lifecycle events", async () => {
    const { sink, records, opened, completed } = createSinkStub()
    const projector = new TraceProjector(sink)

    await projector.handle({ type: "session:start", sessionId: "session_1" })
    await projector.handle({ type: "session:end", messagesSent: 1, sourceCount: 0 })
    await projector.handle({ type: "session:error", error: "boom" })

    expect(records).toHaveLength(0)
    expect(opened).toHaveLength(0)
    expect(completed).toHaveLength(0)
  })
})

describe("TraceProjector tool lifecycle", () => {
  it("opens at tool:start and finalizes the same step at tool:complete", async () => {
    const { sink, opened, completed } = createSinkStub()
    const projector = new TraceProjector(sink)

    await projector.handle(toolStart("tc_1"))
    expect(opened).toEqual([{ id: 1, stepType: AgentStepTypes.WORKSPACE_SEARCH }])

    const sources: TraceSource[] = [{ type: "web", title: "Atlas", url: "https://tides.example" }]
    await projector.handle({
      type: "tool:complete",
      toolCallId: "tc_1",
      toolName: "workspace_research",
      input: {},
      output: "{}",
      durationMs: 1500,
      trace: { stepType: AgentStepTypes.WORKSPACE_SEARCH, content: '{"memoCount":2}', sources },
    })

    expect(opened).toHaveLength(1) // no second open — the cached step was finalized
    expect(completed).toEqual([
      {
        id: 1,
        final: {
          stepType: AgentStepTypes.WORKSPACE_SEARCH,
          content: '{"memoCount":2}',
          sources,
          durationMs: 1500,
        },
      },
    ])
  })

  it("delivers substeps with an accumulating snapshot, in order", async () => {
    const { sink, substeps } = createSinkStub()
    const projector = new TraceProjector(sink)

    await projector.handle(toolStart("tc_1"))
    for (const text of ["Planning queries…", "Searching memos…"]) {
      await projector.handle({
        type: "tool:progress",
        toolCallId: "tc_1",
        toolName: "workspace_research",
        stepType: AgentStepTypes.WORKSPACE_SEARCH,
        substep: text,
      })
    }

    expect(substeps).toHaveLength(2)
    expect(substeps[0]!).toMatchObject({ id: 1, text: "Planning queries…", toolCallId: "tc_1" })
    expect(substeps[0]!.snapshot.map((s) => s.text)).toEqual(["Planning queries…"])
    expect(substeps[1]!.snapshot.map((s) => s.text)).toEqual(["Planning queries…", "Searching memos…"])
    expect(substeps[1]!.snapshot.every((s) => typeof s.at === "string")).toBe(true)
  })

  it("skips empty or whitespace-only substep text", async () => {
    const { sink, substeps } = createSinkStub()
    const projector = new TraceProjector(sink)

    await projector.handle(toolStart("tc_1"))
    await projector.handle({
      type: "tool:progress",
      toolCallId: "tc_1",
      toolName: "workspace_research",
      stepType: AgentStepTypes.WORKSPACE_SEARCH,
      substep: "   ",
    })

    expect(substeps).toHaveLength(0)
  })

  it("skips substeps with no open step (hidden tool)", async () => {
    const { sink, substeps } = createSinkStub()
    const projector = new TraceProjector(sink)

    await projector.handle({
      type: "tool:progress",
      toolCallId: "tc_hidden",
      toolName: "search_messages",
      stepType: AgentStepTypes.WORKSPACE_SEARCH,
      substep: "Searching…",
    })

    expect(substeps).toHaveLength(0)
  })

  it("finalizes the open step with the error on tool:error, framed as TOOL_ERROR", async () => {
    const { sink, completed, records } = createSinkStub()
    const projector = new TraceProjector(sink)

    await projector.handle(toolStart("tc_1"))
    await projector.handle({
      type: "tool:error",
      toolCallId: "tc_1",
      toolName: "workspace_research",
      error: "boom",
      durationMs: 50,
    })

    expect(records).toHaveLength(0)
    expect(completed).toEqual([
      {
        id: 1,
        final: { stepType: AgentStepTypes.TOOL_ERROR, content: "workspace_research failed: boom", durationMs: 50 },
      },
    ])
  })

  it("records a synthetic TOOL_ERROR step for unknown-tool errors (no preceding tool:start)", async () => {
    const { sink, records, completed } = createSinkStub()
    const projector = new TraceProjector(sink)

    await projector.handle({
      type: "tool:error",
      toolCallId: "tc_unknown",
      toolName: "nonexistent_tool",
      error: "Unknown tool: nonexistent_tool",
      durationMs: 0,
    })

    expect(completed).toHaveLength(0)
    expect(records).toEqual([
      {
        stepType: AgentStepTypes.TOOL_ERROR,
        content: "nonexistent_tool failed: Unknown tool: nonexistent_tool",
        durationMs: 0,
      },
    ])
  })
})

describe("TraceProjector hidden tools", () => {
  it("a hidden tool's full lifecycle projects no user-facing steps", async () => {
    const { sink, records, opened, completed, substeps } = createSinkStub()
    const projector = new TraceProjector(sink)

    await projector.handle(toolStart("tc_1", true))
    await projector.handle({
      type: "tool:progress",
      toolCallId: "tc_1",
      toolName: "workspace_research",
      stepType: AgentStepTypes.WORKSPACE_SEARCH,
      substep: "Searching…",
    })
    await projector.handle({
      type: "tool:complete",
      toolCallId: "tc_1",
      toolName: "workspace_research",
      input: {},
      output: "{}",
      durationMs: 200,
      trace: { stepType: AgentStepTypes.WORKSPACE_SEARCH, content: "{}" },
    })

    expect(records).toHaveLength(0)
    expect(opened).toHaveLength(0)
    expect(completed).toHaveLength(0)
    expect(substeps).toHaveLength(0)
  })

  it("skips tool:error for a hidden tool (no synthetic error step)", async () => {
    const { sink, records, completed } = createSinkStub()
    const projector = new TraceProjector(sink)

    await projector.handle(toolStart("tc_1", true))
    await projector.handle({
      type: "tool:error",
      toolCallId: "tc_1",
      toolName: "workspace_research",
      error: "boom",
      durationMs: 50,
    })

    expect(records).toHaveLength(0)
    expect(completed).toHaveLength(0)
  })

  it("drops a tool:complete with no matching tool:start", async () => {
    const { sink, records, completed } = createSinkStub()
    const projector = new TraceProjector(sink)

    await projector.handle({
      type: "tool:complete",
      toolCallId: "tc_hidden",
      toolName: "search_messages",
      input: {},
      output: "{}",
      durationMs: 100,
      trace: { stepType: AgentStepTypes.WORKSPACE_SEARCH, content: "{}" },
    })

    expect(records).toHaveLength(0)
    expect(completed).toHaveLength(0)
  })

  it("clears the hidden marker on tool:complete so a later same-id error is not swallowed forever", async () => {
    const { sink, records } = createSinkStub()
    const projector = new TraceProjector(sink)

    await projector.handle(toolStart("tc_1", true))
    await projector.handle({
      type: "tool:complete",
      toolCallId: "tc_1",
      toolName: "workspace_research",
      input: {},
      output: "{}",
      durationMs: 10,
      trace: { stepType: AgentStepTypes.WORKSPACE_SEARCH, content: "{}" },
    })
    // A fresh tool:error with the same id now records (the marker was cleared).
    await projector.handle({
      type: "tool:error",
      toolCallId: "tc_1",
      toolName: "workspace_research",
      error: "boom",
      durationMs: 5,
    })

    expect(records).toHaveLength(1)
    expect(records[0]!.stepType).toBe(AgentStepTypes.TOOL_ERROR)
  })
})
