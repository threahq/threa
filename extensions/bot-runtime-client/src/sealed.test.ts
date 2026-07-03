import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Aes256Gcm, CipherSuite, HkdfSha256 } from "@hpke/core"
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519"
import {
  base64ToBytes,
  buildMessageAad,
  buildWrapAad,
  bytesToBase64,
  openMessageAsString,
  sealMessage,
  serializeSealedPayload,
} from "./crypto"
import {
  BikKeystore,
  openSealedTurnContext,
  parseSealedTurnContext,
  scrubSealedError,
  sealReply,
  sealStep,
  type SealedTurnContext,
  type SealingState,
} from "./sealed"

const STREAM_ID = "stream_01TEST"
const SENDER_ID = "bot_01TEST"

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sealed-test-"))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// The "owner side" of the ceremony, built on the noble KEM (Bun's native
// WebCrypto X25519 throws) — wire-identical to the browser's native wraps.
const ownerSuite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
})

async function ownerWrapSsk(
  ssk: Uint8Array,
  recipientPublicKeyBase64: string,
  aad: Uint8Array
): Promise<{ wrapEnc: string; wrapCt: string }> {
  const raw = base64ToBytes(recipientPublicKeyBase64)
  const recipient = await ownerSuite.kem.deserializePublicKey(
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
  )
  const sealed = await ownerSuite.seal({ recipientPublicKey: recipient }, ssk, aad)
  return { wrapEnc: bytesToBase64(new Uint8Array(sealed.enc)), wrapCt: bytesToBase64(new Uint8Array(sealed.ct)) }
}

async function ownerSealMessage(
  ssk: Uint8Array,
  keyGeneration: number,
  messageId: string,
  senderId: string,
  markdown: string
): Promise<{ ciphertext: string; envelope: { v: number; keyGeneration: number; iv: string; aad: string } }> {
  const sealed = await sealMessage({
    key: ssk,
    keyGeneration,
    payload: serializeSealedPayload(markdown),
    aad: buildMessageAad({ streamId: STREAM_ID, messageId, senderId }),
  })
  return { ciphertext: bytesToBase64(sealed.ciphertext), envelope: sealed.envelope }
}

function randomSsk(): Uint8Array {
  const key = new Uint8Array(32)
  crypto.getRandomValues(key)
  return key
}

describe("BikKeystore", () => {
  test("generates, persists 0600, and reloads the same key", async () => {
    const path = join(tempDir(), "bik.json")
    const store = new BikKeystore({ path, log: () => {} })
    const bik = await store.ensure()
    expect(bik).toBeDefined()
    expect(bik!.publicKeyId.startsWith("bik_")).toBe(true)
    expect(existsSync(path)).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(store.presenceFields()).toEqual({ publicKey: bik!.publicKeyBase64, publicKeyId: bik!.publicKeyId })

    const reloaded = await new BikKeystore({ path, log: () => {} }).ensure()
    expect(reloaded!.publicKeyId).toBe(bik!.publicKeyId)
    expect(reloaded!.publicKeyBase64).toBe(bik!.publicKeyBase64)
  })

  test("concurrent ensure() calls mint exactly one keypair", async () => {
    const path = join(tempDir(), "bik.json")
    const store = new BikKeystore({ path, log: () => {} })
    const [a, b] = await Promise.all([store.ensure(), store.ensure()])
    expect(a!.publicKeyId).toBe(b!.publicKeyId)
    const persisted = JSON.parse(readFileSync(path, "utf8")) as { publicKeyId: string }
    expect(persisted.publicKeyId).toBe(a!.publicKeyId)
  })

  test("a malformed file is replaced with a fresh key, loudly", async () => {
    const path = join(tempDir(), "bik.json")
    await Bun.write(path, "not json")
    const logs: string[] = []
    const bik = await new BikKeystore({ path, log: (m) => logs.push(m) }).ensure()
    expect(bik).toBeDefined()
    expect(logs.length).toBeGreaterThan(0)
  })

  test("presenceFields is empty before ensure()", () => {
    const store = new BikKeystore({ path: join(tempDir(), "bik.json"), log: () => {} })
    expect(store.presenceFields()).toEqual({})
  })
})

