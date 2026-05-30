import { describe, expect, it } from "vitest"
import { generateStreamKey, openMessageAsString } from "@threa/crypto"
import type { EnclaveSealedStep } from "@threa/types"
import { EnclaveTraceObserver } from "./trace-observer"

const STREAM_ID = "stream_x"
const GEN = 2
const SENDER = "persona_ariadne"

function makeObserver(): { observer: EnclaveTraceObserver; ssk: Uint8Array; steps: EnclaveSealedStep[] } {
  const ssk = generateStreamKey()
  const steps: EnclaveSealedStep[] = []
  const observer = new EnclaveTraceObserver({
    streamId: STREAM_ID,
    replySsk: ssk,
    replyKeyGeneration: GEN,
    senderId: SENDER,
    sendStep: async (step) => {
      steps.push(step)
    },
  })
  return { observer, ssk, steps }
}

describe("EnclaveTraceObserver", () => {
  it("seals a thinking step under the SSK and forwards it", async () => {
    const { observer, ssk, steps } = makeObserver()

    await observer.handle({ type: "thinking", content: "Let me reason about this.", durationMs: 42 })

    expect(steps).toHaveLength(1)
    const step = steps[0]!
    expect(step.stepType).toBe("thinking")
    expect(step.stepId).toMatch(/^step_/)
    expect(step.durationMs).toBe(42)
    expect(step.envelope.keyGeneration).toBe(GEN)
    // The content is sealed — only the SSK opens it (the server never sees plaintext).
    const opened = await openMessageAsString({
      key: ssk,
      envelope: step.envelope,
      ciphertext: Buffer.from(step.ciphertext, "base64"),
    })
    expect(opened).toBe("Let me reason about this.")
  })

  it("seals a message_sent step and carries the reply id in the clear", async () => {
    const { observer, ssk, steps } = makeObserver()

    await observer.handle({ type: "message:sent", messageId: "msg_reply", content: "Paris." })

    expect(steps).toHaveLength(1)
    const step = steps[0]!
    expect(step.stepType).toBe("message_sent")
    expect(step.messageId).toBe("msg_reply")
    const opened = await openMessageAsString({
      key: ssk,
      envelope: step.envelope,
      ciphertext: Buffer.from(step.ciphertext, "base64"),
    })
    expect(opened).toBe("Paris.")
  })

  it("seals a completed tool call under its declared step type and content", async () => {
    const { observer, ssk, steps } = makeObserver()

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
    const step = steps[0]!
    expect(step.stepType).toBe("web_search")
    expect(step.durationMs).toBe(850)
    const opened = await openMessageAsString({
      key: ssk,
      envelope: step.envelope,
      ciphertext: Buffer.from(step.ciphertext, "base64"),
    })
    expect(opened).toBe("weather")
  })

  it("seals a tool error as a tool_error step", async () => {
    const { observer, ssk, steps } = makeObserver()

    await observer.handle({
      type: "tool:error",
      toolCallId: "tc_1",
      toolName: "read_url",
      error: "URL blocked by SSRF protection",
      durationMs: 12,
    })

    expect(steps).toHaveLength(1)
    expect(steps[0]!.stepType).toBe("tool_error")
    const opened = await openMessageAsString({
      key: ssk,
      envelope: steps[0]!.envelope,
      ciphertext: Buffer.from(steps[0]!.ciphertext, "base64"),
    })
    expect(opened).toBe("URL blocked by SSRF protection")
  })

  it("ignores non-step lifecycle events", async () => {
    const { observer, steps } = makeObserver()

    await observer.handle({ type: "session:start", sessionId: "session_1" })
    await observer.handle({ type: "session:end", messagesSent: 1, sourceCount: 0 })

    expect(steps).toHaveLength(0)
  })
})
