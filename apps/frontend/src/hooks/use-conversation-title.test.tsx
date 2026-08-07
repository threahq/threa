import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import * as streamStore from "@/stores/stream-store"
import { clearStreamNameCache, primeStreamName, streamNameCacheKey } from "@/lib/crypto/stream-name-cache"
import { useConversationTitle } from "./use-conversation-title"

const workspaceId = "workspace_1"
const stream = {
  id: "stream_1",
  workspaceId,
  type: "scratchpad" as const,
  displayName: "Legacy plaintext",
  e2eEnabled: true,
  sealedNameCiphertext: "ciphertext_1",
}

afterEach(() => {
  clearStreamNameCache()
  vi.restoreAllMocks()
})

describe("useConversationTitle", () => {
  it("is null while an E2E title is locked, then synchronously reads the decrypted cache", () => {
    vi.spyOn(streamStore, "useStreamFromStore").mockReturnValue(stream as never)
    const key = streamNameCacheKey(workspaceId, stream.id, stream.sealedNameCiphertext)
    const reader = renderHook(() =>
      useConversationTitle(workspaceId, { streamId: stream.id, topicSummary: "Persisted topic" })
    )

    expect(reader.result.current).toBeNull()
    act(() => primeStreamName(key, "Decrypted title"))
    expect(reader.result.current).toBe("Decrypted title")
    reader.unmount()
  })

  it("does not rerender when another stream title changes", () => {
    vi.spyOn(streamStore, "useStreamFromStore").mockReturnValue(stream as never)
    let renders = 0
    const reader = renderHook(() => {
      renders += 1
      return useConversationTitle(workspaceId, { streamId: stream.id, topicSummary: null })
    })
    const before = renders

    act(() => primeStreamName(streamNameCacheKey(workspaceId, "stream_other", "ciphertext_2"), "Other title"))

    expect(renders).toBe(before)
    reader.unmount()
  })
})
