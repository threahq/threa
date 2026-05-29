import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  base64ToBytes,
  buildWrapAad,
  bytesToBase64,
  generateStreamKey,
  unwrapStreamKey,
  wrapStreamKey,
} from "@threa/crypto"
import { generateUIK, type UserIdentityKey } from "../keys"
import {
  clearStreamKeyCache,
  putStreamKey,
  rekeyStream,
  resolveCurrentStreamKey,
  resolveStreamKey,
} from "../stream-key-cache"
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

describe("rekeyStream", () => {
  it("wraps a fresh SSK to the owner + every actor recipient and POSTs the batch at the next generation", async () => {
    const owner = await generateUIK()
    const bot = await generateUIK()
    const roll = vi.spyOn(e2eKeyWrapsApi, "roll").mockResolvedValue(undefined)

    await rekeyStream({
      workspaceId: WS,
      streamId: STREAM,
      nextGeneration: 1,
      ownerKeyId: KEY_ID,
      ownerPublicKey: owner.publicKey,
      actorRecipients: [{ recipientKeyId: "bik_1", recipientKind: "bot", publicKey: bytesToBase64(bot.publicKey) }],
    })

    expect(roll).toHaveBeenCalledTimes(1)
    const [, , input] = roll.mock.calls[0]!
    expect(input.keyGeneration).toBe(1)
    expect(input.wraps.map((w) => `${w.recipientKind}:${w.recipientKeyId}`).sort()).toEqual([
      "bot:bik_1",
      "user:e2ek_alice",
    ])

    // Both wraps must open to the *same* fresh SSK, each under its own
    // (stream, generation, recipient) AAD — proving the roll is decryptable by
    // every recipient and bound so the server can't relocate a wrap row.
    const ownerWrap = input.wraps.find((w) => w.recipientKeyId === KEY_ID)!
    const botWrap = input.wraps.find((w) => w.recipientKeyId === "bik_1")!
    const ownerKey = await unwrapStreamKey({
      enc: base64ToBytes(ownerWrap.wrapEnc),
      ct: base64ToBytes(ownerWrap.wrapCt),
      recipientPrivateKey: owner.privateKey,
      aad: buildWrapAad({ streamId: STREAM, keyGeneration: 1, recipientKeyId: KEY_ID }),
    })
    const botKey = await unwrapStreamKey({
      enc: base64ToBytes(botWrap.wrapEnc),
      ct: base64ToBytes(botWrap.wrapCt),
      recipientPrivateKey: bot.privateKey,
      aad: buildWrapAad({ streamId: STREAM, keyGeneration: 1, recipientKeyId: "bik_1" }),
    })
    expect(ownerKey).toEqual(botKey)
  })

  it("seeds the cache with the new SSK so the next send uses it without a refetch", async () => {
    const owner = await generateUIK()
    vi.spyOn(e2eKeyWrapsApi, "roll").mockResolvedValue(undefined)
    const get = vi.spyOn(e2eKeyWrapsApi, "get")

    await rekeyStream({
      workspaceId: WS,
      streamId: STREAM,
      nextGeneration: 1,
      ownerKeyId: KEY_ID,
      ownerPublicKey: owner.publicKey,
      actorRecipients: [],
    })

    const current = await resolveCurrentStreamKey({
      workspaceId: WS,
      streamId: STREAM,
      recipientKeyId: KEY_ID,
      privateKey: owner.privateKey,
    })
    expect(current?.keyGeneration).toBe(1)
    expect(get).not.toHaveBeenCalled()
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