describe("openSealedTurnContext", () => {
  async function buildSealedClaim(bikStore: BikKeystore): Promise<{
    sealed: SealedTurnContext
    ssk: Uint8Array
    oldSsk: Uint8Array
  }> {
    const bik = (await bikStore.ensure())!
    const oldSsk = randomSsk()
    const ssk = randomSsk()
    const wrapFor = (generation: number, key: Uint8Array) =>
      ownerWrapSsk(
        key,
        bik.publicKeyBase64,
        buildWrapAad({ streamId: STREAM_ID, keyGeneration: generation, recipientKeyId: bik.publicKeyId })
      )
    const [oldWrap, currentWrap] = await Promise.all([wrapFor(1, oldSsk), wrapFor(2, ssk)])
    const prompt = await ownerSealMessage(ssk, 2, "msg_trigger", "usr_owner", "Do the thing, please")
    const oldHistory = await ownerSealMessage(oldSsk, 1, "msg_h1", "usr_owner", "earlier question")
    const newHistory = await ownerSealMessage(ssk, 2, "msg_h2", SENDER_ID, "earlier answer")
    return {
      ssk,
      oldSsk,
      sealed: {
        callbackToken: "cbtok_1",
        wraps: [
          { keyGeneration: 1, ...oldWrap },
          { keyGeneration: 2, ...currentWrap },
        ],
        history: [
          { ...oldHistory, role: "user", sequence: "10" },
          { ...newHistory, role: "assistant", sequence: "11" },
        ],
        prompt,
        reply: { keyGeneration: 2, senderId: SENDER_ID },
      },
    }
  }

  test("opens prompt + multi-generation history and yields a working SealingState", async () => {
    const store = new BikKeystore({ path: join(tempDir(), "bik.json"), log: () => {} })
    const { sealed, ssk } = await buildSealedClaim(store)
    const opened = await openSealedTurnContext({ sealed, identity: store.current!, streamId: STREAM_ID })

    expect(opened.promptMarkdown).toBe("Do the thing, please")
    expect(opened.history).toEqual([
      { role: "user", sequence: "10", contentMarkdown: "earlier question" },
      { role: "assistant", sequence: "11", contentMarkdown: "earlier answer" },
    ])
    expect(opened.sealing.callbackToken).toBe("cbtok_1")
    expect(opened.sealing.replyKeyGeneration).toBe(2)
    expect(bytesToBase64(opened.sealing.replySsk)).toBe(bytesToBase64(ssk))
  })

  test("history sealed under an ungranted generation is skipped, not fatal", async () => {
    const store = new BikKeystore({ path: join(tempDir(), "bik.json"), log: () => {} })
    const { sealed } = await buildSealedClaim(store)
    // Drop the generation-1 wrap: its history row becomes unopenable.
    sealed.wraps = sealed.wraps.filter((w) => w.keyGeneration !== 1)
    const opened = await openSealedTurnContext({ sealed, identity: store.current!, streamId: STREAM_ID })
    expect(opened.history).toEqual([{ role: "assistant", sequence: "11", contentMarkdown: "earlier answer" }])
  })

  test("a missing reply-generation wrap is fatal", async () => {
    const store = new BikKeystore({ path: join(tempDir(), "bik.json"), log: () => {} })
    const { sealed } = await buildSealedClaim(store)
    sealed.wraps = sealed.wraps.filter((w) => w.keyGeneration !== 2)
    await expect(openSealedTurnContext({ sealed, identity: store.current!, streamId: STREAM_ID })).rejects.toThrow(
      "no SSK wrap"
    )
  })

  test("a wrap bound to a different stream id does not open (AAD binding)", async () => {
    const store = new BikKeystore({ path: join(tempDir(), "bik.json"), log: () => {} })
    const { sealed } = await buildSealedClaim(store)
    await expect(
      openSealedTurnContext({ sealed, identity: store.current!, streamId: "stream_01OTHER" })
    ).rejects.toThrow()
  })
})

describe("sealReply / sealStep", () => {
  async function makeSealing(): Promise<{ sealing: SealingState; ssk: Uint8Array }> {
    const ssk = randomSsk()
    return {
      ssk,
      sealing: {
        streamId: STREAM_ID,
        replyKeyGeneration: 2,
        replySenderId: SENDER_ID,
        replySsk: ssk,
        callbackToken: "cbtok_1",
      },
    }
  }

  test("a sealed reply opens with the stream key under the message AAD", async () => {
    const { sealing, ssk } = await makeSealing()
    const body = await sealReply(sealing, "the answer is 42")
    expect(body.messageId.startsWith("msg_")).toBe(true)
    expect(body.envelope.keyGeneration).toBe(2)
    const openedAad = base64ToBytes(body.envelope.aad)
    expect(new TextDecoder().decode(openedAad)).toBe(`${STREAM_ID}|${body.messageId}|${SENDER_ID}`)
    const opened = await openMessageAsString({
      key: ssk,
      envelope: body.envelope,
      ciphertext: base64ToBytes(body.ciphertext),
    })
    expect(opened).toBe("the answer is 42")
  })

  test("a sealed step binds its step id into the messageId AAD slot", async () => {
    const { sealing, ssk } = await makeSealing()
    const frame = await sealStep(sealing, "tool_call", "$ rm -rf ./build\nexit 0", { durationMs: 12 })
    expect(frame.stepId.startsWith("step_")).toBe(true)
    expect(frame.durationMs).toBe(12)
    expect(new TextDecoder().decode(base64ToBytes(frame.envelope.aad))).toBe(
      `${STREAM_ID}|${frame.stepId}|${SENDER_ID}`
    )
    const opened = await openMessageAsString({
      key: ssk,
      envelope: frame.envelope,
      ciphertext: base64ToBytes(frame.ciphertext),
    })
    expect(opened).toBe("$ rm -rf ./build\nexit 0")
  })
})

