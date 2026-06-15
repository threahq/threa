import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  applyDecryptedNameOverlay,
  clearStreamNameCache,
  getCachedStreamName,
  requestStreamName,
  streamNameCacheKey,
  subscribeStreamNameCache,
} from "../stream-name-cache"
import * as messageEnvelope from "../message-envelope"
import { resolveStreamName, streamLabel } from "@/lib/streams"
import { StreamTypes } from "@threa/types"

const STUB_OPTS = {
  privateKey: {} as CryptoKey,
  recipientKeyId: "e2ek_alice",
  workspaceId: "ws_1",
  streamId: "stream_1",
}

const PAYLOAD = { ciphertext: "ct_1", envelope: { v: 2 } }
const KEY = streamNameCacheKey("ws_1", "stream_1", "ct_1")

function stubOpen(returnValue: string | null) {
  return vi.spyOn(messageEnvelope, "tryOpenStreamName").mockResolvedValue(returnValue)
}

beforeEach(() => {
  clearStreamNameCache()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("stream-name-cache", () => {
  it("returns the decrypted name from cache after the first request", async () => {
    const open = stubOpen("Quarterly Planning")
    await requestStreamName(KEY, PAYLOAD, STUB_OPTS)
    expect(getCachedStreamName(KEY)).toBe("Quarterly Planning")
    expect(open).toHaveBeenCalledTimes(1)
  })

  it("coalesces concurrent requests for the same key into a single decrypt", async () => {
    const open = stubOpen("Once")
    await Promise.all([
      requestStreamName(KEY, PAYLOAD, STUB_OPTS),
      requestStreamName(KEY, PAYLOAD, STUB_OPTS),
      requestStreamName(KEY, PAYLOAD, STUB_OPTS),
    ])
    expect(open).toHaveBeenCalledTimes(1)
  })

  it("does not cache a failed/locked decrypt, so a later request retries", async () => {
    const open = stubOpen(null)
    await requestStreamName(KEY, PAYLOAD, STUB_OPTS)
    expect(getCachedStreamName(KEY)).toBeNull()
    await requestStreamName(KEY, PAYLOAD, STUB_OPTS)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it("notifies subscribers when a name lands", async () => {
    stubOpen("Heard")
    const listener = vi.fn()
    const unsubscribe = subscribeStreamNameCache(listener)
    await requestStreamName(KEY, PAYLOAD, STUB_OPTS)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it("drops listeners on unsubscribe", async () => {
    stubOpen("Silent")
    const listener = vi.fn()
    const unsubscribe = subscribeStreamNameCache(listener)
    unsubscribe()
    await requestStreamName(KEY, PAYLOAD, STUB_OPTS)
    expect(listener).not.toHaveBeenCalled()
  })

  it("clears all cached names and notifies subscribers on clearStreamNameCache", async () => {
    stubOpen("Gone")
    await requestStreamName(KEY, PAYLOAD, STUB_OPTS)
    const listener = vi.fn()
    subscribeStreamNameCache(listener)
    clearStreamNameCache()
    expect(getCachedStreamName(KEY)).toBeNull()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("drops in-flight decrypt results that resolve after clearStreamNameCache (no plaintext leak past lock)", async () => {
    let resolveOpen: (value: string | null) => void = () => {}
    vi.spyOn(messageEnvelope, "tryOpenStreamName").mockImplementation(
      () =>
        new Promise<string | null>((r) => {
          resolveOpen = r
        })
    )
    const pending = requestStreamName(KEY, PAYLOAD, STUB_OPTS)

    // Session locks (or account switches) while the decrypt is still in flight.
    clearStreamNameCache()

    // The decrypt now resolves — its plaintext must NOT be written back.
    resolveOpen("Top Secret")
    await pending
    expect(getCachedStreamName(KEY)).toBeNull()
  })
})

describe("applyDecryptedNameOverlay", () => {
  type Row = {
    id: string
    displayName: string | null
    e2eEnabled?: boolean
    sealedNameCiphertext?: string | null
  }

  const sealedRow: Row = {
    id: "stream_1",
    displayName: "New scratchpad",
    e2eEnabled: true,
    sealedNameCiphertext: "ct_1",
  }

  it("overlays the decrypted name onto displayName for a sealed E2E stream", async () => {
    stubOpen("Budget 2026")
    await requestStreamName(KEY, PAYLOAD, STUB_OPTS)

    const [overlaid] = applyDecryptedNameOverlay("ws_1", [sealedRow])
    expect(overlaid.displayName).toBe("Budget 2026")
    // The input row is not mutated — only a fresh copy carries the plaintext.
    expect(sealedRow.displayName).toBe("New scratchpad")
  })

  it("keeps the plaintext placeholder when the name is not decrypted (locked)", () => {
    const [overlaid] = applyDecryptedNameOverlay("ws_1", [sealedRow])
    expect(overlaid.displayName).toBe("New scratchpad")
  })

  it("returns the same array reference when nothing is overlaid (memo-stable)", () => {
    const rows: Row[] = [
      { id: "plain", displayName: "Plaintext stream" },
      { id: "no-seal", displayName: "E2E no name", e2eEnabled: true, sealedNameCiphertext: null },
    ]
    expect(applyDecryptedNameOverlay("ws_1", rows)).toBe(rows)
  })

  it("does not overlay a name decrypted for a different workspace", async () => {
    stubOpen("Other WS")
    await requestStreamName(KEY, PAYLOAD, STUB_OPTS)
    const [overlaid] = applyDecryptedNameOverlay("ws_other", [sealedRow])
    expect(overlaid.displayName).toBe("New scratchpad")
  })

  // The whole point of the overlay: the canonical resolver reflects the
  // decrypted name with no per-surface plumbing, and falls back to the
  // placeholder when locked.
  it("makes streamLabel/resolveStreamName return the decrypted name once unlocked", async () => {
    // The enclave auto-title never writes plaintext, so `displayName` is null and
    // the locked-state resolver falls through to the real placeholder.
    const scratchpad = {
      id: "stream_1",
      displayName: null,
      type: StreamTypes.SCRATCHPAD,
      slug: null,
      e2eEnabled: true,
      sealedNameCiphertext: "ct_1",
    }

    // Locked: the resolver shows the context placeholder, not the seal.
    expect(streamLabel(applyDecryptedNameOverlay("ws_1", [scratchpad])[0], "sidebar")).toBe("New scratchpad")

    stubOpen("Launch Plan")
    await requestStreamName(KEY, PAYLOAD, STUB_OPTS)

    const [overlaid] = applyDecryptedNameOverlay("ws_1", [scratchpad])
    expect(streamLabel(overlaid, "sidebar")).toBe("Launch Plan")
    expect(resolveStreamName("stream_1", { streams: [overlaid], users: [], dmPeers: [] }, "sidebar")).toBe(
      "Launch Plan"
    )
  })
})
