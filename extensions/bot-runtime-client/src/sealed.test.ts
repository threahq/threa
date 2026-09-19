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
  type SealedPayloadExtras,
} from "./crypto"
import { E2eKeyring, FileKeyStore, readLegacyBikFile, type E2eKeyRecord } from "./keyring"
import {
  BotKeyring,
  mintE2eKeyRecord,
  openSealedDecisionNote,
  openSealedTurnContext,
  parseSealedTurnContext,
  scrubSealedError,
  sealDecision,
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
  markdown: string,
  extras?: SealedPayloadExtras
): Promise<{ ciphertext: string; envelope: { v: number; keyGeneration: number; iv: string; aad: string } }> {
  const sealed = await sealMessage({
    key: ssk,
    keyGeneration,
    payload: serializeSealedPayload(markdown, extras),
    aad: buildMessageAad({ streamId: STREAM_ID, messageId, senderId }),
  })
  return { ciphertext: bytesToBase64(sealed.ciphertext), envelope: sealed.envelope }
}

function randomSsk(): Uint8Array {
  const key = new Uint8Array(32)
  crypto.getRandomValues(key)
  return key
}

const ACCOUNT = "host-test"

function keyring(dir: string, legacy?: () => E2eKeyRecord | undefined): BotKeyring {
  return new BotKeyring({
    keyring: () =>
      new E2eKeyring({
        store: new FileKeyStore({ dir }),
        account: ACCOUNT,
        mint: mintE2eKeyRecord,
        log: () => {},
        ...(legacy ? { legacy } : {}),
      }),
    log: () => {},
  })
}

describe("BotKeyring", () => {
  test("mints, persists 0600, and reloads the same key", async () => {
    const dir = tempDir()
    const store = keyring(dir)
    const [key] = await store.ensure()
    expect(key).toBeDefined()
    expect(key!.publicKeyId.startsWith("bik_")).toBe(true)
    const path = join(dir, `${ACCOUNT}.json`)
    expect(existsSync(path)).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(store.presenceFields()).toEqual({
      e2eKeys: [{ keyId: key!.publicKeyId, publicKey: key!.publicKeyBase64 }],
      publicKey: key!.publicKeyBase64,
      publicKeyId: key!.publicKeyId,
    })

    const [reloaded] = await keyring(dir).ensure()
    expect(reloaded!.publicKeyId).toBe(key!.publicKeyId)
    expect(reloaded!.publicKeyBase64).toBe(key!.publicKeyBase64)
  })

  test("concurrent ensure() calls mint exactly one keypair", async () => {
    const dir = tempDir()
    const store = keyring(dir)
    const [a, b] = await Promise.all([store.ensure(), store.ensure()])
    expect(a[0]!.publicKeyId).toBe(b[0]!.publicKeyId)
    const persisted = JSON.parse(readFileSync(join(dir, `${ACCOUNT}.json`), "utf8")) as { keyId: string }
    expect(persisted.keyId).toBe(a[0]!.publicKeyId)
  })

  test("two keyrings racing on one account end up with the key that reached disk", async () => {
    const dir = tempDir()
    const [a, b] = await Promise.all([keyring(dir).ensure(), keyring(dir).ensure()])
    const persisted = JSON.parse(readFileSync(join(dir, `${ACCOUNT}.json`), "utf8")) as { keyId: string }
    expect(a[0]!.publicKeyId).toBe(persisted.keyId)
    expect(b[0]!.publicKeyId).toBe(persisted.keyId)
  })

  test("two runtimes sharing an account share one key, so the owner wraps to one recipient", async () => {
    const dir = tempDir()
    const [first] = await keyring(dir).ensure()
    const [second] = await keyring(dir).ensure()
    expect(second!.publicKeyId).toBe(first!.publicKeyId)
    expect(second!.publicKeyBase64).toBe(first!.publicKeyBase64)
  })

  test("a single-key BIK file from before keyrings is adopted, keeping its id", async () => {
    const dir = tempDir()
    const legacyPath = join(tempDir(), "bik.json")
    const minted = await mintE2eKeyRecord()
    await Bun.write(
      legacyPath,
      JSON.stringify({ publicKeyId: minted.keyId, publicKey: minted.publicKey, privateKey: minted.privateKey })
    )
    const [adopted] = await keyring(dir, () => readLegacyBikFile(legacyPath)).ensure()
    expect(adopted!.publicKeyId).toBe(minted.keyId)
    const persisted = JSON.parse(readFileSync(join(dir, `${ACCOUNT}.json`), "utf8")) as { keyId: string }
    expect(persisted.keyId).toBe(minted.keyId)
  })

  test("an unreadable stored key fails loudly instead of being overwritten", async () => {
    const dir = tempDir()
    const path = join(dir, `${ACCOUNT}.json`)
    await Bun.write(path, "not json")
    const logs: string[] = []
    const store = new BotKeyring({
      keyring: () =>
        new E2eKeyring({ store: new FileKeyStore({ dir }), account: ACCOUNT, mint: mintE2eKeyRecord, log: () => {} }),
      log: (message) => logs.push(message),
    })
    expect(await store.ensure()).toEqual([])
    expect(logs.join("\n")).toContain(path)
    expect(readFileSync(path, "utf8")).toBe("not json")
  })

  test("presenceFields is empty before ensure()", () => {
    expect(keyring(tempDir()).presenceFields()).toEqual({})
  })
})

