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

  it("ignores non-step lifecycle events", async () => {
    const { observer, steps } = makeObserver()

    await observer.handle({ type: "session:start", sessionId: "session_1" })
    await observer.handle({ type: "session:end", messagesSent: 1, sourceCount: 0 })

    expect(steps).toHaveLength(0)
  })
})
