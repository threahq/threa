import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"
import type { AgentSessionStep } from "@threa/types"
import * as e2eSessionModule from "@/stores/e2e-session-store"
import * as decryptCacheModule from "@/lib/crypto/decrypt-cache"
import { useDecryptedStepContent } from "./use-decrypted-step-content"

const WORKSPACE_ID = "ws_1"
const STREAM_ID = "stream_1"
const USER_ID = "member_1"

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
})
