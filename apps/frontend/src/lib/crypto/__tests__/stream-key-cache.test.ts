import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildWrapAad, bytesToBase64, generateStreamKey, wrapStreamKey } from "@threa/crypto"
import { generateUIK, type UserIdentityKey } from "../keys"
import { clearStreamKeyCache, putStreamKey, resolveCurrentStreamKey, resolveStreamKey } from "../stream-key-cache"
import { e2eKeyWrapsApi } from "@/api/e2e-key-wraps"

const WS = "ws_1"
const STREAM = "stream_01"
const KEY_ID = "e2ek_alice"

async function stubWrap(uik: UserIdentityKey, ssk: Uint8Array, currentKeyGeneration = 0) {
  const wrap = await wrapStreamKey({
    key: ssk,
    recipientPublicKey: uik.publicKey,
    aad: buildWrapAad({ streamId: STREAM, keyGeneration: 0, recipientKeyId: KEY_ID }),
  })
  return vi.spyOn(e2eKeyWrapsApi, "get").mockResolvedValue({
    currentKeyGeneration,
    wraps: [
      {
        keyGeneration: 0,
        recipientKeyId: KEY_ID,
        recipientKind: "user",
        wrapEnc: bytesToBase64(wrap.enc),
        wrapCt: bytesToBase64(wrap.ct),
      },
    ],
  })
}

beforeEach(() => {
  clearStreamKeyCache()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("resolveStreamKey", () => {
  it("fetches, unwraps the recipient's wrap, and caches (one fetch for repeats)", async () => {
    const uik = await generateUIK()
    const ssk = generateStreamKey()
    const spy = await stubWrap(uik, ssk)

    const first = await resolveStreamKey({
      workspaceId: WS,
      streamId: STREAM,
      keyGeneration: 0,
      recipientKeyId: KEY_ID,
      privateKey: uik.privateKey,
    })
    const second = await resolveStreamKey({
      workspaceId: WS,
      streamId: STREAM,
      keyGeneration: 0,
      recipientKeyId: KEY_ID,
      privateKey: uik.privateKey,
    })

    expect(first).toEqual(ssk)
    expect(second).toEqual(ssk)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("de-duplicates concurrent resolves of the same slot into one fetch", async () => {
    const uik = await generateUIK()
    const ssk = generateStreamKey()
    const spy = await stubWrap(uik, ssk)

    const [a, b] = await Promise.all([
      resolveStreamKey({
        workspaceId: WS,
        streamId: STREAM,
        keyGeneration: 0,
        recipientKeyId: KEY_ID,
        privateKey: uik.privateKey,
      }),
      resolveStreamKey({
        workspaceId: WS,
        streamId: STREAM,
        keyGeneration: 0,
        recipientKeyId: KEY_ID,
        privateKey: uik.privateKey,
      }),
    ])

    expect(a).toEqual(ssk)
    expect(b).toEqual(ssk)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("returns null when no wrap matches the recipient", async () => {
    const uik = await generateUIK()
    const ssk = generateStreamKey()
    await stubWrap(uik, ssk)

    const result = await resolveStreamKey({
      workspaceId: WS,
      streamId: STREAM,
      keyGeneration: 0,
      recipientKeyId: "e2ek_not_me",
      privateKey: uik.privateKey,
    })
    expect(result).toBeNull()
  })
})

describe("putStreamKey + resolveCurrentStreamKey", () => {
  it("serves a seeded current-generation key without hitting the network", async () => {
    const uik = await generateUIK()
    const ssk = generateStreamKey()
    const spy = vi.spyOn(e2eKeyWrapsApi, "get")

    putStreamKey(WS, STREAM, 0, ssk)
    const current = await resolveCurrentStreamKey({
      workspaceId: WS,
      streamId: STREAM,
      recipientKeyId: KEY_ID,
      privateKey: uik.privateKey,
    })

    expect(current).toEqual({ keyGeneration: 0, key: ssk })
    expect(spy).not.toHaveBeenCalled()
  })

  it("fetches the current generation when nothing is seeded", async () => {
    const uik = await generateUIK()
    const ssk = generateStreamKey()
    await stubWrap(uik, ssk, 0)

    const current = await resolveCurrentStreamKey({
      workspaceId: WS,
      streamId: STREAM,
      recipientKeyId: KEY_ID,
      privateKey: uik.privateKey,
    })
    expect(current).toEqual({ keyGeneration: 0, key: ssk })
  })

  it("drops cached keys on clear", async () => {
    const uik = await generateUIK()
    const ssk = generateStreamKey()
    const spy = vi.spyOn(e2eKeyWrapsApi, "get")

    putStreamKey(WS, STREAM, 0, ssk)
    clearStreamKeyCache()
    spy.mockResolvedValue({ currentKeyGeneration: 0, wraps: [] })

    const current = await resolveCurrentStreamKey({
      workspaceId: WS,
      streamId: STREAM,
      recipientKeyId: KEY_ID,
      privateKey: uik.privateKey,
    })
    // Cache was cleared, so it must fetch — and the empty wrap set yields null.
    expect(spy).toHaveBeenCalledTimes(1)
    expect(current).toBeNull()
  })
})
