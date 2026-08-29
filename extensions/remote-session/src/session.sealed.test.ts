import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Aes256Gcm, CipherSuite, HkdfSha256 } from "@hpke/core"
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519"
import {
  base64ToBytes,
  buildMessageAad,
  buildWrapAad,
  bytesToBase64,
  decryptAttachmentBytes,
  encryptAttachmentBytes,
  openMessageAsString,
  parseSealedPayload,
  sealMessage,
  serializeSealedPayload,
  type AttachmentRef,
  type BotRuntimeTransport,
  type SealedPayloadExtras,
  type SealedReplyBody,
  type SealedStepFrame,
  type StreamEnvelope,
} from "@threahq/bot-runtime-client"
import { RemoteSession, type RemoteSessionDelegate, type RuntimeDescriptor } from "./session"
import type { RemoteSessionConfig } from "./identity"
import type { ClaimedInvocation, ThreaClient } from "./client"

// End-to-end sealed session behavior with REAL crypto: an "owner" wraps a
// stream key to the session's BIK and seals a trigger; the session must open
// it, deliver decrypted content to the runtime, and seal everything it posts
// back (steps, interims, replies, timeout notes) so the owner's key opens it —
// with zero plaintext writes along the way.

const ROOT_STREAM = "stream_root"
const BOT_SENDER = "bot_1"

const RUNTIME: RuntimeDescriptor = {
  kind: "test-runtime",
  busyStatusText: "Working…",
  forwardedNote: "Forwarded to the runtime.",
  shutdownErrorMessage: "Test runtime shut down",
}

const ownerSuite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
})

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeConfig(bikPath: string): RemoteSessionConfig {
  return {
    baseUrl: "https://app.threa.io",
    workspaceId: "ws_1",
    apiKey: "threa_bk_test",
    displayName: "Test Runtime - test",
    instanceId: "rt-test",
    runtimeSessionId: "rts-test",
    permissionRelay: false,
    pollMs: 3000,
    idleTimeoutMs: 3_600_000,
    sealedFullTrace: true,
    traceMode: "headline",
    bikPath,
  }
}

interface FakeCalls {
  fail: Array<{ id: string; body: Record<string, unknown> }>
  complete: Array<{ id: string; body: Record<string, unknown> }>
  sendMessage: Array<{ streamId: string; body: Record<string, unknown> }>
  sealedMessages: Array<{ id: string; callbackToken: string; body: SealedReplyBody }>
  completeSealed: Array<{ id: string; callbackToken: string; body: Record<string, unknown> }>
  sealedSteps: Array<{ id: string; callbackToken: string; frames: SealedStepFrame[] }>
  plainSteps: Array<{ id: string }>
}

/**
 * A session over a fake client/transport whose claim() shifts from `queue` —
 * push a sealed claim in AFTER building it against the session's BIK.
 */
