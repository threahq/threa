import { describe, expect, it } from "vitest"
import {
  buildWrapAad,
  bytesToBase64,
  generateStreamKey,
  openMessageAsString,
  sealMessage,
  buildMessageAad,
  wrapStreamKey,
} from "@threa/crypto"
import type { SealedReply, EnclaveSessionAssignment, EnclaveSessionResult } from "@threa/types"
import { createEnclaveKeyPair, type EnclaveKeyPair } from "../keystore"
import type { RawChatFn } from "../llm"
import type { BackendCallbacks } from "./backend-callbacks"
import { runEnclaveSession } from "./session-runner"

const STREAM_ID = "stream_x"
const GEN = 0

async function assignmentFor(
  keyPair: EnclaveKeyPair,
  ssk: Uint8Array,
  promptText: string
): Promise<EnclaveSessionAssignment> {
  const wrap = await wrapStreamKey({
    key: ssk,
    recipientPublicKey: keyPair.publicKey,
    aad: buildWrapAad({ streamId: STREAM_ID, keyGeneration: GEN, recipientKeyId: keyPair.keyId }),
  })
  const sealed = await sealMessage({
    key: ssk,
    keyGeneration: GEN,
    payload: promptText,
    aad: buildMessageAad({ streamId: STREAM_ID, messageId: "msg_user", senderId: "usr_owner" }),
  })
  return {
    sessionId: "session_test",
    callbackToken: "cbtok_test",
    streamId: STREAM_ID,
    wraps: [{ keyGeneration: GEN, wrapEnc: bytesToBase64(wrap.enc), wrapCt: bytesToBase64(wrap.ct) }],
    history: [],
    prompt: { ciphertext: bytesToBase64(sealed.ciphertext), envelope: sealed.envelope },
    system: "You are Ariadne.",
    model: "anthropic/claude-sonnet-4.6",
    reply: { keyGeneration: GEN, senderId: "persona_ariadne" },
  }
}

function noopCallbacks(overrides: Partial<BackendCallbacks>): BackendCallbacks {
  return {
    heartbeat: async () => ({ abort: false }),
    message: async () => {},
    pollMessages: async () => [],
    stepStarted: async () => {},
    step: async () => {},
    substep: async () => {},
    namingDecision: async () => {},
    sealedSummary: async () => {},
    complete: async () => {},
    fail: async () => {},
    ...overrides,
  }
}

describe("runEnclaveSession", () => {
  it("streams a reply the SSK can open and completes the session with its id", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const assignment = await assignmentFor(keyPair, ssk, "What's the capital of France?")

    const rawChat: RawChatFn = async () => ({ message: { content: "Paris." }, model: "stub/model" })
    const streamed: { sessionId: string; reply: SealedReply }[] = []
    let completed: { sessionId: string; result: EnclaveSessionResult } | null = null
    const callbacks = noopCallbacks({
      message: async (sessionId, reply) => {
        streamed.push({ sessionId, reply })
      },
      complete: async (sessionId, result) => {
        completed = { sessionId, result }
      },
    })

    await runEnclaveSession({ keyPair, rawChat, callbacks }, assignment)

    // The reply was streamed via message(), and complete() acked with its id.
    expect(streamed).toContainEqual(expect.objectContaining({ sessionId: "session_test" }))
    const text = await openMessageAsString({
      key: ssk,
      envelope: streamed[0]!.reply.envelope,
      ciphertext: Buffer.from(streamed[0]!.reply.ciphertext, "base64"),
    })
    expect(text).toBe("Paris.")
    expect(completed).not.toBeNull()
    expect(completed!.result.messageIds).toEqual([streamed[0]!.reply.messageId])
  })

  it("acks a thrown turn via fail() with scrubbed metadata only, never completing", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const assignment = await assignmentFor(keyPair, ssk, "boom")

    const rawChat: RawChatFn = async () => {
      throw new Error("model exploded")
    }
    let completed = false
    const failed: { sessionId: string; errorName: string }[] = []
    const callbacks = noopCallbacks({
      complete: async () => {
        completed = true
      },
      fail: async (sessionId, failure) => {
        failed.push({ sessionId, errorName: failure.errorName })
      },
    })

    await runEnclaveSession({ keyPair, rawChat, callbacks }, assignment)

    expect(completed).toBe(false) // the failed turn never acked completion
    // It acked the failure instead, with scrubbed metadata only (the error's class
    // name, never the thrown message — which could carry decrypted payload bytes).
    expect(failed).toEqual([{ sessionId: "session_test", errorName: "Error" }])
  })
})
