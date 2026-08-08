import { afterEach, describe, expect, it, vi } from "vitest"
import { ENCLAVE_CALLBACK_TOKEN_HEADER, INTERNAL_API_KEY_HEADER } from "@threa/types"
import { createBackendCallbacks } from "./backend-callbacks"
import type { EnclaveConfig } from "../config"

const config = {
  backendBaseUrl: "http://backend.test",
  internalApiKey: "internal-secret",
} as EnclaveConfig

function stubFetch() {
  const calls: { url: string; headers: Record<string, string> }[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> })
      return { ok: true, status: 200, json: async () => ({ abort: false }) } as Response
    })
  )
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe("createBackendCallbacks callback-token binding (Phase 2.4b)", () => {
  it("echoes the assignment's token on callbacks alongside the internal key", async () => {
    const calls = stubFetch()
    const callbacks = createBackendCallbacks(config, "cbtok_1")

    await callbacks.heartbeat("session_1")

    expect(calls[0]!.url).toBe("http://backend.test/internal/enclave-runtimes/sessions/session_1/heartbeat")
    expect(calls[0]!.headers).toMatchObject({
      [INTERNAL_API_KEY_HEADER]: "internal-secret",
      [ENCLAVE_CALLBACK_TOKEN_HEADER]: "cbtok_1",
    })
  })

  it("omits the header entirely for a pre-binding assignment (no token)", async () => {
    const calls = stubFetch()
    const callbacks = createBackendCallbacks(config)

    await callbacks.heartbeat("session_1")

    expect(ENCLAVE_CALLBACK_TOKEN_HEADER in calls[0]!.headers).toBe(false)
  })
})

describe("createBackendCallbacks naming decision", () => {
  it("posts metadata and sealed bytes to the session-bound endpoint", async () => {
    let call: { url: string; body?: string } | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        call = { url, body: init.body as string }
        return { ok: true, status: 204 } as Response
      })
    )
    const decision = {
      action: "keep" as const,
      confidence: 0.8,
      observedStateRevision: 4,
      observedTitleRevision: 2,
      observedMessageCount: 3,
      observedCheckpoint: 3 as const,
    }
    await createBackendCallbacks(config, "cbtok_1").namingDecision("session_1", decision)
    expect(call?.url).toBe("http://backend.test/internal/enclave-runtimes/sessions/session_1/naming-decision")
    expect(JSON.parse(call!.body!)).toEqual(decision)
  })
})

describe("createBackendCallbacks.pollMessages (interjection pull)", () => {
  it("GETs the after-cursor URL and returns the sealed rows", async () => {
    const row = {
      messageId: "msg_a",
      sequence: "42",
      authorId: "usr_owner",
      authorType: "user",
      authorName: "Owner",
      createdAt: "2026-06-13T10:00:00.000Z",
      ciphertext: "Y3Q=",
      envelope: { v: 2, keyGeneration: 0, iv: "aXY=", aad: "YWFk" },
    }
    const calls: { url: string; method?: string }[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method })
        return { ok: true, status: 200, json: async () => ({ messages: [row] }) } as Response
      })
    )
    const callbacks = createBackendCallbacks(config, "cbtok_1")

    const messages = await callbacks.pollMessages("session_1", 7n)

    expect(calls[0]!.method).toBe("GET")
    expect(calls[0]!.url).toBe("http://backend.test/internal/enclave-runtimes/sessions/session_1/messages?after=7")
    expect(messages).toEqual([row])
  })

  it("throws on a malformed body so a protocol fault never reads as 'no messages'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response)
    )
    const callbacks = createBackendCallbacks(config, "cbtok_1")

    await expect(callbacks.pollMessages("session_1", 0n)).rejects.toThrow(/invalid body/)
  })
})