function makeSealedSession(delegate: Partial<RemoteSessionDelegate> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sealed-session-"))
  tempDirs.push(dir)
  const queue: Array<ClaimedInvocation | null> = []
  const calls: FakeCalls = {
    fail: [],
    complete: [],
    sendMessage: [],
    sealedMessages: [],
    completeSealed: [],
    sealedSteps: [],
    plainSteps: [],
  }
  // Every upload a sealed turn makes: it must be ciphertext-only, e2e-flagged,
  // under the placeholder filename — the assertions read these captures.
  const uploads: Array<{ filename: string; type: string; e2e: unknown; bytes: Uint8Array }> = []
  // Fault injection for the sealed-messages POST (retry-path tests).
  const control = { failNextSealedMessage: 0 }
  const client = {
    claim: async () => queue.shift() ?? null,
    fail: async (id: string, body: Record<string, unknown>) => {
      calls.fail.push({ id, body })
    },
    complete: async (id: string, body: Record<string, unknown>) => {
      calls.complete.push({ id, body })
    },
    sendMessage: async (streamId: string, body: Record<string, unknown>) => {
      calls.sendMessage.push({ streamId, body })
    },
    sendSealedMessage: async (id: string, callbackToken: string, body: SealedReplyBody) => {
      if (control.failNextSealedMessage > 0) {
        control.failNextSealedMessage -= 1
        throw new Error("simulated sealed-message POST failure")
      }
      calls.sealedMessages.push({ id, callbackToken, body })
    },
    completeSealed: async (id: string, callbackToken: string, body: Record<string, unknown>) => {
      calls.completeSealed.push({ id, callbackToken, body })
    },
    uploadAttachment: async (form: FormData) => {
      const file = form.get("file") as Blob & { name?: string }
      uploads.push({
        filename: file.name ?? "",
        type: file.type,
        e2e: form.get("e2e"),
        bytes: new Uint8Array(await file.arrayBuffer()),
      })
      if (uploads[uploads.length - 1]!.e2e !== "true") {
        throw new Error("unexpected plaintext upload on a sealed turn")
      }
      return {
        id: `att_up_${uploads.length}`,
        filename: "encrypted",
        mimeType: "application/octet-stream",
        sizeBytes: 1,
      }
    },
    getAttachmentDownloadUrl: async (id: string) => `https://signed.example/${id}`,
    listStreamMessages: async () => {
      throw new Error("unexpected plaintext message fetch on a sealed turn")
    },
  }
  const transport = {
    connect: async () => {},
    disconnect: () => {},
    socketConnected: false,
    sendHello: () => {},
    recordSteps: async (id: string) => {
      calls.plainSteps.push({ id })
    },
    recordSealedSteps: async (id: string, callbackToken: string, frames: SealedStepFrame[]) => {
      calls.sealedSteps.push({ id, callbackToken, frames })
    },
    renewClaim: async () => ({ notFound: false }),
    updatePresence: async () => {},
  }
  const session = new RemoteSession({
    config: makeConfig(join(dir, "bik.json")),
    client: client as unknown as ThreaClient,
    delegate: { deliverTurn: async () => {}, ...delegate },
    runtime: RUNTIME,
    transport: transport as unknown as BotRuntimeTransport,
  })
  return { session, calls, queue, uploads, control }
}

