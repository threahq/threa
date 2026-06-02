import { describe, expect, it } from "vitest"
import { generateStreamKey, openMessageAsString } from "@threa/crypto"
import type { EnclaveSealedStep, EnclaveSealedStepStart, EnclaveSealedSubstep } from "@threa/types"
import { EnclaveTraceObserver } from "./trace-observer"

const STREAM_ID = "stream_x"
const GEN = 2
const SENDER = "persona_ariadne"

function makeObserver(): {
  observer: EnclaveTraceObserver
  ssk: Uint8Array
  started: EnclaveSealedStepStart[]
  steps: EnclaveSealedStep[]
  substeps: EnclaveSealedSubstep[]
} {
  const ssk = generateStreamKey()
  const started: EnclaveSealedStepStart[] = []
  const steps: EnclaveSealedStep[] = []
  const substeps: EnclaveSealedSubstep[] = []
  const observer = new EnclaveTraceObserver({
    streamId: STREAM_ID,
    replySsk: ssk,
    replyKeyGeneration: GEN,
    senderId: SENDER,
    sendStepStarted: async (step) => {
      started.push(step)
    },
    sendStep: async (step) => {
      steps.push(step)
    },
    sendSubstep: async (substep) => {
      substeps.push(substep)
    },
  })
  return { observer, ssk, started, steps, substeps }
}

async function open(ssk: Uint8Array, sealed: { ciphertext?: string; envelope?: { keyGeneration: number } }) {
  return openMessageAsString({
    key: ssk,
    envelope: sealed.envelope as Parameters<typeof openMessageAsString>[0]["envelope"],
    ciphertext: Buffer.from(sealed.ciphertext!, "base64"),
  })
}

