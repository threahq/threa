import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { AgentSessionStep } from "@threa/types"
import * as e2eSessionModule from "@/stores/e2e-session-store"
import * as decryptCacheModule from "@/lib/crypto/decrypt-cache"
import * as streamStoreModule from "@/stores/stream-store"
import { useDecryptedStepContent } from "./use-decrypted-step-content"

const WORKSPACE_ID = "ws_1"
const STREAM_ID = "stream_1"
const USER_ID = "member_1"

/** Stub the stream row a thread/top-level resolves to. `undefined` = not yet
 *  hydrated (root unknown); `null` rootStreamId = top-level; a string = thread. */
function mockStreamRow(row: { rootStreamId: string | null } | undefined): void {
  vi.spyOn(streamStoreModule, "useStreamFromStore").mockReturnValue(
    row as unknown as ReturnType<typeof streamStoreModule.useStreamFromStore>
  )
}

function unlockedSession(): void {
  vi.spyOn(e2eSessionModule, "useE2eSession").mockReturnValue({
    status: "unlocked",
    privateKey: {} as CryptoKey,
    keyId: "key_1",
  } as unknown as ReturnType<typeof e2eSessionModule.useE2eSession>)
}

function makeStep(overrides: Partial<AgentSessionStep>): AgentSessionStep {
  return {
    id: "step_1",
    sessionId: "session_1",
    stepNumber: 1,
    stepType: "thinking",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe("useDecryptedStepContent", () => {
  it("returns plaintext content directly when the step has no ciphertext", () => {
    vi.spyOn(e2eSessionModule, "useE2eSession").mockReturnValue({
      status: "locked",
    } as unknown as ReturnType<typeof e2eSessionModule.useE2eSession>)

    const { result } = renderHook(() =>
      useDecryptedStepContent(makeStep({ content: "reasoning in the clear" }), WORKSPACE_ID, STREAM_ID, USER_ID)
    )

    expect(result.current).toEqual({ status: "plaintext", content: "reasoning in the clear" })
  })

  it("returns locked for a sealed step while the session is locked", () => {
    vi.spyOn(e2eSessionModule, "useE2eSession").mockReturnValue({
      status: "locked",
    } as unknown as ReturnType<typeof e2eSessionModule.useE2eSession>)

    const { result } = renderHook(() =>
      useDecryptedStepContent(
        makeStep({ contentCiphertext: "abc", contentEnvelope: { v: 2 } }),
        WORKSPACE_ID,
        STREAM_ID,
        USER_ID
      )
    )

    expect(result.current).toEqual({ status: "locked", content: undefined })
  })

  it("returns the decrypted content string from cache when available", () => {
    vi.spyOn(e2eSessionModule, "useE2eSession").mockReturnValue({
      status: "unlocked",
      privateKey: {} as CryptoKey,
      keyId: "key_1",
    } as unknown as ReturnType<typeof e2eSessionModule.useE2eSession>)
    vi.spyOn(decryptCacheModule, "getCachedDecryption").mockReturnValue({
      status: "decrypted",
      content: { contentMarkdown: "decrypted reasoning", contentJson: { type: "doc" } as never },
    })

    const { result } = renderHook(() =>
      useDecryptedStepContent(
        makeStep({ contentCiphertext: "abc", contentEnvelope: { v: 2, keyGeneration: 0, iv: "x", aad: "y" } }),
        WORKSPACE_ID,
        STREAM_ID,
        USER_ID
      )
    )

    expect(result.current).toEqual({ status: "decrypted", content: "decrypted reasoning" })
  })

  it("returns failed when the cached decrypt failed", () => {
    vi.spyOn(e2eSessionModule, "useE2eSession").mockReturnValue({
      status: "unlocked",
      privateKey: {} as CryptoKey,
      keyId: "key_1",
    } as unknown as ReturnType<typeof e2eSessionModule.useE2eSession>)
    vi.spyOn(decryptCacheModule, "getCachedDecryption").mockReturnValue({ status: "failed", content: null })

    const { result } = renderHook(() =>
      useDecryptedStepContent(
        makeStep({ contentCiphertext: "abc", contentEnvelope: { v: 2 } }),
        WORKSPACE_ID,
        STREAM_ID,
        USER_ID
      )
    )

    expect(result.current).toEqual({ status: "failed", content: undefined })
  })

  it("holds at pending without attempting a decrypt while the stream row is unhydrated", async () => {
    unlockedSession()
    mockStreamRow(undefined) // root unknown — resolving against the thread id would fail and cache forever
    vi.spyOn(decryptCacheModule, "getCachedDecryption").mockReturnValue(undefined)
    const requestSpy = vi.spyOn(decryptCacheModule, "requestDecryption").mockResolvedValue(undefined as never)

    const { result } = renderHook(() =>
      useDecryptedStepContent(
        makeStep({ contentCiphertext: "abc", contentEnvelope: { v: 2, keyGeneration: 1, iv: "x", aad: "y" } }),
        WORKSPACE_ID,
        STREAM_ID,
        USER_ID
      )
    )

    expect(result.current).toEqual({ status: "pending", content: undefined })
    // Critically: no doomed decrypt fired against the bare thread id.
    await new Promise((r) => setTimeout(r, 20))
    expect(requestSpy).not.toHaveBeenCalled()
  })

  it("resolves a thread step's key against the root once the row hydrates", async () => {
    unlockedSession()
    mockStreamRow({ rootStreamId: "stream_root" })
    vi.spyOn(decryptCacheModule, "getCachedDecryption").mockReturnValue(undefined)
    const requestSpy = vi.spyOn(decryptCacheModule, "requestDecryption").mockResolvedValue(undefined as never)

    renderHook(() =>
      useDecryptedStepContent(
        makeStep({ contentCiphertext: "abc", contentEnvelope: { v: 2, keyGeneration: 1, iv: "x", aad: "y" } }),
        WORKSPACE_ID,
        STREAM_ID,
        USER_ID
      )
    )

    await waitFor(() => expect(requestSpy).toHaveBeenCalledTimes(1))
    const [, , opts] = requestSpy.mock.calls[0]!
    expect(opts.streamId).toBe(STREAM_ID)
    expect(opts.rootStreamId).toBe("stream_root")
  })
})