/** The owner's half of the ceremony: wrap a fresh SSK to the session's BIK and seal trigger + history under it. */
async function ownerBuildsSealedClaim(
  session: RemoteSession,
  overrides: Partial<ClaimedInvocation> = {},
  promptExtras?: SealedPayloadExtras
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bik = await (session as any).bik.ensure()
  const ssk = new Uint8Array(32)
  crypto.getRandomValues(ssk)
  const raw = base64ToBytes(bik.publicKeyBase64)
  const recipient = await ownerSuite.kem.deserializePublicKey(
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
  )
  const wrapped = await ownerSuite.seal(
    { recipientPublicKey: recipient },
    ssk,
    buildWrapAad({ streamId: ROOT_STREAM, keyGeneration: 1, recipientKeyId: bik.publicKeyId })
  )
  const sealFor = async (messageId: string, senderId: string, markdown: string, extras?: SealedPayloadExtras) => {
    const sealed = await sealMessage({
      key: ssk,
      keyGeneration: 1,
      payload: serializeSealedPayload(markdown, extras),
      aad: buildMessageAad({ streamId: ROOT_STREAM, messageId, senderId }),
    })
    return { ciphertext: bytesToBase64(sealed.ciphertext), envelope: sealed.envelope }
  }
  const invocation: ClaimedInvocation = {
    id: "binv_sealed",
    workspaceId: "ws_1",
    rootStreamId: ROOT_STREAM,
    activeStreamId: ROOT_STREAM,
    sourceMessageId: "msg_trigger",
    responseStreamId: ROOT_STREAM,
    actor: { type: "bot", id: BOT_SENDER, slug: "claude" },
    trigger: "active-scratchpad",
    requiredCapability: "active-scratchpad",
    promptMarkdown: "[encrypted]",
    authorUserId: "user_1",
    mentionedActorSlugs: [],
    claimToken: "cbtok",
    claimExpiresAt: "2026-07-03T00:00:00.000Z",
    runtimeSessionId: "rts-test",
    metadata: {},
    sealedContext: {
      callbackToken: "cbtok",
      wraps: [
        {
          keyGeneration: 1,
          wrapEnc: bytesToBase64(new Uint8Array(wrapped.enc)),
          wrapCt: bytesToBase64(new Uint8Array(wrapped.ct)),
        },
      ],
      history: [{ ...(await sealFor("msg_h1", "user_1", "earlier note")), role: "user", sequence: "5" }],
      prompt: await sealFor("msg_trigger", "user_1", "Please refactor the auth module", promptExtras),
      reply: { keyGeneration: 1, senderId: BOT_SENDER },
    },
    ...overrides,
  }
  const openSealedPayload = async (body: { ciphertext: string; envelope: StreamEnvelope }) =>
    parseSealedPayload(
      await openMessageAsString({ key: ssk, envelope: body.envelope, ciphertext: base64ToBytes(body.ciphertext) })
    )
  const openSealed = async (body: { ciphertext: string; envelope: StreamEnvelope }) =>
    (await openSealedPayload(body)).contentMarkdown
  return { invocation, openSealed, openSealedPayload }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const drain = (session: RemoteSession) => (session as any).claimDrain() as Promise<void>

async function startSealedTurn(delegate: Partial<RemoteSessionDelegate> = {}, promptExtras?: SealedPayloadExtras) {
  const made = makeSealedSession(delegate)
  const { invocation, openSealed, openSealedPayload } = await ownerBuildsSealedClaim(made.session, {}, promptExtras)
  made.queue.push(invocation)
  await drain(made.session)
  return { ...made, openSealed, openSealedPayload }
}

describe("sealed claim hydration + delivery", () => {
  test("decrypts the trigger + history, seals the forwarded step, never fetches plaintext", async () => {
    const delivered: string[] = []
    const { calls, openSealed } = await startSealedTurn({
      deliverTurn: async (turn) => {
        delivered.push(turn.content)
      },
    })

    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain("Please refactor the auth module")
    expect(delivered[0]).toContain("earlier note")
    // The forwarded note went out sealed, and nothing plaintext moved.
    expect(calls.sealedSteps).toHaveLength(1)
    expect(calls.plainSteps).toHaveLength(0)
    expect(await openSealed(calls.sealedSteps[0]!.frames[0]!)).toBe("Forwarded to the runtime.")
    expect(calls.sendMessage).toHaveLength(0)
    expect(calls.complete).toHaveLength(0)
  })

  test("inbound refs on the trigger download, decrypt, and land in the turn manifest", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "sealed-inbound-"))
    tempDirs.push(cwd)
    const plaintext = new TextEncoder().encode("the secret spec")
    const encrypted = await encryptAttachmentBytes(plaintext)
    const ref: AttachmentRef = {
      attachmentId: "att_in_1",
      key: encrypted.key,
      iv: encrypted.iv,
      filename: "spec.md",
      mimeType: "text/markdown",
      sizeBytes: plaintext.length,
    }
    const delivered: string[] = []
    const cwdSpy = spyOn(process, "cwd").mockReturnValue(cwd)
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(encrypted.ciphertext))
    try {
      await startSealedTurn(
        {
          deliverTurn: async (turn) => {
            delivered.push(turn.content)
          },
        },
        { attachmentRefs: [ref] }
      )
    } finally {
      cwdSpy.mockRestore()
      fetchSpy.mockRestore()
    }

    expect(delivered).toHaveLength(1)
    const localPath = join(cwd, ".threa-attachments", "binv_sealed", "att_in_1", "spec.md")
    expect(delivered[0]).toContain("spec.md (text/markdown, 15 bytes)")
    expect(delivered[0]).toContain("[attached to the message you just received]")
    expect(new TextDecoder().decode(readFileSync(localPath))).toBe("the secret spec")
  })

  test("a malformed sealedContext fails the invocation with a scrubbed reason", async () => {
    const delivered: string[] = []
    const made = makeSealedSession({
      deliverTurn: async (turn) => {
        delivered.push(turn.content)
      },
    })
    const { invocation } = await ownerBuildsSealedClaim(made.session)
    made.queue.push({ ...invocation, sealedContext: { nonsense: true } })

    await drain(made.session)

    expect(delivered).toHaveLength(0)
    expect(made.calls.fail).toHaveLength(1)
    expect(made.calls.fail[0]!.body.errorMessage).toBe("Sealed turn failed: malformed sealedContext")
  })
})

