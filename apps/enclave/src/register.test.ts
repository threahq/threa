import { afterEach, describe, expect, it, mock } from "bun:test"
import { INTERNAL_API_KEY_HEADER } from "@threa/types"
import type { EnclaveConfig } from "./config"
import type { EnclaveKeyPair } from "./keystore"
import { registerWithBackend, revokeWithBackend } from "./register"

const config: EnclaveConfig = {
  port: 3011,
  selfUrl: "https://enclave.internal",
  backendBaseUrl: "https://backend.internal",
  internalApiKey: "shared-secret",
  heartbeatIntervalMs: 30_000,
  sourceCommitSha: "unknown",
  buildHash: "unknown",
}

const keyPair = {
  instanceId: "enci_01",
  keyId: "eik_01",
  publicKeyBase64: "cHVibGlj",
  publicKey: new Uint8Array([1, 2, 3]),
  privateKey: {} as CryptoKey,
} satisfies EnclaveKeyPair

interface Captured {
  url: string | null
  headers: Record<string, string> | null
}

const originalFetch = globalThis.fetch

function stubFetch(captured: Captured, status = 201): void {
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    captured.url = typeof url === "string" ? url : url.toString()
    captured.headers = (init?.headers ?? {}) as Record<string, string>
    return new Response(null, { status })
  }) as unknown as typeof fetch
}

describe("registerWithBackend", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    mock.restore()
  })

  it("authenticates with the X-Internal-Api-Key header, not Authorization (the backend internalAuth contract)", async () => {
    const captured: Captured = { url: null, headers: null }
    stubFetch(captured)

    await registerWithBackend(config, keyPair)

    expect(captured.url).toBe("https://backend.internal/internal/enclave-runtimes/register-key")
    expect(captured.headers?.[INTERNAL_API_KEY_HEADER]).toBe("shared-secret")
    expect(captured.headers?.Authorization).toBeUndefined()
  })

  it("throws when the backend rejects registration", async () => {
    const captured: Captured = { url: null, headers: null }
    stubFetch(captured, 401)

    await expect(registerWithBackend(config, keyPair)).rejects.toThrow(/registration failed \(401\)/)
  })
})

describe("revokeWithBackend", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    mock.restore()
  })

  it("authenticates with the X-Internal-Api-Key header", async () => {
    const captured: Captured = { url: null, headers: null }
    stubFetch(captured, 204)

    await revokeWithBackend(config, keyPair)

    expect(captured.url).toBe("https://backend.internal/internal/enclave-runtimes/revoke")
    expect(captured.headers?.[INTERNAL_API_KEY_HEADER]).toBe("shared-secret")
    expect(captured.headers?.Authorization).toBeUndefined()
  })
})
