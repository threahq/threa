import { describe, expect, it } from "vitest"
import {
  buildMessageAad,
  buildWrapAad,
  bytesToBase64,
  generateStreamKey,
  openMessageAsString,
  sealMessage,
  wrapStreamKey,
} from "@threa/crypto"
import type { EnclaveSessionAssignment } from "@threa/types"
import { createEnclaveKeyPair, type EnclaveKeyPair } from "../keystore"
import type { RawChatFn, RawChatRequest, RawChatResult } from "../llm"
import { InvokeError, runEnclaveTurn } from "./run-turn"

const STREAM_ID = "stream_journal"
const GEN = 0

async function wrapSskToEnclave(keyPair: EnclaveKeyPair, ssk: Uint8Array, keyGeneration = GEN) {
  const wrap = await wrapStreamKey({
    key: ssk,
    recipientPublicKey: keyPair.publicKey,
    aad: buildWrapAad({ streamId: STREAM_ID, keyGeneration, recipientKeyId: keyPair.keyId }),
  })
  return { keyGeneration, wrapEnc: bytesToBase64(wrap.enc), wrapCt: bytesToBase64(wrap.ct) }
}

async function sealUnder(ssk: Uint8Array, text: string, messageId: string, senderId: string, keyGeneration = GEN) {
  const sealed = await sealMessage({
    key: ssk,
    keyGeneration,
    payload: text,
    aad: buildMessageAad({ streamId: STREAM_ID, messageId, senderId }),
  })
  return { ciphertext: bytesToBase64(sealed.ciphertext), envelope: sealed.envelope }
}

/** Returns queued responses in order (falling back to the last), recording what it saw. */
function stubChat(responses: RawChatResult | RawChatResult[]): { fn: RawChatFn; seen: RawChatRequest[] } {
  const queue = Array.isArray(responses) ? [...responses] : [responses]
  const seen: RawChatRequest[] = []
  const fn: RawChatFn = async (req) => {
    seen.push(req)
    return queue.length > 1 ? queue.shift()! : queue[0]!
  }
  return { fn, seen }
}

function textReply(text: string): RawChatResult {
  return { message: { content: text }, model: "stub/model", usage: { prompt_tokens: 11, completion_tokens: 7 } }
}

function sendMessageReply(...contents: string[]): RawChatResult {
  return {
    message: {
      content: null,
      tool_calls: contents.map((content, i) => ({
        id: `call_${i}`,
        type: "function" as const,
        function: { name: "send_message", arguments: JSON.stringify({ content }) },
      })),
    },
    model: "stub/model",
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  }
}

function baseRequest(over: Partial<EnclaveSessionAssignment>): EnclaveSessionAssignment {
  return {
    sessionId: "session_test",
    streamId: STREAM_ID,
    wraps: [],
    history: [],
    prompt: { ciphertext: "", envelope: { v: 2, keyGeneration: GEN, iv: "", aad: "" } },
    system: "You are Ariadne.",
    model: "anthropic/claude-sonnet-4.6",
    reply: { keyGeneration: GEN, senderId: "persona_ariadne" },
    ...over,
  }
}

describe("runEnclaveTurn", () => {
  it("opens the forwarded turn and seals a reply the owner's SSK can recover", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)
    const prompt = await sealUnder(ssk, "What's the capital of France?", "msg_user", "usr_owner")
    const chat = stubChat(textReply("Paris."))

    const result = await runEnclaveTurn({ keyPair, rawChat: chat.fn }, baseRequest({ wraps: [wrap], prompt }))

    // The model saw the system prompt then the decrypted user turn — never ciphertext —
    // and was offered the send_message tool.
    expect(chat.seen[0]?.messages).toEqual([
      { role: "system", content: "You are Ariadne." },
      { role: "user", content: "What's the capital of France?" },
    ])
    expect(chat.seen[0]?.tools?.some((t) => t.function.name === "send_message")).toBe(true)

    // Exactly one reply, sealed under the same SSK and bound to the id the enclave minted.
    expect(result.messages).toHaveLength(1)
    const reply = result.messages[0]!
    expect(reply.messageId).toMatch(/^msg_/)
    const replyText = await openMessageAsString({
      key: ssk,
      envelope: reply.envelope,
      ciphertext: Buffer.from(reply.ciphertext, "base64"),
    })
    expect(replyText).toBe("Paris.")
    expect(reply.envelope.keyGeneration).toBe(GEN)
    expect(result.model).toBe("anthropic/claude-sonnet-4.6")
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 7 })
  })

  it("seals every message when the loop sends more than one", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)
    const prompt = await sealUnder(ssk, "Give me two notes.", "msg_user", "usr_owner")
    const chat = stubChat(sendMessageReply("First.", "Second."))

    const result = await runEnclaveTurn({ keyPair, rawChat: chat.fn }, baseRequest({ wraps: [wrap], prompt }))

    expect(result.messages).toHaveLength(2)
    const opened = await Promise.all(
      result.messages.map((m) =>
        openMessageAsString({ key: ssk, envelope: m.envelope, ciphertext: Buffer.from(m.ciphertext, "base64") })
      )
    )
    expect(opened).toEqual(["First.", "Second."])
    // Each reply has a distinct minted id (so each AAD binding is unique).
    expect(new Set(result.messages.map((m) => m.messageId)).size).toBe(2)
  })

  it("includes decryptable history with roles and skips generations it has no wrap for", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)

    const readable = await sealUnder(ssk, "Earlier, you greeted me.", "msg_old", "persona_ariadne")
    const unreadable = await sealUnder(generateStreamKey(), "secret pre-invite turn", "msg_secret", "usr_owner", 99)
    const prompt = await sealUnder(ssk, "Continue.", "msg_user", "usr_owner")
    const chat = stubChat(textReply("Sure."))

    await runEnclaveTurn(
      { keyPair, rawChat: chat.fn },
      baseRequest({
        wraps: [wrap],
        history: [
          { ...unreadable, role: "user" },
          { ...readable, role: "assistant" },
        ],
        prompt,
      })
    )

    expect(chat.seen[0]?.messages).toEqual([
      { role: "system", content: "You are Ariadne." },
      { role: "assistant", content: "Earlier, you greeted me." },
      { role: "user", content: "Continue." },
    ])
  })

  it("rejects when the prompt's generation has no wrap (can't read the trigger)", async () => {
    const keyPair = await createEnclaveKeyPair()
    const promptSsk = generateStreamKey()
    const otherSsk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, otherSsk, 7)
    const prompt = await sealUnder(promptSsk, "hi", "msg_user", "usr_owner", GEN)

    await expect(
      runEnclaveTurn(
        { keyPair, rawChat: stubChat(textReply("x")).fn },
        baseRequest({ wraps: [wrap], prompt, reply: { keyGeneration: 7, senderId: "persona_ariadne" } })
      )
    ).rejects.toBeInstanceOf(InvokeError)
  })
})