describe("sealed output paths", () => {
  test("reply seals the final markdown to /sealed-complete (owner key opens it)", async () => {
    const { session, calls, openSealed } = await startSealedTurn()

    const result = await session.reply("binv_sealed", "All done — auth module refactored.")

    expect(result.ok).toBe(true)
    expect(calls.complete).toHaveLength(0)
    expect(calls.completeSealed).toHaveLength(1)
    const sealed = calls.completeSealed[0]!
    expect(sealed.callbackToken).toBe("cbtok")
    const reply = sealed.body.reply as SealedReplyBody
    expect(await openSealed(reply)).toBe("All done — auth module refactored.")
    // The seal is bound to the fresh message id in the root stream's AAD.
    expect(new TextDecoder().decode(base64ToBytes(reply.envelope.aad))).toBe(
      `${ROOT_STREAM}|${reply.messageId}|${BOT_SENDER}`
    )
  })

  test("sendInterim encrypts + uploads THREA_ATTACH files and seals the refs into the payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sealed-interim-attach-"))
    tempDirs.push(dir)
    const filePath = join(dir, "report.html")
    const plaintext = new TextEncoder().encode("<h1>secret report</h1>")
    writeFileSync(filePath, plaintext)
    const { session, calls, uploads, openSealedPayload } = await startSealedTurn()

    const result = await session.sendInterim("binv_sealed", `Progress so far.\nTHREA_ATTACH: ${filePath}`)

    expect(result.ok).toBe(true)
    expect(calls.sendMessage).toHaveLength(0)
    expect(calls.sealedMessages).toHaveLength(1)
    // The upload was ciphertext-only, flagged e2e, under the placeholder name.
    expect(uploads).toHaveLength(1)
    expect(uploads[0]!.e2e).toBe("true")
    expect(uploads[0]!.filename).toBe("encrypted")
    expect(Array.from(uploads[0]!.bytes)).not.toEqual(Array.from(plaintext))
    // The wire body binds the row; the sealed payload carries the ref that opens it.
    const wire = calls.sealedMessages[0]!.body as SealedReplyBody & { attachmentIds?: string[] }
    expect(wire.attachmentIds).toEqual(["att_up_1"])
    const payload = await openSealedPayload(calls.sealedMessages[0]!.body)
    expect(payload.contentMarkdown).toBe("Progress so far.")
    expect(payload.contentMarkdown).not.toContain("THREA_ATTACH")
    expect(payload.attachmentRefs).toHaveLength(1)
    const ref = payload.attachmentRefs[0]!
    expect(ref).toMatchObject({ attachmentId: "att_up_1", filename: "report.html", mimeType: "text/html" })
    const decrypted = await decryptAttachmentBytes({ ciphertext: uploads[0]!.bytes, key: ref.key, iv: ref.iv })
    expect(new TextDecoder().decode(decrypted)).toBe("<h1>secret report</h1>")
  })

  test("reply uploads sealed attachments and binds them on /sealed-complete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sealed-reply-attach-"))
    tempDirs.push(dir)
    const filePath = join(dir, "diff.patch")
    writeFileSync(filePath, "--- a\n+++ b\n")
    const { session, calls, uploads, openSealedPayload } = await startSealedTurn()

    const result = await session.reply("binv_sealed", `Done — patch attached.\nTHREA_ATTACH: ${filePath}`)

    expect(result.ok).toBe(true)
    expect(calls.completeSealed).toHaveLength(1)
    const reply = calls.completeSealed[0]!.body.reply as SealedReplyBody & { attachmentIds?: string[] }
    expect(reply.attachmentIds).toEqual(["att_up_1"])
    expect(uploads).toHaveLength(1)
    const payload = await openSealedPayload(reply)
    expect(payload.contentMarkdown).toBe("Done — patch attached.")
    expect(payload.attachmentRefs).toHaveLength(1)
    expect(payload.attachmentRefs[0]!.filename).toBe("diff.patch")
  })

  test("an interim retry after a failed POST reuses the sealed body and its uploads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sealed-retry-"))
    tempDirs.push(dir)
    const filePath = join(dir, "log.txt")
    writeFileSync(filePath, "retry me")
    const { session, calls, uploads, control } = await startSealedTurn()
    const text = `Progress.\nTHREA_ATTACH: ${filePath}`

    control.failNextSealedMessage = 1
    const first = await session.sendInterim("binv_sealed", text)
    expect(first.ok).toBe(false)
    const retry = await session.sendInterim("binv_sealed", text)
    expect(retry.ok).toBe(true)

    // One upload total, and the retried POST carries the same ids.
    expect(uploads).toHaveLength(1)
    expect(calls.sealedMessages).toHaveLength(1)
    const wire = calls.sealedMessages[0]!.body as SealedReplyBody & { attachmentIds?: string[] }
    expect(wire.attachmentIds).toEqual(["att_up_1"])
  })

  test("different text after a failed interim builds a fresh body instead of replaying the stale one", async () => {
    const { session, calls, control, openSealed } = await startSealedTurn()

    control.failNextSealedMessage = 1
    const first = await session.sendInterim("binv_sealed", "message A")
    expect(first.ok).toBe(false)
    const second = await session.sendInterim("binv_sealed", "message B")
    expect(second.ok).toBe(true)

    expect(calls.sealedMessages).toHaveLength(1)
    expect(await openSealed(calls.sealedMessages[0]!.body)).toBe("message B")
  })

  test("a missing THREA_ATTACH file surfaces as a sealed failure note, never plaintext", async () => {
    const { session, calls, uploads, openSealedPayload } = await startSealedTurn()

    const result = await session.sendInterim("binv_sealed", "Progress.\nTHREA_ATTACH: ./does-not-exist.txt")

    expect(result.ok).toBe(true)
    expect(uploads).toHaveLength(0)
    const payload = await openSealedPayload(calls.sealedMessages[0]!.body)
    expect(payload.contentMarkdown).toContain("Progress.")
    expect(payload.contentMarkdown).toContain("Attachment upload failed:")
    expect(payload.attachmentRefs).toEqual([])
    const wire = calls.sealedMessages[0]!.body as SealedReplyBody & { attachmentIds?: string[] }
    expect(wire.attachmentIds).toBeUndefined()
  })

  test("postToStream routes through the sealed wire while a sealed turn runs in that stream", async () => {
    const { session, calls, openSealed } = await startSealedTurn()

    await session.postToStream(ROOT_STREAM, { content: "**Claude Code wants to run `Bash`**" })

    expect(calls.sendMessage).toHaveLength(0)
    expect(calls.sealedMessages).toHaveLength(1)
    expect(await openSealed(calls.sealedMessages[0]!.body)).toBe("**Claude Code wants to run `Bash`**")
  })

  test("the idle-timeout close seals its note instead of posting plaintext", async () => {
    const { session, calls, openSealed } = await startSealedTurn()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (session as any).onReplyTimeout("binv_sealed")

    expect(calls.complete).toHaveLength(0)
    expect(calls.completeSealed).toHaveLength(1)
    const body = calls.completeSealed[0]!.body
    expect(await openSealed(body.reply as SealedReplyBody)).toContain("without sending a reply")
  })
})

