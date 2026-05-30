import { describe, expect, it, vi } from "vitest"
import type { NextFunction, Request, Response } from "express"
import {
  buildWrapAad,
  bytesToBase64,
  generateStreamKey,
  openMessageAsString,
  sealMessage,
  buildMessageAad,
  wrapStreamKey,
} from "@threa/crypto"
import {
  INTERNAL_API_KEY_HEADER,
  type EnclaveSealedReply,
  type EnclaveSessionAssignment,
  type EnclaveSessionResult,
} from "@threa/types"
import { createEnclaveKeyPair, type EnclaveKeyPair } from "./keystore"
import type { BackendCallbacks } from "./agent/backend-callbacks"
import type { RawChatFn } from "./llm"
import { createSessionsHandler, requireInternalKey } from "./sessions"

const STREAM_ID = "stream_x"
const GEN = 0

function fakeRes(): Response & { statusCode: number; jsonBody?: unknown } {
  const res = {
    statusCode: 200,
    jsonBody: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(body: unknown) {
      this.jsonBody = body
      return this
    },
    end() {
      return this
    },
  }
  return res as unknown as Response & { statusCode: number; jsonBody?: unknown }
}

describe("requireInternalKey", () => {
  function fakeReq(headerValue: string | undefined): Request {
    return {
      header: (name: string) => (name === INTERNAL_API_KEY_HEADER ? headerValue : undefined),
    } as unknown as Request
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
    requireInternalKey("shared-secret")(fakeReq("nope"), res, (() => {
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
    streamId: STREAM_ID,
    wraps: [{ keyGeneration: GEN, wrapEnc: bytesToBase64(wrap.enc), wrapCt: bytesToBase64(wrap.ct) }],
    history: [],
    prompt: { ciphertext: bytesToBase64(sealed.ciphertext), envelope: sealed.envelope },
    system: "You are Ariadne.",
    model: "anthropic/claude-sonnet-4.6",
    reply: { keyGeneration: GEN, senderId: "persona_ariadne" },
  }
}

describe("createSessionsHandler", () => {
  it("400s an invalid assignment without starting work", () => {
    const handler = createSessionsHandler({
      keyPair: {} as EnclaveKeyPair,
      rawChat: (() => {
        throw new Error("should not run")
      }) as unknown as RawChatFn,
      callbacks: {} as BackendCallbacks,
      inFlight: new Set(),
    })
    const res = fakeRes()
    handler({ body: { not: "valid" } } as unknown as Request, res)
    expect(res.statusCode).toBe(400)
  })

  it("acks 202 and completes the session with a reply the SSK can open", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const assignment = await assignmentFor(keyPair, ssk, "What's the capital of France?")

    const rawChat: RawChatFn = async () => ({ message: { content: "Paris." }, model: "stub/model" })
    const streamed: { sessionId: string; reply: EnclaveSealedReply }[] = []
    let completed: { sessionId: string; result: EnclaveSessionResult } | null = null
    const callbacks: BackendCallbacks = {
      heartbeat: async () => {},
      message: async (sessionId, reply) => {
        streamed.push({ sessionId, reply })
      },
      step: async () => {},
      complete: async (sessionId, result) => {
        completed = { sessionId, result }
      },
    }
    const inFlight = new Set<string>()
    const handler = createSessionsHandler({ keyPair, rawChat, callbacks, inFlight })

    const res = fakeRes()
    handler({ body: assignment } as unknown as Request, res)
    expect(res.statusCode).toBe(202)

    // The loop runs detached; wait for it to drain (the handler clears inFlight on finish).
    await vi.waitFor(() => expect(inFlight.size).toBe(0))

    // The reply was streamed via message(), and complete() acked with its id.
    expect(streamed).toHaveLength(1)
    expect(streamed[0]!.sessionId).toBe("session_test")
    const text = await openMessageAsString({
      key: ssk,
      envelope: streamed[0]!.reply.envelope,
      ciphertext: Buffer.from(streamed[0]!.reply.ciphertext, "base64"),
    })
    expect(text).toBe("Paris.")
    expect(completed).not.toBeNull()
    expect(completed!.result.messageIds).toEqual([streamed[0]!.reply.messageId])
  })

  it("clears inFlight even when the detached run throws (no permanently-pinned session)", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const assignment = await assignmentFor(keyPair, ssk, "boom")

    // rawChat throws → runEnclaveTurn rejects → runEnclaveSession swallows + the
    // handler's .finally must still release the session id.
    const rawChat: RawChatFn = async () => {
      throw new Error("model exploded")
    }
    let completed = false
    const callbacks: BackendCallbacks = {
      heartbeat: async () => {},
      message: async () => {},
      step: async () => {},
      complete: async () => {
        completed = true
      },
    }
    const inFlight = new Set<string>()
    const handler = createSessionsHandler({ keyPair, rawChat, callbacks, inFlight })

    const res = fakeRes()
    handler({ body: assignment } as unknown as Request, res)
    expect(res.statusCode).toBe(202)

    await vi.waitFor(() => expect(inFlight.size).toBe(0))
    expect(completed).toBe(false) // the failed turn never acked completion
  })

  it("acks 202 without re-running when the session is already in flight", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const assignment = await assignmentFor(keyPair, ssk, "hi") // sessionId: "session_test"

    let ran = false
    const handler = createSessionsHandler({
      keyPair,
      rawChat: (async () => {
        ran = true
        return { message: { content: "x" }, model: "stub" }
      }) as RawChatFn,
      callbacks: { heartbeat: async () => {}, message: async () => {}, step: async () => {}, complete: async () => {} },
      inFlight: new Set([assignment.sessionId]), // already running
    })
    const res = fakeRes()
    handler({ body: assignment } as unknown as Request, res)
    expect(res.statusCode).toBe(202)
    expect(ran).toBe(false)
  })
})
