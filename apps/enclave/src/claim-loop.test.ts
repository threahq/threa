import { afterEach, describe, expect, it, vi } from "vitest"
import { INTERNAL_API_KEY_HEADER } from "@threahq/types"
import type { EnclaveConfig } from "./config"
import type { EnclaveKeyPair } from "./keystore"
import { claimOnce, startClaimLoop } from "./claim-loop"

const config: EnclaveConfig = {
  port: 3011,
  backendBaseUrl: "https://backend.internal",
  internalApiKey: "enclave-secret",
  heartbeatIntervalMs: 30_000,
  claimPollIntervalMs: 1_500,
  claimLongPollMs: 25_000,
  maxConcurrentSessions: 8,
  sourceCommitSha: "unknown",
  buildHash: "unknown",
  openRouterApiKey: "sk-test",
  openRouterBaseUrl: "https://openrouter.ai/api/v1",
}

const keyPair = {
  instanceId: "enci_01",
  keyId: "eik_01",
  publicKeyBase64: "cHVibGlj",
  publicKey: new Uint8Array([1, 2, 3]),
  privateKey: {} as CryptoKey,
} satisfies EnclaveKeyPair

const ASSIGNMENT = {
  sessionId: "session_test",
  streamId: "stream_x",
  callbackToken: "cbtok_1",
  wraps: [{ keyGeneration: 0, wrapEnc: "ZW5j", wrapCt: "Y3Q=" }],
  history: [],
  prompt: { ciphertext: "Y3Q=", envelope: { v: 2, keyGeneration: 0, iv: "aXY=", aad: "YWFk" } },
  system: "You are Ariadne.",
  model: "anthropic/claude-sonnet-4.6",
  reply: { keyGeneration: 0, senderId: "persona_ariadne" },
}

interface Captured {
  url: string | null
  headers: Record<string, string> | null
  body: unknown
}

const originalFetch = globalThis.fetch

function stubFetch(captured: Captured, status: number, body?: unknown): void {
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    captured.url = typeof url === "string" ? url : url.toString()
    captured.headers = (init?.headers ?? {}) as Record<string, string>
    captured.body = init?.body ? JSON.parse(init.body as string) : null
    return new Response(body === undefined ? null : JSON.stringify(body), { status })
  }) as unknown as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("claimOnce", () => {
  it("polls the claim endpoint with the EIK key id on the enclave credential", async () => {
    const captured: Captured = { url: null, headers: null, body: null }
    stubFetch(captured, 204)
    const runSession = vi.fn(async () => {})

    const result = await claimOnce({ config, keyPair, inFlight: new Set(), runSession })

    expect(captured.url).toBe("https://backend.internal/internal/enclave-runtimes/claims")
    expect(captured.headers?.[INTERNAL_API_KEY_HEADER]).toBe("enclave-secret")
    // Carries the long-poll budget so the backend parks the poll on the nudge.
    expect(captured.body).toEqual({ keyId: "eik_01", waitMs: 25_000 })
    expect(result.claimed).toBe(false)
    expect(runSession).not.toHaveBeenCalled()
  })

  it("runs a won turn detached, tracking it in inFlight until it settles", async () => {
    stubFetch({ url: null, headers: null, body: null }, 200, { assignment: ASSIGNMENT })
    const inFlight = new Set<string>()
    let resolveRun!: () => void
    const seen: unknown[] = []
    const runSession = vi.fn((assignment: unknown) => {
      seen.push(assignment)
      return new Promise<void>((resolve) => {
        resolveRun = resolve
      })
    })

    const result = await claimOnce({ config, keyPair, inFlight, runSession })

    expect(result.claimed).toBe(true)
    expect(runSession).toHaveBeenCalledTimes(1)
    expect(seen[0]).toMatchObject({ sessionId: "session_test", callbackToken: "cbtok_1" })
    expect(inFlight.has("session_test")).toBe(true) // running detached

    resolveRun()
    await vi.waitFor(() => expect(inFlight.size).toBe(0))
  })

  it("releases inFlight even when the detached run rejects (no permanently-pinned session)", async () => {
    stubFetch({ url: null, headers: null, body: null }, 200, { assignment: ASSIGNMENT })
    const inFlight = new Set<string>()
    const runSession = vi.fn(async () => {
      throw new Error("turn exploded")
    })

    await claimOnce({ config, keyPair, inFlight, runSession })

    await vi.waitFor(() => expect(inFlight.size).toBe(0))
  })

  it("does not start a second loop for a session already in flight", async () => {
    stubFetch({ url: null, headers: null, body: null }, 200, { assignment: ASSIGNMENT })
    const runSession = vi.fn(async () => {})

    const result = await claimOnce({ config, keyPair, inFlight: new Set(["session_test"]), runSession })

    expect(result.claimed).toBe(true)
    expect(runSession).not.toHaveBeenCalled()
  })

  it("treats an invalid assignment as no work, never running it (the claim TTL recycles the turn)", async () => {
    stubFetch({ url: null, headers: null, body: null }, 200, { assignment: { not: "an assignment" } })
    const runSession = vi.fn(async () => {})

    const result = await claimOnce({ config, keyPair, inFlight: new Set(), runSession })

    expect(result.claimed).toBe(false)
    expect(runSession).not.toHaveBeenCalled()
  })

  it("does not claim at the per-instance concurrency ceiling, leaving the turn for a free slot", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const runSession = vi.fn(async () => {})

    const result = await claimOnce({
      config: { ...config, maxConcurrentSessions: 2 },
      keyPair,
      inFlight: new Set(["session_a", "session_b"]),
      runSession,
    })

    expect(result.claimed).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(runSession).not.toHaveBeenCalled()
  })

  it("treats a tombstoned registration (404) as no work, leaving re-registration to the heartbeat", async () => {
    stubFetch({ url: null, headers: null, body: null }, 404)
    const runSession = vi.fn(async () => {})

    const result = await claimOnce({ config, keyPair, inFlight: new Set(), runSession })

    expect(result.claimed).toBe(false)
    expect(runSession).not.toHaveBeenCalled()
  })
})

describe("startClaimLoop", () => {
  it("at capacity, idles for the poll interval instead of busy-spinning, then resumes when a slot frees", async () => {
    vi.useFakeTimers()
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const inFlight = new Set(["session_a", "session_b"])

    const loop = startClaimLoop({
      config: { ...config, maxConcurrentSessions: 2 },
      keyPair,
      inFlight,
      runSession: vi.fn(async () => {}),
    })

    // The first tick runs on start; at capacity it must not poll, and must not
    // hot-loop — advancing nearly a full interval still triggers no claim.
    await vi.advanceTimersByTimeAsync(config.claimPollIntervalMs - 1)
    expect(fetchSpy).not.toHaveBeenCalled()

    // A turn settles; the next idle tick finds a free slot and claims.
    inFlight.delete("session_a")
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    loop.stop()
  })

  it("re-polls immediately after a long-poll the backend held open, staying parked on the nudge", async () => {
    vi.useFakeTimers()
    let resolveFetch!: (res: Response) => void
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        })
    )
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const loop = startClaimLoop({ config, keyPair, inFlight: new Set(), runSession: vi.fn(async () => {}) })

    // First poll is in flight; the backend holds it open past the idle interval.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(config.claimPollIntervalMs + 100)
    resolveFetch(new Response(null, { status: 204 }))

    // The held poll already covered the spacing, so the next one fires now — no
    // extra idle wait — rather than sitting out another full interval.
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    loop.stop()
  })
})