describe("openSealedTurnContext", () => {
  async function buildSealedClaim(bikStore: BotKeyring): Promise<{
    sealed: SealedTurnContext
    ssk: Uint8Array
    oldSsk: Uint8Array
  }> {
    const [bik] = await bikStore.ensure()
    if (!bik) throw new Error("no key")
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
    const store = keyring(tempDir())
    const { sealed, ssk } = await buildSealedClaim(store)
    const opened = await openSealedTurnContext({ sealed, identities: store.identities, streamId: STREAM_ID })

    expect(opened.promptMarkdown).toBe("Do the thing, please")
    expect(opened.promptAttachmentRefs).toEqual([])
    expect(opened.history).toEqual([
      { role: "user", sequence: "10", contentMarkdown: "earlier question", attachmentRefs: [] },
      { role: "assistant", sequence: "11", contentMarkdown: "earlier answer", attachmentRefs: [] },
    ])
    expect(opened.sealing.callbackToken).toBe("cbtok_1")
    expect(opened.sealing.replyKeyGeneration).toBe(2)
    expect(bytesToBase64(opened.sealing.replySsk)).toBe(bytesToBase64(ssk))
  })

  test("history sealed under an ungranted generation is skipped, not fatal", async () => {
    const store = keyring(tempDir())
    const { sealed } = await buildSealedClaim(store)
    // Drop the generation-1 wrap: its history row becomes unopenable.
    sealed.wraps = sealed.wraps.filter((w) => w.keyGeneration !== 1)
    const opened = await openSealedTurnContext({ sealed, identities: store.identities, streamId: STREAM_ID })
    expect(opened.history).toEqual([
      { role: "assistant", sequence: "11", contentMarkdown: "earlier answer", attachmentRefs: [] },
    ])
  })

  test("attachment refs sealed into the prompt and history payloads surface on the opened turn", async () => {
    const store = keyring(tempDir())
    const [bik] = await store.ensure()
    if (!bik) throw new Error("no key")
    const ssk = randomSsk()
    const wrap = await ownerWrapSsk(
      ssk,
      bik.publicKeyBase64,
      buildWrapAad({ streamId: STREAM_ID, keyGeneration: 0, recipientKeyId: bik.publicKeyId })
    )
    const promptRef = {
      attachmentId: "att_prompt",
      key: "a2V5",
      iv: "aXY=",
      filename: "spec.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
    }
    const historyRef = { ...promptRef, attachmentId: "att_history", filename: "notes.txt", mimeType: "text/plain" }
    const prompt = await ownerSealMessage(ssk, 0, "msg_trigger", "usr_owner", "review the spec", {
      attachmentRefs: [promptRef],
    })
    const history = await ownerSealMessage(ssk, 0, "msg_h1", "usr_owner", "earlier, with a file", {
      attachmentRefs: [historyRef],
    })
    const opened = await openSealedTurnContext({
      sealed: {
        callbackToken: "cbtok_1",
        wraps: [{ keyGeneration: 0, ...wrap }],
        history: [{ ...history, role: "user", sequence: "10" }],
        prompt,
        reply: { keyGeneration: 0, senderId: SENDER_ID },
      },
      identities: [bik],
      streamId: STREAM_ID,
    })
    expect(opened.promptAttachmentRefs).toEqual([promptRef])
    expect(opened.history[0]!.attachmentRefs).toEqual([historyRef])
  })

  test("a missing reply-generation wrap is fatal", async () => {
    const store = keyring(tempDir())
    const { sealed } = await buildSealedClaim(store)
    sealed.wraps = sealed.wraps.filter((w) => w.keyGeneration !== 2)
    await expect(openSealedTurnContext({ sealed, identities: store.identities, streamId: STREAM_ID })).rejects.toThrow(
      "no SSK wrap"
    )
  })

  test("a keyring tries every key, so a turn wrapped to a non-default one still opens", async () => {
    const store = keyring(tempDir())
    const other = keyring(tempDir())
    const { sealed, ssk } = await buildSealedClaim(store)
    const identities = [...(await other.ensure()), ...store.identities]
    const opened = await openSealedTurnContext({ sealed, identities, streamId: STREAM_ID })
    expect(bytesToBase64(opened.sealing.replySsk)).toBe(bytesToBase64(ssk))
  })

  test("a turn wrapped to a key the runtime does not hold is fatal", async () => {
    const store = keyring(tempDir())
    const other = keyring(tempDir())
    const { sealed } = await buildSealedClaim(store)
    await expect(
      openSealedTurnContext({ sealed, identities: await other.ensure(), streamId: STREAM_ID })
    ).rejects.toThrow()
  })

  test("a wrap bound to a different stream id does not open (AAD binding)", async () => {
    const store = keyring(tempDir())
    const { sealed } = await buildSealedClaim(store)
    await expect(
      openSealedTurnContext({ sealed, identities: store.identities, streamId: "stream_01OTHER" })
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

describe("sealDecision / openSealedDecisionNote", () => {
  const CARD_STREAM = "stream_01THREAD"
  const DECIDER = "usr_01TEST"

  function makeSealing(ssk: Uint8Array): SealingState {
    return {
      streamId: STREAM_ID,
      replyKeyGeneration: 2,
      replySenderId: SENDER_ID,
      replySsk: ssk,
      callbackToken: "cbtok_1",
    }
  }

  test("a sealed card binds to the stream it is posted to, not the key's root", async () => {
    const ssk = randomSsk()
    const card = await sealDecision(
      makeSealing(ssk),
      { streamId: CARD_STREAM, requesterBotId: SENDER_ID },
      { title: "Run it?", bodyMarkdown: "`rm -rf build`", optionLabels: { yes: "Allow once", no: "Deny" } }
    )
    expect(card.decisionId.startsWith("dreq_")).toBe(true)
    expect(new TextDecoder().decode(base64ToBytes(card.envelope.aad))).toBe(
      `${CARD_STREAM}|decision|${card.decisionId}|${SENDER_ID}`
    )
    const opened = await openMessageAsString({
      key: ssk,
      envelope: card.envelope,
      ciphertext: base64ToBytes(card.ciphertext),
    })
    expect(JSON.parse(opened)).toEqual({
      title: "Run it?",
      bodyMarkdown: "`rm -rf build`",
      optionLabels: { yes: "Allow once", no: "Deny" },
    })
  })

  test("the note the human attached opens under the note AAD", async () => {
    const ssk = randomSsk()
    const sealing = makeSealing(ssk)
    const decisionId = "dreq_01TEST"
    const sealed = await sealMessage({
      key: ssk,
      keyGeneration: 2,
      payload: "hold off until the build is green",
      aad: new TextEncoder().encode(`${CARD_STREAM}|decision-note|${decisionId}|${DECIDER}`),
    })
    const note = {
      streamId: CARD_STREAM,
      decisionId,
      decidedBy: DECIDER,
      ciphertext: bytesToBase64(sealed.ciphertext),
      envelope: sealed.envelope,
    }
    expect(await openSealedDecisionNote(sealing, note)).toBe("hold off until the build is green")
    // Another slot, and a generation this turn does not hold, both come back
    // null so the answer still settles without its note.
    expect(await openSealedDecisionNote(sealing, { ...note, decidedBy: "usr_other" })).toBeNull()
    expect(
      await openSealedDecisionNote(sealing, { ...note, envelope: { ...note.envelope, keyGeneration: 1 } })
    ).toBeNull()
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

describe("openSealedAck (session-control command acks)", () => {
  test("unwraps the SSK and yields a SealingState that seals an ack the owner opens", async () => {
    const { openSealedAck, parseSealedAckContext, sealReply } = await import("./sealed")
    const [bik] = await keyring(tempDir()).ensure()
    if (!bik) throw new Error("no key")
    const ssk = randomSsk()
    const wrap = await ownerWrapSsk(
      ssk,
      bik.publicKeyBase64,
      buildWrapAad({ streamId: STREAM_ID, keyGeneration: 2, recipientKeyId: bik.publicKeyId })
    )
    const ack = parseSealedAckContext({
      wraps: [{ keyGeneration: 2, ...wrap }],
      reply: { keyGeneration: 2, senderId: SENDER_ID },
    })
    expect(ack).toBeDefined()

    const sealing = await openSealedAck({ ack: ack!, identities: [bik], streamId: STREAM_ID })
    expect(sealing.replyKeyGeneration).toBe(2)
    expect(sealing.callbackToken).toBe("")

    const body = await sealReply(sealing, "Model changed: `a` → `b`")
    const opened = await openMessageAsString({
      key: ssk,
      envelope: body.envelope,
      ciphertext: base64ToBytes(body.ciphertext),
    })
    expect(opened).toBe("Model changed: `a` → `b`")
    expect(new TextDecoder().decode(base64ToBytes(body.envelope.aad))).toBe(
      `${STREAM_ID}|${body.messageId}|${SENDER_ID}`
    )
  })

  test("throws when no wrap covers the reply generation", async () => {
    const { openSealedAck } = await import("./sealed")
    const [bik] = await keyring(tempDir()).ensure()
    if (!bik) throw new Error("no key")
    await expect(
      openSealedAck({
        ack: { wraps: [], reply: { keyGeneration: 2, senderId: SENDER_ID } },
        identities: [bik],
        streamId: STREAM_ID,
      })
    ).rejects.toThrow("no SSK wrap")
  })

  test.each([
    ["missing reply", { wraps: [] }],
    ["malformed wrap", { wraps: [{ keyGeneration: "x" }], reply: { keyGeneration: 0, senderId: "b" } }],
    ["not an object", 42],
  ])("parseSealedAckContext rejects %s", async (_label, input) => {
    const { parseSealedAckContext } = await import("./sealed")
    expect(parseSealedAckContext(input)).toBeUndefined()
  })
})

describe("mintStreamKeyWraps (harness-created E2E scratchpads)", () => {
  test("each recipient's wrap unwraps to the same key under its own slot AAD", async () => {
    const owner = await ownerSuite.kem.generateKeyPair()
    const ownerPublicKey = bytesToBase64(new Uint8Array(await ownerSuite.kem.serializePublicKey(owner.publicKey)))
    const bikStore = keyring(tempDir())
    const [bik] = await bikStore.ensure()
    if (!bik) throw new Error("no key")

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
