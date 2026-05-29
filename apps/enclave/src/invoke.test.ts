import { describe, expect, it } from "vitest"
import type { NextFunction, Request, Response } from "express"
import {
  buildMessageAad,
  buildWrapAad,
  bytesToBase64,
  generateStreamKey,
  openMessageAsString,
  sealMessage,
  wrapStreamKey,
} from "@threa/crypto"
import { INTERNAL_API_KEY_HEADER } from "@threa/types"
import { createEnclaveKeyPair, type EnclaveKeyPair } from "./keystore"
import { handleInvoke, InvokeError, requireInternalKey, type InvokeRequest } from "./invoke"
import type { ChatCompletionFn, ChatCompletionRequest } from "./llm"

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

/** Records the messages it was handed and returns a fixed reply. */
function stubLlm(reply: string): { fn: ChatCompletionFn; seen: ChatCompletionRequest[] } {
  const seen: ChatCompletionRequest[] = []
  const fn: ChatCompletionFn = async (req) => {
    seen.push(req)
    return { text: reply, model: "stub/model" }
  }
  return { fn, seen }
}

describe("handleInvoke", () => {
  it("opens the forwarded turn and seals a reply the owner's SSK can recover", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)
    const prompt = await sealUnder(ssk, "What's the capital of France?", "msg_user", "usr_owner")
    const llm = stubLlm("Paris.")

    const request: InvokeRequest = {
      streamId: STREAM_ID,
      wraps: [wrap],
      history: [],
      prompt,
      system: "You are Ariadne.",
      model: "anthropic/claude-sonnet-4.6",
      reply: { keyGeneration: GEN, messageId: "msg_reply", senderId: "persona_ariadne" },
    }

    const result = await handleInvoke({ keyPair, chatCompletion: llm.fn }, request)

    // The LLM saw the system prompt then the decrypted user turn — never ciphertext.
    expect(llm.seen[0]?.messages).toEqual([
      { role: "system", content: "You are Ariadne." },
      { role: "user", content: "What's the capital of France?" },
    ])

    // The reply opens under the same SSK, bound to the reply's identity.
    const replyText = await openMessageAsString({
      key: ssk,
      envelope: result.envelope,
      ciphertext: Buffer.from(result.ciphertext, "base64"),
    })
    expect(replyText).toBe("Paris.")
    expect(result.envelope.keyGeneration).toBe(GEN)
    expect(result.model).toBe("stub/model")
  })

  it("includes decryptable history with roles and skips generations it has no wrap for", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)

    // A prior assistant turn under gen 0 (decryptable) and an older turn under a
    // generation the enclave was never wrapped (gen 99 → must be skipped).
    const readable = await sealUnder(ssk, "Earlier, you greeted me.", "msg_old", "persona_ariadne")
    const unreadable = await sealUnder(generateStreamKey(), "secret pre-invite turn", "msg_secret", "usr_owner", 99)
    const prompt = await sealUnder(ssk, "Continue.", "msg_user", "usr_owner")
    const llm = stubLlm("Sure.")

    const request: InvokeRequest = {
      streamId: STREAM_ID,
      wraps: [wrap],
      history: [
        { ...unreadable, role: "user" },
        { ...readable, role: "assistant" },
      ],
      prompt,
      system: "You are Ariadne.",
      model: "anthropic/claude-sonnet-4.6",
      reply: { keyGeneration: GEN, messageId: "msg_reply", senderId: "persona_ariadne" },
    }

    await handleInvoke({ keyPair, chatCompletion: llm.fn }, request)

    expect(llm.seen[0]?.messages).toEqual([
      { role: "system", content: "You are Ariadne." },
      { role: "assistant", content: "Earlier, you greeted me." },
      { role: "user", content: "Continue." },
    ])
  })

  it("rejects when the prompt's generation has no wrap (can't read the trigger)", async () => {
    const keyPair = await createEnclaveKeyPair()
    const promptSsk = generateStreamKey()
    const otherSsk = generateStreamKey()
    // Wrap a DIFFERENT generation than the prompt was sealed under.
    const wrap = await wrapSskToEnclave(keyPair, otherSsk, 7)
    const prompt = await sealUnder(promptSsk, "hi", "msg_user", "usr_owner", GEN)

    const request: InvokeRequest = {
      streamId: STREAM_ID,
      wraps: [wrap],
      history: [],
      prompt,
      system: "You are Ariadne.",
      model: "anthropic/claude-sonnet-4.6",
      reply: { keyGeneration: 7, messageId: "msg_reply", senderId: "persona_ariadne" },
    }

    await expect(handleInvoke({ keyPair, chatCompletion: stubLlm("x").fn }, request)).rejects.toBeInstanceOf(
      InvokeError
    )
  })
})

describe("requireInternalKey", () => {
  function fakeReq(headerValue: string | undefined): Request {
    return {
      header: (name: string) => (name === INTERNAL_API_KEY_HEADER ? headerValue : undefined),
    } as unknown as Request
  }
  function fakeRes(): Response & { statusCode: number } {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code
        return this
      },
      json() {
        return this
      },
    }
    return res as unknown as Response & { statusCode: number }
  }

  it("401s and does not call next when the header is missing", () => {
    const res = fakeRes()
    let nexted = false
    requireInternalKey("shared-secret")(fakeReq(undefined), res, (() => {
      nexted = true
    }) as NextFunction)
    expect(res.statusCode).toBe(401)
    expect(nexted).toBe(false)
  })

  it("401s when the internal-api-key is wrong", () => {
    const res = fakeRes()
    let nexted = false
    requireInternalKey("shared-secret")(fakeReq("not-the-secret"), res, (() => {
      nexted = true
    }) as NextFunction)
    expect(res.statusCode).toBe(401)
    expect(nexted).toBe(false)
  })

  it("calls next when the key matches", () => {
    const res = fakeRes()
    let nexted = false
    requireInternalKey("shared-secret")(fakeReq("shared-secret"), res, (() => {
      nexted = true
    }) as NextFunction)
    expect(nexted).toBe(true)
    expect(res.statusCode).toBe(200)
  })
})
