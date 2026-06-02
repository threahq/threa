import { afterEach, describe, expect, it, mock } from "bun:test"
import { INTERNAL_API_KEY_HEADER, type EnclaveSessionAssignment } from "@threa/types"
import { EnclaveForwarder, EnclaveForwardError } from "./forwarder"

const ASSIGNMENT: EnclaveSessionAssignment = {
  sessionId: "session_1",
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

describe("EnclaveForwarder.assignSession", () => {
  it("POSTs to <instanceUrl>/sessions with the internal-api-key header and resolves on 202", async () => {
    const captured: { url?: string; headers?: Record<string, string>; body?: string } = {}
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      captured.url = String(url)
      captured.headers = (init?.headers ?? {}) as Record<string, string>
      captured.body = init?.body as string
      return new Response(null, { status: 202 })
    }) as unknown as typeof fetch

    const forwarder = new EnclaveForwarder({ internalApiKey: "shared-secret" })
    await forwarder.assignSession("https://enclave-1.internal/", ASSIGNMENT)

    expect(captured.url).toBe("https://enclave-1.internal/sessions")
    expect(captured.headers?.[INTERNAL_API_KEY_HEADER]).toBe("shared-secret")
    expect(JSON.parse(captured.body!)).toMatchObject({ sessionId: "session_1", streamId: "stream_1" })
  })

  it("throws EnclaveForwardError with the status when the enclave does not ack 202", async () => {
    // 200 (not 202) is a failed handoff — the enclave didn't take ownership.
    globalThis.fetch = mock(async () => new Response(null, { status: 200 })) as unknown as typeof fetch
    const forwarder = new EnclaveForwarder({ internalApiKey: "s" })

    const err = await forwarder.assignSession("https://enclave-1.internal", ASSIGNMENT).catch((e) => e)
    expect(err).toBeInstanceOf(EnclaveForwardError)
    expect((err as EnclaveForwardError).status).toBe(200)
  })

  it("throws EnclaveForwardError on a 5xx", async () => {
    globalThis.fetch = mock(async () => new Response(null, { status: 503 })) as unknown as typeof fetch
    const forwarder = new EnclaveForwarder({ internalApiKey: "s" })

    const err = await forwarder.assignSession("https://enclave-1.internal", ASSIGNMENT).catch((e) => e)
    expect(err).toBeInstanceOf(EnclaveForwardError)
    expect((err as EnclaveForwardError).status).toBe(503)
  })

  it("wraps a network failure as EnclaveForwardError (no assignment echoed)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const forwarder = new EnclaveForwarder({ internalApiKey: "s" })

    const err = await forwarder.assignSession("https://enclave-1.internal", ASSIGNMENT).catch((e) => e)
    expect(err).toBeInstanceOf(EnclaveForwardError)
    expect((err as EnclaveForwardError).status).toBeUndefined()
    // The wrapped error carries the cause but never echoes the assignment (which
    // references ciphertext + ids) — guards the no-plaintext-egress boundary.
    expect((err as EnclaveForwardError).message).toContain("ECONNREFUSED")
    expect((err as EnclaveForwardError).message).not.toContain(ASSIGNMENT.sessionId)
    expect((err as EnclaveForwardError).message).not.toContain(ASSIGNMENT.streamId)
  })
})

describe("EnclaveForwarder.cancelSession", () => {
  it("POSTs to <instanceUrl>/sessions/:id/cancel with the key and returns true on 202", async () => {
    const captured: { url?: string; method?: string; headers?: Record<string, string> } = {}
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      captured.url = String(url)
      captured.method = init?.method
      captured.headers = (init?.headers ?? {}) as Record<string, string>
      return new Response(null, { status: 202 })
    }) as unknown as typeof fetch

    const forwarder = new EnclaveForwarder({ internalApiKey: "shared-secret" })
    const ok = await forwarder.cancelSession("https://enclave-1.internal/", "session_1")

    expect(ok).toBe(true)
    expect(captured.url).toBe("https://enclave-1.internal/sessions/session_1/cancel")
    expect(captured.method).toBe("POST")
    expect(captured.headers?.[INTERNAL_API_KEY_HEADER]).toBe("shared-secret")
  })

  it("returns false (not throw) on a non-202 — the turn may have already finished", async () => {
    globalThis.fetch = mock(async () => new Response(null, { status: 404 })) as unknown as typeof fetch
    const forwarder = new EnclaveForwarder({ internalApiKey: "s" })
    expect(await forwarder.cancelSession("https://enclave-1.internal", "session_1")).toBe(false)
  })

  it("returns false (not throw) on a network failure", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const forwarder = new EnclaveForwarder({ internalApiKey: "s" })
    expect(await forwarder.cancelSession("https://enclave-1.internal", "session_1")).toBe(false)
  })
})