describe("parseSealedTurnContext", () => {
  const valid = {
    callbackToken: "cb",
    wraps: [{ keyGeneration: 0, wrapEnc: "AA==", wrapCt: "AA==" }],
    history: [
      {
        ciphertext: "AA==",
        envelope: { v: 2, keyGeneration: 0, iv: "AA==", aad: "AA==" },
        role: "user",
        sequence: "1",
      },
    ],
    prompt: { ciphertext: "AA==", envelope: { v: 2, keyGeneration: 0, iv: "AA==", aad: "AA==" } },
    reply: { keyGeneration: 0, senderId: "bot_1" },
    trigger: { messageId: "msg_1", authorName: "Kris", authorType: "user", createdAt: "2026-07-03T00:00:00Z" },
  }

  test("accepts the full wire shape", () => {
    const parsed = parseSealedTurnContext(valid)
    expect(parsed).toBeDefined()
    expect(parsed!.trigger?.authorName).toBe("Kris")
    expect(parsed!.history).toHaveLength(1)
  })

  test("accepts a contextless claim (no history, no trigger)", () => {
    const { history: _h, trigger: _t, ...rest } = valid
    const parsed = parseSealedTurnContext(rest)
    expect(parsed).toBeDefined()
    expect(parsed!.history).toEqual([])
    expect(parsed!.trigger).toBeUndefined()
  })

  test.each([
    ["missing callbackToken", { ...valid, callbackToken: undefined }],
    ["malformed wrap", { ...valid, wraps: [{ keyGeneration: "1" }] }],
    ["malformed prompt envelope", { ...valid, prompt: { ciphertext: "AA==", envelope: { v: 2 } } }],
    ["missing reply", { ...valid, reply: undefined }],
    ["not an object", "nope"],
  ])("rejects %s", (_label, input) => {
    expect(parseSealedTurnContext(input)).toBeUndefined()
  })
})

describe("scrubSealedError", () => {
  test("keeps the class name, drops the message", () => {
    expect(scrubSealedError(new RangeError("secret content leaked into the error"))).toBe("RangeError")
    expect(scrubSealedError("raw string")).toBe("Error")
  })
})

describe("mintStreamKeyWraps (harness-created E2E scratchpads)", () => {
  test("each recipient's wrap unwraps to the same key under its own slot AAD", async () => {
    const owner = await ownerSuite.kem.generateKeyPair()
    const ownerPublicKey = bytesToBase64(new Uint8Array(await ownerSuite.kem.serializePublicKey(owner.publicKey)))
    const bikStore = new BikKeystore({ path: join(tempDir(), "bik.json"), log: () => {} })
    const bik = (await bikStore.ensure())!

    const { mintStreamKeyWraps } = await import("./sealed")
    const { unwrapStreamKey } = await import("./crypto")
    const { wraps } = await mintStreamKeyWraps({
      streamId: STREAM_ID,
      keyGeneration: 0,
      recipients: [
        { recipientKind: "user", recipientKeyId: "uik_owner", publicKeyBase64: ownerPublicKey },
        { recipientKind: "bot", recipientKeyId: bik.publicKeyId, publicKeyBase64: bik.publicKeyBase64 },
      ],
    })

    expect(wraps.map((w) => [w.recipientKind, w.recipientKeyId])).toEqual([
      ["user", "uik_owner"],
      ["bot", bik.publicKeyId],
    ])

    // The BIK slot opens with the BIK private key…
    const botWrap = wraps[1]!
    const recoveredByBot = await unwrapStreamKey({
      enc: base64ToBytes(botWrap.wrapEnc),
      ct: base64ToBytes(botWrap.wrapCt),
      recipientPrivateKey: bik.privateKey,
      aad: buildWrapAad({ streamId: STREAM_ID, keyGeneration: 0, recipientKeyId: bik.publicKeyId }),
    })
    // …and the owner slot opens with the owner key to the SAME stream key.
    const ownerWrap = wraps[0]!
    const openedByOwner = await ownerSuite.open(
      { recipientKey: owner.privateKey, enc: base64ToBytes(ownerWrap.wrapEnc) },
      base64ToBytes(ownerWrap.wrapCt),
      buildWrapAad({ streamId: STREAM_ID, keyGeneration: 0, recipientKeyId: "uik_owner" })
    )
    expect(bytesToBase64(new Uint8Array(openedByOwner))).toBe(bytesToBase64(recoveredByBot))
  })
})
