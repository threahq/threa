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
import type { EnclaveSealedReply, EnclaveSealedStep, EnclaveSessionAssignment } from "@threa/types"
import { createEnclaveKeyPair, type EnclaveKeyPair } from "../keystore"
import type { RawChatFn, RawChatRequest, RawChatResult } from "../llm"
import { InvokeError, runEnclaveTurn } from "./run-turn"

const STREAM_ID = "stream_journal"
const GEN = 0

/** Collects the replies and sealed trace steps the loop streams back. */
function collector(): {
  onMessage: (r: EnclaveSealedReply) => Promise<void>
  onStep: (s: EnclaveSealedStep) => Promise<void>
  sent: EnclaveSealedReply[]
  steps: EnclaveSealedStep[]
} {
  const sent: EnclaveSealedReply[] = []
  const steps: EnclaveSealedStep[] = []
  return { sent, steps, onMessage: async (r) => void sent.push(r), onStep: async (s) => void steps.push(s) }
}

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

function toolCallReply(name: string, args: Record<string, unknown>): RawChatResult {
  return {
    message: {
      content: null,
      tool_calls: [{ id: "call_tool", type: "function" as const, function: { name, arguments: JSON.stringify(args) } }],
    },
    model: "stub/model",
    usage: { prompt_tokens: 5, completion_tokens: 3 },
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
    const { onMessage, onStep, sent, steps } = collector()

    const result = await runEnclaveTurn(
      { keyPair, rawChat: chat.fn, onMessage, onStep },
      baseRequest({ wraps: [wrap], prompt })
    )

    // The model saw the system prompt then the decrypted user turn — never ciphertext —
    // and was offered the send_message tool.
    expect(chat.seen[0]?.messages).toEqual([
      { role: "system", content: "You are Ariadne." },
      { role: "user", content: "What's the capital of France?" },
    ])
    expect(chat.seen[0]?.tools?.some((t) => t.function.name === "send_message")).toBe(true)

    // Exactly one reply, streamed via onMessage, sealed under the same SSK and
    // bound to the id the enclave minted (also returned in messageIds).
    expect(sent).toHaveLength(1)
    const reply = sent[0]!
    expect(reply.messageId).toMatch(/^msg_/)
    expect(result.messageIds).toEqual([reply.messageId])
    const replyText = await openMessageAsString({
      key: ssk,
      envelope: reply.envelope,
      ciphertext: Buffer.from(reply.ciphertext, "base64"),
    })
    expect(replyText).toBe("Paris.")
    expect(reply.envelope.keyGeneration).toBe(GEN)
    expect(result.model).toBe("anthropic/claude-sonnet-4.6")
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 7 })

    // The reply is also traced as a sealed message_sent step the same SSK opens,
    // linked to the reply id (its content is ciphertext on the wire).
    const messageStep = steps.find((s) => s.stepType === "message_sent")
    expect(messageStep).toBeDefined()
    expect(messageStep!.stepId).toMatch(/^step_/)
    expect(messageStep!.messageId).toBe(reply.messageId)
    const stepText = await openMessageAsString({
      key: ssk,
      envelope: messageStep!.envelope,
      ciphertext: Buffer.from(messageStep!.ciphertext, "base64"),
    })
    expect(stepText).toBe("Paris.")
  })

  it("seals every message when the loop sends more than one", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)
    const prompt = await sealUnder(ssk, "Give me two notes.", "msg_user", "usr_owner")
    const chat = stubChat(sendMessageReply("First.", "Second."))
    const { onMessage, onStep, sent } = collector()

    const result = await runEnclaveTurn(
      { keyPair, rawChat: chat.fn, onMessage, onStep },
      baseRequest({ wraps: [wrap], prompt })
    )

    expect(sent).toHaveLength(2)
    const opened = await Promise.all(
      sent.map((m) =>
        openMessageAsString({ key: ssk, envelope: m.envelope, ciphertext: Buffer.from(m.ciphertext, "base64") })
      )
    )
    expect(opened).toEqual(["First.", "Second."])
    // Each reply has a distinct minted id (so each AAD binding is unique), and the
    // result reports them in send order.
    expect(new Set(sent.map((m) => m.messageId)).size).toBe(2)
    expect(result.messageIds).toEqual(sent.map((m) => m.messageId))
  })

  it("includes decryptable history with roles and skips generations it has no wrap for", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)

    const readable = await sealUnder(ssk, "Earlier, you greeted me.", "msg_old", "persona_ariadne")
    const unreadable = await sealUnder(generateStreamKey(), "secret pre-invite turn", "msg_secret", "usr_owner", 99)
    const prompt = await sealUnder(ssk, "Continue.", "msg_user", "usr_owner")
    const chat = stubChat(textReply("Sure."))

    const collected = collector()
    await runEnclaveTurn(
      { keyPair, rawChat: chat.fn, onMessage: collected.onMessage, onStep: collected.onStep },
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

  it("runs a tool call and seals its trace step under the SSK", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)
    const prompt = await sealUnder(ssk, "Read that page for me.", "msg_user", "usr_owner")
    // Turn 1: the model calls read_url (SSRF guard blocks localhost before any
    // real network egress — keeps the test hermetic). Turn 2: it answers.
    const chat = stubChat([
      toolCallReply("read_url", { url: "http://localhost/secret" }),
      textReply("Couldn't read it."),
    ])
    const { onMessage, onStep, sent, steps } = collector()

    const result = await runEnclaveTurn(
      { keyPair, rawChat: chat.fn, onMessage, onStep, tools: { tavilyApiKey: "tvly-test" } },
      baseRequest({ wraps: [wrap], prompt })
    )

    // The model was offered the enclave web tools alongside send_message.
    const offered = chat.seen[0]?.tools?.map((t) => t.function.name) ?? []
    expect(offered).toEqual(expect.arrayContaining(["web_search", "read_url", "general_research", "send_message"]))

    // The completed tool call was sealed as a trace step the owner's SSK opens.
    const toolStep = steps.find((s) => s.stepType === "visit_page")
    expect(toolStep).toBeDefined()
    expect(toolStep!.stepId).toMatch(/^step_/)
    const opened = await openMessageAsString({
      key: ssk,
      envelope: toolStep!.envelope,
      ciphertext: Buffer.from(toolStep!.ciphertext, "base64"),
    })
    // read_url's trace content is a JSON blob carrying the requested url.
    expect(opened).toContain("localhost")

    // The turn still produced its reply, streamed and reported under the same id.
    expect(result.messageIds[0]).toMatch(/^msg_/)
    expect(sent.find((m) => m.messageId === result.messageIds[0])).toBeDefined()
  })

  it("rejects when the prompt's generation has no wrap (can't read the trigger)", async () => {
    const keyPair = await createEnclaveKeyPair()
    const promptSsk = generateStreamKey()
    const otherSsk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, otherSsk, 7)
    const prompt = await sealUnder(promptSsk, "hi", "msg_user", "usr_owner", GEN)

    const collected = collector()
    await expect(
      runEnclaveTurn(
        { keyPair, rawChat: stubChat(textReply("x")).fn, onMessage: collected.onMessage, onStep: collected.onStep },
        baseRequest({ wraps: [wrap], prompt, reply: { keyGeneration: 7, senderId: "persona_ariadne" } })
      )
    ).rejects.toBeInstanceOf(InvokeError)
  })
})
