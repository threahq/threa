import { afterEach, describe, expect, it, mock } from "bun:test"
import { INTERNAL_API_KEY_HEADER, type EnclaveInvokeRequest } from "@threa/types"
import { EnclaveForwarder, EnclaveForwardError } from "./forwarder"

const REQUEST: EnclaveInvokeRequest = {
  streamId: "stream_1",
  wraps: [{ keyGeneration: 0, wrapEnc: "ZW5j", wrapCt: "Y3Q=" }],
  history: [],
  prompt: { ciphertext: "Y3Q=", envelope: { v: 2, keyGeneration: 0, iv: "aXY=", aad: "YWFk" } },
  system: "You are Ariadne.",
  model: "anthropic/claude-sonnet-4.6",
  reply: { keyGeneration: 0, senderId: "persona_ariadne" },
}

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})

describe("EnclaveForwarder.invoke", () => {
  it("POSTs to <instanceUrl>/invoke with the internal-api-key header and returns the parsed reply", async () => {
    const captured: { url?: string; headers?: Record<string, string>; body?: string } = {}
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      captured.url = String(url)
      captured.headers = (init?.headers ?? {}) as Record<string, string>
      captured.body = init?.body as string
      return new Response(
        JSON.stringify({
          messages: [
            {
              messageId: "msg_reply",
              ciphertext: "cmVwbHk=",
              envelope: { v: 2, keyGeneration: 0, iv: "aXY=", aad: "YWFk" },
            },
          ],
          model: "anthropic/claude-sonnet-4.6",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    }) as unknown as typeof fetch

    const forwarder = new EnclaveForwarder({ internalApiKey: "shared-secret" })
    const res = await forwarder.invoke("https://enclave-1.internal/", REQUEST)

    expect(captured.url).toBe("https://enclave-1.internal/invoke")
    expect(captured.headers?.[INTERNAL_API_KEY_HEADER]).toBe("shared-secret")
    expect(JSON.parse(captured.body!)).toMatchObject({ streamId: "stream_1", reply: { senderId: "persona_ariadne" } })
    expect(res.messages[0]!.ciphertext).toBe("cmVwbHk=")
    expect(res.messages[0]!.messageId).toBe("msg_reply")
    expect(res.messages[0]!.envelope.keyGeneration).toBe(0)
  })

  it("throws EnclaveForwardError with the status on a non-ok response", async () => {
    globalThis.fetch = mock(async () => new Response(null, { status: 503 })) as unknown as typeof fetch
    const forwarder = new EnclaveForwarder({ internalApiKey: "s" })

    const err = await forwarder.invoke("https://enclave-1.internal", REQUEST).catch((e) => e)
    expect(err).toBeInstanceOf(EnclaveForwardError)
    expect((err as EnclaveForwardError).status).toBe(503)
  })

  it("rejects a malformed 200 response at the boundary", async () => {
    // Missing the messages array entirely.
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ model: "m" }), { status: 200 })
    ) as unknown as typeof fetch
    let forwarder = new EnclaveForwarder({ internalApiKey: "s" })
    let err = await forwarder.invoke("https://enclave-1.internal", REQUEST).catch((e) => e)
    expect(err).toBeInstanceOf(EnclaveForwardError)

    // A messages array with an element missing its messageId.
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ model: "m", messages: [{ ciphertext: "x", envelope: { v: 2 } }] }), {
          status: 200,
        })
    ) as unknown as typeof fetch
    forwarder = new EnclaveForwarder({ internalApiKey: "s" })
    err = await forwarder.invoke("https://enclave-1.internal", REQUEST).catch((e) => e)
    expect(err).toBeInstanceOf(EnclaveForwardError)
  })

  it("wraps a network failure as EnclaveForwardError (no request echoed)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const forwarder = new EnclaveForwarder({ internalApiKey: "s" })

    const err = await forwarder.invoke("https://enclave-1.internal", REQUEST).catch((e) => e)
    expect(err).toBeInstanceOf(EnclaveForwardError)
    expect((err as EnclaveForwardError).status).toBeUndefined()
  })
})