describe("harness-created E2E scratchpad (two-phase create)", () => {
  function makeE2eCreateSession(opts: { e2eEnabledOnCreate: boolean; provisionFailures?: number }) {
    const dir = mkdtempSync(join(tmpdir(), "sealed-create-"))
    tempDirs.push(dir)
    const calls = {
      createBodies: [] as Array<Record<string, unknown>>,
      provisioned: [] as Array<{ streamId: string; body: { keyGeneration: number; wraps: unknown[] } }>,
      ownerKeyFetches: 0,
    }
    let remainingFailures = opts.provisionFailures ?? 0
    const client = {
      createSession: async (body: Record<string, unknown>) => {
        calls.createBodies.push(body)
        return {
          linkId: "link_1",
          rootStreamId: ROOT_STREAM,
          activeStreamId: ROOT_STREAM,
          runtimeSessionId: "rts-test",
          streamUrlPath: `/w/ws_1/s/${ROOT_STREAM}`,
          e2eEnabled: opts.e2eEnabledOnCreate,
        }
      },
      getOwnerE2eKey: async () => {
        calls.ownerKeyFetches++
        return { keyId: "uik_owner", publicKey: OWNER_PUBLIC_KEY_B64 }
      },
      provisionStreamKeyWraps: async (streamId: string, body: { keyGeneration: number; wraps: unknown[] }) => {
        if (remainingFailures > 0) {
          remainingFailures--
          throw new Error("transient")
        }
        calls.provisioned.push({ streamId, body })
      },
      claim: async () => null,
    }
    const transport = {
      connect: async () => {},
      disconnect: () => {},
      socketConnected: false,
      updatePresence: async () => {},
      recordSteps: async () => {},
      recordSealedSteps: async () => {},
      renewClaim: async () => ({ notFound: false }),
    }
    const session = new RemoteSession({
      config: { ...makeConfig(join(dir, "bik.json")), e2e: true },
      client: client as unknown as ThreaClient,
      delegate: { deliverTurn: async () => {} },
      runtime: RUNTIME,
      transport: transport as unknown as BotRuntimeTransport,
    })
    return { session, calls }
  }

  let OWNER_PUBLIC_KEY_B64 = ""
  async function ownerKeyPair() {
    const pair = await ownerSuite.kem.generateKeyPair()
    OWNER_PUBLIC_KEY_B64 = bytesToBase64(new Uint8Array(await ownerSuite.kem.serializePublicKey(pair.publicKey)))
    return pair
  }

  test("creates with the owner key and provisions owner+BIK wraps the owner can open", async () => {
    const owner = await ownerKeyPair()
    const { session, calls } = makeE2eCreateSession({ e2eEnabledOnCreate: true })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (session as any).ensureLink()

    expect(calls.createBodies[0]?.e2e).toEqual({ ownerKeyId: "uik_owner" })
    expect(calls.provisioned).toHaveLength(1)
    const { streamId, body } = calls.provisioned[0]!
    expect(streamId).toBe(ROOT_STREAM)
    expect(body.keyGeneration).toBe(0)
    const wraps = body.wraps as Array<{
      recipientKind: string
      recipientKeyId: string
      wrapEnc: string
      wrapCt: string
    }>
    expect(wraps.map((w) => w.recipientKind).sort()).toEqual(["bot", "user"])
    // The owner's private key opens the user-slot wrap — the ceremony is real.
    const ownerWrap = wraps.find((w) => w.recipientKind === "user")!
    const opened = await ownerSuite.open(
      { recipientKey: owner.privateKey, enc: base64ToBytes(ownerWrap.wrapEnc) },
      base64ToBytes(ownerWrap.wrapCt),
      buildWrapAad({ streamId: ROOT_STREAM, keyGeneration: 0, recipientKeyId: "uik_owner" })
    )
    expect(new Uint8Array(opened)).toHaveLength(32)
  })

  test("retries a transiently-failing provisioning with the SAME wraps", async () => {
    await ownerKeyPair()
    const { session, calls } = makeE2eCreateSession({ e2eEnabledOnCreate: true, provisionFailures: 2 })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (session as any).ensureLink()

    expect(calls.provisioned).toHaveLength(1)
  })

  test("a plaintext resume warns instead of provisioning", async () => {
    await ownerKeyPair()
    const { session, calls } = makeE2eCreateSession({ e2eEnabledOnCreate: false })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (session as any).ensureLink()

    expect(calls.provisioned).toHaveLength(0)
  })
})
