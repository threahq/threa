import { describe, expect, it } from "vitest"
import { AgentStepTypes } from "@threa/types"
import { TraceMapper, type TraceStepFinalize, type TraceStepSink, type TraceSubstepUpdate } from "./trace-mapper"

/**
 * Records every sink op in order so tests can assert the full step lifecycle
 * the mapper drives, host-agnostically.
 */
function createSinkStub() {
  const ops: Array<
    | { op: "open"; stepIndex: number; stepType: string; content?: string }
    | { op: "substep"; stepIndex: number; update: TraceSubstepUpdate }
    | { op: "finalize"; stepIndex: number; fin: TraceStepFinalize }
    | { op: "detached"; stepType: string; text: string }
  > = []
  let nextStepIndex = 0

  const sink: TraceStepSink = {
    async openStep(op) {
      const stepIndex = nextStepIndex++
      ops.push({
        op: "open",
        stepIndex,
        stepType: op.stepType,
        ...(op.content !== undefined ? { content: op.content } : {}),
      })
      return {
        substep: (update) => {
          ops.push({ op: "substep", stepIndex, update })
        },
        finalize: async (fin) => {
          ops.push({ op: "finalize", stepIndex, fin })
        },
      }
    },
    emitDetachedSubstep(sub) {
      ops.push({ op: "detached", stepType: sub.stepType, text: sub.text })
    },
  }

  return { sink, ops }
}

