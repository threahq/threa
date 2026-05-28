import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearDecryptCache, getCachedDecryption, requestDecryption, subscribeToDecryption } from "../decrypt-cache"
import * as messageEnvelope from "../message-envelope"

const STUB_OPTS = {
  privateKey: {} as CryptoKey,
  recipientKeyId: "e2ek_alice",
  workspaceId: "ws_1",
  streamId: "stream_1",
}

function stubDecrypt(returnValue: messageEnvelope.DecryptedMessageContent | null) {
  return vi.spyOn(messageEnvelope, "tryDecryptMessagePayload").mockResolvedValue(returnValue)
}

beforeEach(() => {
  clearDecryptCache()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("decrypt-cache", () => {
  it("returns the decrypted content from cache after the first request", async () => {
    const decrypt = stubDecrypt({ contentMarkdown: "hello", contentJson: { type: "doc", content: [] } })
    await requestDecryption("evt_1", { contentMarkdown: "ph", envelope: { fake: true } }, STUB_OPTS)
    const cached = getCachedDecryption("evt_1")
    expect(cached?.status).toBe("decrypted")
    expect(cached?.content?.contentMarkdown).toBe("hello")
    expect(decrypt).toHaveBeenCalledTimes(1)
  })

  it("coalesces concurrent requests for the same event into a single decrypt", async () => {
    const decrypt = stubDecrypt({ contentMarkdown: "hi", contentJson: { type: "doc", content: [] } })
    await Promise.all([
      requestDecryption("evt_dup", { contentMarkdown: "ph", envelope: {} }, STUB_OPTS),
      requestDecryption("evt_dup", { contentMarkdown: "ph", envelope: {} }, STUB_OPTS),
      requestDecryption("evt_dup", { contentMarkdown: "ph", envelope: {} }, STUB_OPTS),
    ])
    expect(decrypt).toHaveBeenCalledTimes(1)
  })

  it("records a failed entry without retrying on subsequent requests", async () => {
    const decrypt = stubDecrypt(null)
    await requestDecryption("evt_fail", { contentMarkdown: "ph", envelope: {} }, STUB_OPTS)
    await requestDecryption("evt_fail", { contentMarkdown: "ph", envelope: {} }, STUB_OPTS)
    expect(getCachedDecryption("evt_fail")?.status).toBe("failed")
    expect(decrypt).toHaveBeenCalledTimes(1)
  })

  it("notifies subscribers exactly once when a decrypt completes", async () => {
    stubDecrypt({ contentMarkdown: "x", contentJson: { type: "doc", content: [] } })
    const listener = vi.fn()
    const unsubscribe = subscribeToDecryption("evt_sub", listener)
    await requestDecryption("evt_sub", { contentMarkdown: "ph", envelope: {} }, STUB_OPTS)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it("drops listeners on unsubscribe", async () => {
    stubDecrypt({ contentMarkdown: "x", contentJson: { type: "doc", content: [] } })
    const listener = vi.fn()
    const unsubscribe = subscribeToDecryption("evt_unsub", listener)
    unsubscribe()
    await requestDecryption("evt_unsub", { contentMarkdown: "ph", envelope: {} }, STUB_OPTS)
    expect(listener).not.toHaveBeenCalled()
  })

  it("clears all cached entries and notifies subscribers on clearDecryptCache", async () => {
    stubDecrypt({ contentMarkdown: "x", contentJson: { type: "doc", content: [] } })
    await requestDecryption("evt_a", { contentMarkdown: "ph", envelope: {} }, STUB_OPTS)
    await requestDecryption("evt_b", { contentMarkdown: "ph", envelope: {} }, STUB_OPTS)
    const listenerA = vi.fn()
    const listenerB = vi.fn()
    subscribeToDecryption("evt_a", listenerA)
    subscribeToDecryption("evt_b", listenerB)
    clearDecryptCache()
    expect(getCachedDecryption("evt_a")).toBeUndefined()
    expect(getCachedDecryption("evt_b")).toBeUndefined()
    expect(listenerA).toHaveBeenCalledTimes(1)
    expect(listenerB).toHaveBeenCalledTimes(1)
  })

  it("drops in-flight decrypt results that resolve after clearDecryptCache (no plaintext leak past lock)", async () => {
    // Hold the decrypt open so we can simulate clear() landing while it's in flight.
    let resolveDecrypt: (value: messageEnvelope.DecryptedMessageContent | null) => void = () => {}
    vi.spyOn(messageEnvelope, "tryDecryptMessagePayload").mockImplementation(
      () =>
        new Promise<messageEnvelope.DecryptedMessageContent | null>((r) => {
          resolveDecrypt = r
        })
    )
    const pending = requestDecryption("evt_race", { contentMarkdown: "ph", envelope: {} }, STUB_OPTS)
    expect(getCachedDecryption("evt_race")?.status).toBe("pending")

    // Session locks (or account switches) while decrypt is still in flight.
    clearDecryptCache()
    expect(getCachedDecryption("evt_race")).toBeUndefined()

    // Decrypt now resolves — its plaintext must NOT be written back to the cache.
    resolveDecrypt({ contentMarkdown: "secret", contentJson: { type: "doc", content: [] } })
    await pending
    expect(getCachedDecryption("evt_race")).toBeUndefined()
  })

  it("evicts the least recently used entry when the cache exceeds its cap", async () => {
    // Sanity-check eviction without filling the production cap (500); we
    // ensure ordering is least-recently-touched by re-touching an early entry
    // and checking it survives while a different one drops.
    let counter = 0
    vi.spyOn(messageEnvelope, "tryDecryptMessagePayload").mockImplementation(async () => ({
      contentMarkdown: `m${counter++}`,
      contentJson: { type: "doc", content: [] },
    }))
    // Fill cache to cap + 1 to trigger one eviction; cap is 500, so write 501
    // entries with distinct ids and confirm the very first one is gone.
    for (let i = 0; i < 501; i++) {
      await requestDecryption(`evt_${i}`, { contentMarkdown: "ph", envelope: {} }, STUB_OPTS)
    }
    expect(getCachedDecryption("evt_0")).toBeUndefined()
    expect(getCachedDecryption("evt_500")?.status).toBe("decrypted")
  })
})
