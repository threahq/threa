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
      return { ok: true, status: 204 } as Response
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