describe("EnclaveTraceObserver", () => {
  it("opens then finalizes a thinking step under the SSK, sharing one stepId", async () => {
    const { observer, ssk, started, steps } = makeObserver()

    await observer.handle({ type: "thinking", content: "Let me reason about this.", durationMs: 42 })

    // Lifecycle parity: a step:started precedes the finalized step, same id.
    expect(started).toHaveLength(1)
    expect(steps).toHaveLength(1)
    const open1 = started[0]!
    const done = steps[0]!
    expect(open1.stepId).toBe(done.stepId)
    expect(open1.stepType).toBe("thinking")
    expect(done.stepType).toBe("thinking")
    expect(done.durationMs).toBe(42)
    expect(done.envelope.keyGeneration).toBe(GEN)
    // Content (known up front) is sealed on both the start and the finalize.
    expect(await open(ssk, open1)).toBe("Let me reason about this.")
    expect(await open(ssk, done)).toBe("Let me reason about this.")
  })

  it("opens then finalizes a message_sent step, carrying the reply id on completion", async () => {
    const { observer, ssk, started, steps } = makeObserver()

    await observer.handle({ type: "message:sent", messageId: "msg_reply", content: "Paris." })

    expect(started).toHaveLength(1)
    expect(steps).toHaveLength(1)
    const done = steps[0]!
    expect(started[0]!.stepId).toBe(done.stepId)
    expect(done.stepType).toBe("message_sent")
    expect(done.messageId).toBe("msg_reply")
    expect(await open(ssk, done)).toBe("Paris.")
  })

  it("opens a contentless in-flight step at tool:start, then finalizes it at tool:complete", async () => {
    const { observer, ssk, started, steps } = makeObserver()

    await observer.handle({
      type: "tool:start",
      toolCallId: "tc_1",
      toolName: "web_search",
      stepType: "web_search",
      input: { query: "weather" },
    })

    // The in-flight step is opened with no content (the result isn't known yet),
    // so the trace dialog renders it as in-progress and hangs substeps under it.
    expect(started).toHaveLength(1)
    expect(started[0]!.stepType).toBe("web_search")
    expect(started[0]!.ciphertext).toBeUndefined()
    expect(steps).toHaveLength(0)

    await observer.handle({
      type: "tool:complete",
      toolCallId: "tc_1",
      toolName: "web_search",
      input: { query: "weather" },
      output: "{}",
      durationMs: 850,
      trace: { stepType: "web_search", content: "weather", sources: [] },
    })

    expect(steps).toHaveLength(1)
    const done = steps[0]!
    expect(done.stepId).toBe(started[0]!.stepId) // finalizes the same row
    expect(done.stepType).toBe("web_search")
    expect(done.durationMs).toBe(850)
    expect(await open(ssk, done)).toBe("weather")
  })

  it("seals each tool:progress phase and persists a running snapshot onto the in-flight step", async () => {
    const { observer, ssk, started, steps, substeps } = makeObserver()

    await observer.handle({
      type: "tool:start",
      toolCallId: "tc_1",
      toolName: "general_research",
      stepType: "research",
      input: {},
    })
    await observer.handle({
      type: "tool:progress",
      toolCallId: "tc_1",
      toolName: "general_research",
      stepType: "research",
      substep: 'Searching the web: "weather in paris"',
    })
    await observer.handle({
      type: "tool:progress",
      toolCallId: "tc_1",
      toolName: "general_research",
      stepType: "research",
      substep: "Reading https://example.com",
    })

    expect(started).toHaveLength(1) // the step:started — substeps don't open new rows
    expect(steps).toHaveLength(0) // not finalized yet
    expect(substeps).toHaveLength(2)

    // Each broadcast carries the single new phase, sealed, bound to the in-flight step.
    const second = substeps[1]!
    expect(second.stepType).toBe("research")
    expect(second.stepId).toBe(started[0]!.stepId)
    expect(await open(ssk, second)).toBe("Reading https://example.com")

    // …and the running snapshot — the full { substeps } list — sealed for refresh
    // recovery. It accumulates: the 2nd snapshot holds both phases in order.
    const snapshot = JSON.parse(
      await open(ssk, { ciphertext: second.snapshotCiphertext, envelope: second.snapshotEnvelope })
    ) as { substeps: Array<{ text: string; at: string }> }
    expect(snapshot.substeps.map((s) => s.text)).toEqual([
      'Searching the web: "weather in paris"',
      "Reading https://example.com",
    ])
    expect(snapshot.substeps.every((s) => typeof s.at === "string")).toBe(true)
  })

  it("broadcasts a substep without a snapshot when no step was opened (hidden tool)", async () => {
    const { observer, ssk, substeps } = makeObserver()

    await observer.handle({
      type: "tool:progress",
      toolCallId: "tc_hidden",
      toolName: "general_research",
      stepType: "research",
      substep: "phase",
    })

    expect(substeps).toHaveLength(1)
    expect(substeps[0]!.stepId).toBeUndefined()
    expect(substeps[0]!.snapshotCiphertext).toBeUndefined()
    expect(await open(ssk, substeps[0]!)).toBe("phase")
  })

  it("drops a tool:complete with no matching tool:start (hidden tool)", async () => {
    const { observer, started, steps } = makeObserver()

    await observer.handle({
      type: "tool:complete",
      toolCallId: "tc_hidden",
      toolName: "search_users",
      input: {},
      output: "{}",
      durationMs: 5,
      trace: { stepType: "workspace_search", content: "…", sources: [] },
    })

    // No tool:start was recorded (it was hidden), so nothing surfaces in the trace.
    expect(started).toHaveLength(0)
    expect(steps).toHaveLength(0)
  })

  it("synthesizes a started+finalized tool_error when the tool was never opened", async () => {
    const { observer, ssk, started, steps } = makeObserver()

    await observer.handle({
      type: "tool:error",
      toolCallId: "tc_1",
      toolName: "read_url",
      error: "URL blocked by SSRF protection",
      durationMs: 12,
    })

    expect(started).toHaveLength(1)
    expect(started[0]!.stepType).toBe("tool_error")
    const errorStep = steps.find((s) => s.stepType === "tool_error")
    expect(errorStep).toBeDefined()
    expect(await open(ssk, errorStep!)).toBe("read_url failed: URL blocked by SSRF protection")
  })

  it("finalizes the in-flight step with the error when a tool:start preceded it", async () => {
    const { observer, ssk, started, steps } = makeObserver()

    await observer.handle({
      type: "tool:start",
      toolCallId: "tc_1",
      toolName: "read_url",
      stepType: "visit_page",
      input: { url: "http://x" },
    })
    await observer.handle({
      type: "tool:error",
      toolCallId: "tc_1",
      toolName: "read_url",
      error: "boom",
      durationMs: 7,
    })

    // One started (visit_page, contentless) + one finalize carrying the error.
    expect(started).toHaveLength(1)
    expect(steps).toHaveLength(1)
    expect(steps[0]!.stepId).toBe(started[0]!.stepId)
    expect(await open(ssk, steps[0]!)).toBe("read_url failed: boom")
  })

  it("still finalizes the step when the step:started frame fails (best-effort start)", async () => {
    // A backend missing /steps/started (or a transient blip) makes sendStepStarted
    // reject. That must never drop the durable finalized step.
    const ssk = generateStreamKey()
    const started: EnclaveSealedStepStart[] = []
    const steps: EnclaveSealedStep[] = []
    const observer = new EnclaveTraceObserver({
      streamId: STREAM_ID,
      replySsk: ssk,
      replyKeyGeneration: GEN,
      senderId: SENDER,
      sendStepStarted: async () => {
        throw new Error("session step:started failed: 404")
      },
      sendStep: async (step) => {
        steps.push(step)
      },
      sendSubstep: async () => {},
    })

    await observer.handle({ type: "message:sent", messageId: "msg_reply", content: "Paris." })

    expect(started).toHaveLength(0) // the start frame never landed…
    expect(steps).toHaveLength(1) // …but the finalize did
    expect(steps[0]!.stepType).toBe("message_sent")
    expect(steps[0]!.messageId).toBe("msg_reply")
    expect(await open(ssk, steps[0]!)).toBe("Paris.")
  })

  it("ignores non-step lifecycle events", async () => {
    const { observer, started, steps } = makeObserver()

    await observer.handle({ type: "session:start", sessionId: "session_1" })
    await observer.handle({ type: "session:end", messagesSent: 1, sourceCount: 0 })

    expect(started).toHaveLength(0)
    expect(steps).toHaveLength(0)
  })
})
