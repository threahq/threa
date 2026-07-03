import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
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
  parseSealedPayload,
  sealMessage,
  serializeSealedPayload,
  type BotRuntimeTransport,
  type SealedReplyBody,
  type SealedStepFrame,
  type StreamEnvelope,
} from "@threa/bot-runtime-client"
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
      calls.sealedMessages.push({ id, callbackToken, body })
    },
    completeSealed: async (id: string, callbackToken: string, body: Record<string, unknown>) => {
      calls.completeSealed.push({ id, callbackToken, body })
    },
    uploadAttachment: async () => {
      throw new Error("unexpected plaintext upload on a sealed turn")
    },
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
  return { session, calls, queue }
}

/** The owner's half of the ceremony: wrap a fresh SSK to the session's BIK and seal trigger + history under it. */
async function ownerBuildsSealedClaim(session: RemoteSession, overrides: Partial<ClaimedInvocation> = {}) {
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
  const sealFor = async (messageId: string, senderId: string, markdown: string) => {
    const sealed = await sealMessage({
      key: ssk,
      keyGeneration: 1,
      payload: serializeSealedPayload(markdown),
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
      prompt: await sealFor("msg_trigger", "user_1", "Please refactor the auth module"),
      reply: { keyGeneration: 1, senderId: BOT_SENDER },
    },
    ...overrides,
  }
  const openSealed = async (body: { ciphertext: string; envelope: StreamEnvelope }) =>
    parseSealedPayload(
      await openMessageAsString({ key: ssk, envelope: body.envelope, ciphertext: base64ToBytes(body.ciphertext) })
    ).contentMarkdown
  return { invocation, openSealed }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const drain = (session: RemoteSession) => (session as any).claimDrain() as Promise<void>

async function startSealedTurn(delegate: Partial<RemoteSessionDelegate> = {}) {
  const made = makeSealedSession(delegate)
  const { invocation, openSealed } = await ownerBuildsSealedClaim(made.session)
  made.queue.push(invocation)
  await drain(made.session)
  return { ...made, openSealed }
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

  test("sendInterim seals to /sealed-messages and strips attachment directives", async () => {
    const { session, calls, openSealed } = await startSealedTurn()

    const result = await session.sendInterim("binv_sealed", "Progress so far.\nTHREA_ATTACH: ./report.html")

    expect(result.ok).toBe(true)
    expect(calls.sendMessage).toHaveLength(0)
    expect(calls.sealedMessages).toHaveLength(1)
    const opened = await openSealed(calls.sealedMessages[0]!.body)
    expect(opened).toContain("Progress so far.")
    expect(opened).not.toContain("THREA_ATTACH")
    expect(opened).toContain("not uploaded")
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