describe("TraceMapper", () => {
  it("opens a thinking step with content and finalizes contentless with the duration", async () => {
    const { sink, ops } = createSinkStub()
    const mapper = new TraceMapper(sink)

    await mapper.handle({ type: "thinking", content: "Let me reason.", durationMs: 42 })

    expect(ops).toEqual([
      { op: "open", stepIndex: 0, stepType: AgentStepTypes.THINKING, content: "Let me reason." },
      { op: "finalize", stepIndex: 0, fin: { stepType: AgentStepTypes.THINKING, durationMs: 42 } },
    ])
  })

  it("runs the tool lifecycle: contentless open, accumulating substeps, finalize with the result", async () => {
    const { sink, ops } = createSinkStub()
    const mapper = new TraceMapper(sink)

    await mapper.handle({
      type: "tool:start",
      toolCallId: "tc_1",
      toolName: "general_research",
      stepType: AgentStepTypes.RESEARCH,
      input: {},
    })
    await mapper.handle({
      type: "tool:progress",
      toolCallId: "tc_1",
      toolName: "general_research",
      stepType: AgentStepTypes.RESEARCH,
      substep: "Searching…",
    })
    await mapper.handle({
      type: "tool:progress",
      toolCallId: "tc_1",
      toolName: "general_research",
      stepType: AgentStepTypes.RESEARCH,
      substep: "Reading…",
    })
    await mapper.handle({
      type: "tool:complete",
      toolCallId: "tc_1",
      toolName: "general_research",
      input: {},
      output: "{}",
      durationMs: 900,
      trace: { stepType: AgentStepTypes.RESEARCH, content: "found it", sources: [] },
    })

    expect(ops[0]).toEqual({ op: "open", stepIndex: 0, stepType: AgentStepTypes.RESEARCH })

    // Substeps anchor to the opened step and each carries the running snapshot.
    const substeps = ops.filter((o) => o.op === "substep")
    expect(substeps).toHaveLength(2)
    expect(substeps[0]).toMatchObject({ stepIndex: 0, update: { text: "Searching…", toolCallId: "tc_1" } })
    expect(substeps[0]!.op === "substep" && substeps[0]!.update.snapshot.map((s) => s.text)).toEqual(["Searching…"])
    expect(substeps[1]!.op === "substep" && substeps[1]!.update.snapshot.map((s) => s.text)).toEqual([
      "Searching…",
      "Reading…",
    ])

    expect(ops.at(-1)).toEqual({
      op: "finalize",
      stepIndex: 0,
      fin: { stepType: AgentStepTypes.RESEARCH, content: "found it", sources: [], durationMs: 900 },
    })
  })

  it("never opens a step for a hidden tool; its progress goes out as a detached substep", async () => {
    const { sink, ops } = createSinkStub()
    const mapper = new TraceMapper(sink)

    await mapper.handle({
      type: "tool:start",
      toolCallId: "tc_h",
      toolName: "search_messages",
      stepType: AgentStepTypes.WORKSPACE_SEARCH,
      input: {},
      hidden: true,
    })
    await mapper.handle({
      type: "tool:progress",
      toolCallId: "tc_h",
      toolName: "search_messages",
      stepType: AgentStepTypes.WORKSPACE_SEARCH,
      substep: "phase",
    })
    await mapper.handle({
      type: "tool:complete",
      toolCallId: "tc_h",
      toolName: "search_messages",
      input: {},
      output: "{}",
      durationMs: 5,
      trace: { stepType: AgentStepTypes.WORKSPACE_SEARCH, content: "…" },
    })
    // After complete cleared the hidden marker, an error for the same id would
    // be the unknown-tool path — but a hidden tool's error BEFORE complete is
    // suppressed:
    await mapper.handle({
      type: "tool:start",
      toolCallId: "tc_h2",
      toolName: "search_users",
      stepType: AgentStepTypes.WORKSPACE_SEARCH,
      input: {},
      hidden: true,
    })
    await mapper.handle({
      type: "tool:error",
      toolCallId: "tc_h2",
      toolName: "search_users",
      error: "boom",
      durationMs: 1,
    })

    expect(ops).toEqual([{ op: "detached", stepType: AgentStepTypes.WORKSPACE_SEARCH, text: "phase" }])
  })

  it("skips blank substeps", async () => {
    const { sink, ops } = createSinkStub()
    const mapper = new TraceMapper(sink)

    await mapper.handle({
      type: "tool:start",
      toolCallId: "tc_1",
      toolName: "general_research",
      stepType: AgentStepTypes.RESEARCH,
      input: {},
    })
    await mapper.handle({
      type: "tool:progress",
      toolCallId: "tc_1",
      toolName: "general_research",
      stepType: AgentStepTypes.RESEARCH,
      substep: "   ",
    })

    expect(ops.filter((o) => o.op === "substep" || o.op === "detached")).toHaveLength(0)
  })

  it("finalizes an in-flight step as TOOL_ERROR with the error content", async () => {
    const { sink, ops } = createSinkStub()
    const mapper = new TraceMapper(sink)

    await mapper.handle({
      type: "tool:start",
      toolCallId: "tc_1",
      toolName: "read_url",
      stepType: AgentStepTypes.VISIT_PAGE,
      input: {},
    })
    await mapper.handle({ type: "tool:error", toolCallId: "tc_1", toolName: "read_url", error: "boom", durationMs: 7 })

    expect(ops).toEqual([
      { op: "open", stepIndex: 0, stepType: AgentStepTypes.VISIT_PAGE },
      {
        op: "finalize",
        stepIndex: 0,
        fin: { stepType: AgentStepTypes.TOOL_ERROR, content: "read_url failed: boom", durationMs: 7 },
      },
    ])
  })

  it("synthesizes an opened + finalized TOOL_ERROR step for an unknown tool", async () => {
    const { sink, ops } = createSinkStub()
    const mapper = new TraceMapper(sink)

    await mapper.handle({
      type: "tool:error",
      toolCallId: "tc_unknown",
      toolName: "nonexistent_tool",
      error: "Unknown tool",
      durationMs: 0,
    })

    expect(ops).toEqual([
      {
        op: "open",
        stepIndex: 0,
        stepType: AgentStepTypes.TOOL_ERROR,
        content: "nonexistent_tool failed: Unknown tool",
      },
      { op: "finalize", stepIndex: 0, fin: { stepType: AgentStepTypes.TOOL_ERROR, durationMs: 0 } },
    ])
  })

  it("maps message:sent and message:edited with messageId and sources on the finalize", async () => {
    const { sink, ops } = createSinkStub()
    const mapper = new TraceMapper(sink)

    await mapper.handle({ type: "message:sent", messageId: "msg_1", content: "Paris.", sources: [] })
    await mapper.handle({ type: "message:edited", messageId: "msg_1", content: "Paris!", sources: [] })

    expect(ops).toEqual([
      { op: "open", stepIndex: 0, stepType: AgentStepTypes.MESSAGE_SENT, content: "Paris." },
      {
        op: "finalize",
        stepIndex: 0,
        fin: { stepType: AgentStepTypes.MESSAGE_SENT, content: "Paris.", messageId: "msg_1", sources: [] },
      },
      { op: "open", stepIndex: 1, stepType: AgentStepTypes.MESSAGE_EDITED, content: "Paris!" },
      {
        op: "finalize",
        stepIndex: 1,
        fin: { stepType: AgentStepTypes.MESSAGE_EDITED, content: "Paris!", messageId: "msg_1", sources: [] },
      },
    ])
  })

  it("persists the reconsider/context steps with the canonical JSON shapes (300-char snippet)", async () => {
    const { sink, ops } = createSinkStub()
    const mapper = new TraceMapper(sink)

    const longContent = "x".repeat(500)
    const message = {
      sequence: 1n,
      messageId: "msg_n",
      changeType: "message_created" as const,
      content: longContent,
      authorId: "user_1",
      authorName: "Kris",
      authorType: "user" as const,
      createdAt: "2026-06-05T10:00:00.000Z",
    }

    await mapper.handle({ type: "response:kept", reason: "still accurate" })
    await mapper.handle({ type: "context:received", messages: [message] })
    await mapper.handle({ type: "reconsidering", draft: "draft text", newMessages: [message] })

    const opens = ops.filter((o) => o.op === "open")
    expect(opens).toHaveLength(3)

    expect(opens[0]).toMatchObject({ stepType: AgentStepTypes.RECONSIDERING })
    expect(JSON.parse((opens[0] as { content?: string }).content!)).toEqual({
      decision: "kept_previous_response",
      reason: "still accurate",
    })

    expect(opens[1]).toMatchObject({ stepType: AgentStepTypes.CONTEXT_RECEIVED })
    const context = JSON.parse((opens[1] as { content?: string }).content!) as {
      messages: Array<{ content: string; messageId: string; changeType: string }>
    }
    expect(context.messages[0]).toMatchObject({ messageId: "msg_n", changeType: "message_created" })
    expect(context.messages[0]!.content).toHaveLength(300)

    expect(opens[2]).toMatchObject({ stepType: AgentStepTypes.RECONSIDERING })
    const reconsidering = JSON.parse((opens[2] as { content?: string }).content!) as {
      draftResponse: string
      newMessages: Array<{ content: string }>
    }
    expect(reconsidering.draftResponse).toBe("draft text")
    expect(reconsidering.newMessages[0]!.content).toHaveLength(300)

    // All three finalize contentless (the content stands from the open).
    const finals = ops.filter((o) => o.op === "finalize") as Array<{ fin: TraceStepFinalize }>
    expect(finals.map((f) => f.fin)).toEqual([
      { stepType: AgentStepTypes.RECONSIDERING },
      { stepType: AgentStepTypes.CONTEXT_RECEIVED },
      { stepType: AgentStepTypes.RECONSIDERING },
    ])
  })

  it("ignores session lifecycle events", async () => {
    const { sink, ops } = createSinkStub()
    const mapper = new TraceMapper(sink)

    await mapper.handle({ type: "session:start", sessionId: "session_1" })
    await mapper.handle({ type: "session:end", messagesSent: 1, sourceCount: 0 })
    await mapper.handle({ type: "session:error", error: "boom" })

    expect(ops).toEqual([])
  })
})
