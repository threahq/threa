/**
 * End-to-end proof of the sealed (E2EE) external-harness wire, through the real
 * server, database, outbox, and claim machinery — the full lifecycle Kris's
 * local harnesses run:
 *
 *   1. the harness creates its linked scratchpad ENCRYPTED (two-phase: create
 *      with the owner's key id, then provision the generation-0 wraps it
 *      minted for the owner's UIK + its own BIK),
 *   2. the owner unwraps their wrap, seals a message into the scratchpad,
 *   3. the invocation dispatches with a sealed claim the harness opens with
 *      its BIK (decrypted trigger),
 *   4. the harness seals a full-detail trace step, an interim message, and the
 *      final reply back,
 *   5. the owner's key opens everything the harness produced, and the server
 *      stored only placeholders + ciphertext throughout.
 *
 * The crypto is the REAL SDK module both harnesses ship
 * (@threahq/bot-runtime-client, imported by path like the parity tests), so this
 * covers the exact bytes production runs.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { BotTraits, E2E_PLACEHOLDER_CONTENT_MARKDOWN, WORKSPACE_PERMISSION_SCOPES } from "@threa/types"
import {
  botApiGet,
  botApiPost,
  botUploadFile,
  createBot,
  createBotKey,
  createWorkspace,
  loginAs,
  TestClient,
} from "../client"
import {
  base64ToBytes,
  buildMessageAad,
  buildWrapAad,
  bytesToBase64,
  decryptAttachmentBytes,
  encryptAttachmentBytes,
  exportPublicKey,
  generateKeyPair,
  openMessageAsString,
  parseSealedPayload,
  sealMessage,
  serializeSealedPayload,
  unwrapStreamKey,
  type AttachmentRef,
  type StreamEnvelope,
} from "../../../../extensions/bot-runtime-client/src/crypto"
import {
  mintStreamKeyWraps,
  openSealedTurnContext,
  parseSealedTurnContext,
  sealReply,
  sealStep,
  THREA_CALLBACK_TOKEN_HEADER,
  type BotIdentityKey,
} from "../../../../extensions/bot-runtime-client/src/sealed"

setDefaultTimeout(120_000)

const testRunId = Math.random().toString(36).substring(7)

interface SessionLinkData {
  linkId: string
  rootStreamId: string
  activeStreamId: string
  runtimeSessionId: string
  streamUrlPath: string
  e2eEnabled?: boolean
}

interface SealedClaimData {
  id: string
  claimToken: string
  promptMarkdown: string
  rootStreamId: string
  sealedContext?: unknown
}

interface WireEvent {
  id: string
  eventType: string
  payload: {
    messageId?: string
    contentMarkdown?: string
    ciphertext?: string
    envelope?: StreamEnvelope
    [key: string]: unknown
  }
  actorType?: string
}

async function makeIdentity(prefix: string): Promise<BotIdentityKey> {
  const pair = await generateKeyPair()
  return {
    publicKeyId: `${prefix}_${testRunId}`,
    publicKeyBase64: bytesToBase64(await exportPublicKey(pair.publicKey)),
    privateKey: pair.privateKey,
  }
}

describe("sealed harness session (full E2EE round trip)", () => {
  test("harness-created encrypted scratchpad serves a sealed turn end to end", async () => {
    const client = new TestClient()
    const user = await loginAs(client, `sealed-${testRunId}@test.com`, "Sealed Owner")
    const workspace = await createWorkspace(client, `Sealed WS ${testRunId}`)
    const bot = await createBot(client, workspace.id, {
      type: "personal",
      name: `Sealed Harness ${testRunId}`,
      slug: `sealed-${testRunId}`,
      traits: [BotTraits.ACTIVE_SCRATCHPAD, BotTraits.MENTIONABLE],
    })
    const apiKey = await createBotKey(client, workspace.id, bot.id, [
      WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE,
      WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE,
      WORKSPACE_PERMISSION_SCOPES.ATTACHMENTS_READ,
      WORKSPACE_PERMISSION_SCOPES.ATTACHMENTS_WRITE,
    ])

    // The owner sets up encryption (their UIK). The private bundle is opaque to
    // the server, so a stub suffices — the real private key stays in this test.
    const ownerKeyPair = await generateKeyPair()
    const ownerPublicKeyB64 = bytesToBase64(await exportPublicKey(ownerKeyPair.publicKey))
    const setKey = await client.post<{ key: { keyId: string } }>(`/api/workspaces/${workspace.id}/users/me/e2e-key`, {
      publicKey: ownerPublicKeyB64,
      encryptedPrivateBundle: bytesToBase64(new TextEncoder().encode("test-bundle")),
      kdfSalt: bytesToBase64(crypto.getRandomValues(new Uint8Array(16))),
      kdfParams: { algorithm: "argon2id", m: 65536, t: 3, p: 1, version: 19 },
    })
    expect(setKey.status).toBe(201)
    const ownerKeyId = setKey.data.key.keyId

    // The harness registers its BIK on presence (as every hello/heartbeat does).
    const bik = await makeIdentity("bik")
    const instanceId = `sealed-inst-${testRunId}`
    const runtimeSessionId = `sealed-sess-${testRunId}`
    const presence = await botApiPost(client, workspace.id, "/bot-runtime/presence", apiKey, {
      runtimeKind: "claude-code-channel",
      instanceId,
      runtimeSessionId,
      status: "available",
      acceptingInvocations: true,
      publicKey: bik.publicKeyBase64,
      publicKeyId: bik.publicKeyId,
    })
    expect(presence.status).toBe(200)

    // Phase 1: create the linked scratchpad ENCRYPTED.
    const session = await botApiPost<{ data: SessionLinkData }>(client, workspace.id, "/bot-runtime/sessions", apiKey, {
      runtimeKind: "claude-code-channel",
      instanceId,
      runtimeSessionId,
      displayName: "Sealed Harness - e2e",
      localCwd: "/tmp/threa-sealed-e2e",
      e2e: { ownerKeyId },
    })
    expect(session.status).toBe(200)
    expect(session.data.data.e2eEnabled).toBe(true)
    const rootStreamId = session.data.data.rootStreamId

    // Phase 2: mint the generation-0 stream key and provision owner + BIK wraps.
    const { wraps } = await mintStreamKeyWraps({
      streamId: rootStreamId,
      keyGeneration: 0,
      recipients: [
        { recipientKind: "user", recipientKeyId: ownerKeyId, publicKeyBase64: ownerPublicKeyB64 },
        { recipientKind: "bot", recipientKeyId: bik.publicKeyId, publicKeyBase64: bik.publicKeyBase64 },
      ],
    })
    const provision = await botApiPost<{ data: { stored: number } }>(
      client,
      workspace.id,
      `/streams/${rootStreamId}/e2e/key-wraps`,
      apiKey,
      { keyGeneration: 0, wraps }
    )
    expect(provision.status).toBe(200)
    expect(provision.data.data.stored).toBe(2)
    // A replayed provisioning cannot splice keys — it is refused outright.
    const replay = await botApiPost(client, workspace.id, `/streams/${rootStreamId}/e2e/key-wraps`, apiKey, {
      keyGeneration: 0,
      wraps,
    })
    expect(replay.status).toBe(409)

    // The OWNER's side of the ceremony: fetch their wrap and recover the SSK
    // with their private key — proving the harness's wrap actually opens.
    const wrapsRes = await client.get<{ currentKeyGeneration: number; wraps: Array<Record<string, string | number>> }>(
      `/api/workspaces/${workspace.id}/streams/${rootStreamId}/e2e/key-wraps`
    )
    expect(wrapsRes.status).toBe(200)
    expect(wrapsRes.data.currentKeyGeneration).toBe(0)
    const ownerWrap = wrapsRes.data.wraps.find((w) => w.recipientKeyId === ownerKeyId)
    expect(ownerWrap).toBeDefined()
    const ssk = await unwrapStreamKey({
      enc: base64ToBytes(String(ownerWrap!.wrapEnc)),
      ct: base64ToBytes(String(ownerWrap!.wrapCt)),
      recipientPrivateKey: ownerKeyPair.privateKey,
      aad: buildWrapAad({ streamId: rootStreamId, keyGeneration: 0, recipientKeyId: ownerKeyId }),
    })

    // The owner attaches an encrypted file to the trigger: ciphertext-only
    // upload (placeholder row), the ref sealed into the message payload.
    const inboundBytes = new TextEncoder().encode(`# sealed spec ${testRunId}\nline two`)
    const inboundEncrypted = await encryptAttachmentBytes(inboundBytes)
    const inboundUpload = await client.uploadFile<{ attachment: { id: string; filename: string } }>(
      `/api/workspaces/${workspace.id}/attachments`,
      {
        content: Buffer.from(inboundEncrypted.ciphertext),
        filename: "encrypted",
        mimeType: "application/octet-stream",
      },
      undefined,
      { e2e: "true" }
    )
    expect(inboundUpload.status).toBe(201)
    expect(inboundUpload.data.attachment.filename).toBe("encrypted")
    const inboundRef: AttachmentRef = {
      attachmentId: inboundUpload.data.attachment.id,
      key: inboundEncrypted.key,
      iv: inboundEncrypted.iv,
      filename: "sealed-spec.md",
      mimeType: "text/markdown",
      sizeBytes: inboundBytes.length,
    }

    // The owner seals the trigger into the scratchpad, ref riding the payload.
    const triggerText = "Please reply with exactly: sealed-forty-two"
    const triggerId = `msg_trigger_${testRunId}`
    const sealedTrigger = await sealMessage({
      key: ssk,
      keyGeneration: 0,
      payload: serializeSealedPayload(triggerText, { attachmentRefs: [inboundRef] }),
      aad: buildMessageAad({ streamId: rootStreamId, messageId: triggerId, senderId: user.id }),
    })
    const sent = await client.post(`/api/workspaces/${workspace.id}/messages`, {
      streamId: rootStreamId,
      ciphertext: bytesToBase64(sealedTrigger.ciphertext),
      envelope: sealedTrigger.envelope,
      e2eVersion: 2,
      attachmentIds: [inboundRef.attachmentId],
    })
    expect(sent.status).toBe(201)

    // The dispatch resolves a SEALED verdict (gate on + the bot's grant + BIK
    // wrap coverage) and the harness's claim carries the sealed context.
    let claimed: SealedClaimData | null = null
    for (let i = 0; i < 50 && !claimed; i++) {
      const res = await botApiPost<{ data: SealedClaimData | null }>(
        client,
        workspace.id,
        "/bot-invocations/claim",
        apiKey,
        {
          runtimeKind: "claude-code-channel",
          instanceId,
          runtimeSessionId,
          supportedCapabilities: ["active-scratchpad", "mentionable"],
          claimTtlSeconds: 120,
        }
      )
      if (res.status === 200 && res.data.data) claimed = res.data.data
      else await new Promise((resolve) => setTimeout(resolve, 200))
    }
    expect(claimed).not.toBeNull()
    expect(claimed!.sealedContext).toBeDefined()
    // The plaintext prompt field carries only the placeholder.
    expect(claimed!.promptMarkdown).not.toContain("sealed-forty-two")

    // The harness opens the claim with its BIK — exactly what the SDK does.
    const sealed = parseSealedTurnContext(claimed!.sealedContext)
    expect(sealed).toBeDefined()
    const opened = await openSealedTurnContext({ sealed: sealed!, identity: bik, streamId: rootStreamId })
    expect(opened.promptMarkdown).toBe(triggerText)

    // The trigger's ref surfaced from the sealed payload; the harness pulls the
    // opaque ciphertext through the public API and decrypts it locally.
    expect(opened.promptAttachmentRefs).toEqual([inboundRef])
    const inboundUrlRes = await botApiGet<{ data: { url: string } }>(
      client,
      workspace.id,
      `/attachments/${inboundRef.attachmentId}/url`,
      apiKey
    )
    expect(inboundUrlRes.status).toBe(200)
    const inboundCiphertext = new Uint8Array(await (await fetch(inboundUrlRes.data.data.url)).arrayBuffer())
    const inboundDecrypted = await decryptAttachmentBytes({
      ciphertext: inboundCiphertext,
      key: inboundRef.key,
      iv: inboundRef.iv,
    })
    expect(new TextDecoder().decode(inboundDecrypted)).toBe(`# sealed spec ${testRunId}\nline two`)

    // Full-detail trace step, sealed under the stream key.
    const stepText = "$ cat /etc/hosts\n127.0.0.1 localhost  # full detail, sealed"
    const stepFrame = await sealStep(opened.sealing, "tool_call", stepText)
    const stepRes = await client.request<{ data: { stepId: string } }>(
      "POST",
      `/api/v1/workspaces/${workspace.id}/bot-invocations/${claimed!.id}/sealed-steps`,
      stepFrame,
      { Authorization: `Bearer ${apiKey}`, [THREA_CALLBACK_TOKEN_HEADER]: opened.sealing.callbackToken }
    )
    expect(stepRes.status).toBe(200)
    expect(stepRes.data.data.stepId).toBe(stepFrame.stepId)

    // The harness attaches a file to its interim: encrypt locally, upload only
    // ciphertext (e2e=true, bot key), seal the ref into the payload, bind the id.
    const interimFileBytes = new TextEncoder().encode(`interim,progress\n${testRunId},50%\n`)
    const interimFileEncrypted = await encryptAttachmentBytes(interimFileBytes)
    const interimUpload = await botUploadFile<{ data: { id: string; filename: string } }>(
      client,
      workspace.id,
      apiKey,
      {
        content: Buffer.from(interimFileEncrypted.ciphertext),
        filename: "encrypted",
        mimeType: "application/octet-stream",
      },
      { e2e: "true" }
    )
    expect(interimUpload.status).toBe(201)
    expect(interimUpload.data.data.filename).toBe("encrypted")
    const interimRef: AttachmentRef = {
      attachmentId: interimUpload.data.data.id,
      key: interimFileEncrypted.key,
      iv: interimFileEncrypted.iv,
      filename: "progress-report.csv",
      mimeType: "text/csv",
      sizeBytes: interimFileBytes.length,
    }

    // Sealed interim message (the channel's `send` tool / permission relay).
    const interimText = "Interim: working on it — sealed progress note."
    const interim = await sealReply(opened.sealing, interimText, { attachmentRefs: [interimRef] })
    const interimRes = await client.request<{ data: { messageId: string } }>(
      "POST",
      `/api/v1/workspaces/${workspace.id}/bot-invocations/${claimed!.id}/sealed-messages`,
      { ...interim, attachmentIds: [interimRef.attachmentId] },
      { Authorization: `Bearer ${apiKey}`, [THREA_CALLBACK_TOKEN_HEADER]: opened.sealing.callbackToken }
    )
    expect(interimRes.status).toBe(200)
    expect(interimRes.data.data.messageId).toBe(interim.messageId)

    // The reply carries its own encrypted attachment the same way.
    const replyFileBytes = new TextEncoder().encode(`--- a/auth.ts\n+++ b/auth.ts ${testRunId}\n`)
    const replyFileEncrypted = await encryptAttachmentBytes(replyFileBytes)
    const replyUpload = await botUploadFile<{ data: { id: string } }>(
      client,
      workspace.id,
      apiKey,
      {
        content: Buffer.from(replyFileEncrypted.ciphertext),
        filename: "encrypted",
        mimeType: "application/octet-stream",
      },
      { e2e: "true" }
    )
    expect(replyUpload.status).toBe(201)
    const replyRef: AttachmentRef = {
      attachmentId: replyUpload.data.data.id,
      key: replyFileEncrypted.key,
      iv: replyFileEncrypted.iv,
      filename: "auth-refactor.patch",
      mimeType: "text/plain",
      sizeBytes: replyFileBytes.length,
    }

    // Sealed completion with the final reply.
    const replyText = "sealed-forty-two done"
    const reply = await sealReply(opened.sealing, replyText, { attachmentRefs: [replyRef] })
    const completeRes = await client.request<{ data: { messageId: string | null } }>(
      "POST",
      `/api/v1/workspaces/${workspace.id}/bot-invocations/${claimed!.id}/sealed-complete`,
      { reply: { ...reply, attachmentIds: [replyRef.attachmentId] } },
      { Authorization: `Bearer ${apiKey}`, [THREA_CALLBACK_TOKEN_HEADER]: opened.sealing.callbackToken }
    )
    expect(completeRes.status).toBe(200)
    expect(completeRes.data.data.messageId).toBe(reply.messageId)

    // The owner reads the stream: every row is placeholder + ciphertext, and
    // the owner's SSK opens each of the harness's messages to the plaintext.
    const eventsRes = await client.get<{ events: WireEvent[] }>(
      `/api/workspaces/${workspace.id}/streams/${rootStreamId}/events`
    )
    expect(eventsRes.status).toBe(200)
    const messageEvents = eventsRes.data.events.filter((event) => event.eventType === "message_created")
    const wire = JSON.stringify(eventsRes.data.events)
    expect(wire).not.toContain("sealed-forty-two")
    expect(wire).not.toContain("Interim: working")
    expect(wire).not.toContain("/etc/hosts")
    // Real attachment names never touch the wire — only placeholder summaries do.
    expect(wire).not.toContain("sealed-spec.md")
    expect(wire).not.toContain("progress-report.csv")
    expect(wire).not.toContain("auth-refactor.patch")

    const openWireMessage = async (messageId: string) => {
      const event = messageEvents.find((candidate) => candidate.payload.messageId === messageId)
      expect(event, `message ${messageId} missing from the stream`).toBeDefined()
      expect(event!.payload.contentMarkdown).toBe(E2E_PLACEHOLDER_CONTENT_MARKDOWN)
      expect(event!.payload.ciphertext).toBeTruthy()
      const raw = await openMessageAsString({
        key: ssk,
        envelope: event!.payload.envelope as StreamEnvelope,
        ciphertext: base64ToBytes(event!.payload.ciphertext!),
      })
      return { payload: parseSealedPayload(raw), event: event! }
    }
    const interimOpened = await openWireMessage(interim.messageId)
    expect(interimOpened.payload.contentMarkdown).toBe(interimText)
    const replyOpened = await openWireMessage(reply.messageId)
    expect(replyOpened.payload.contentMarkdown).toBe(replyText)

    // The bound rows ride the events as placeholder summaries; the sealed refs
    // carry the truth, and the owner's fetch + decrypt recovers the exact bytes.
    expect(replyOpened.event.payload.attachments).toMatchObject([{ id: replyRef.attachmentId, filename: "encrypted" }])
    expect(interimOpened.payload.attachmentRefs).toEqual([interimRef])
    expect(replyOpened.payload.attachmentRefs).toEqual([replyRef])
    const ownerUrlRes = await client.get<{ url: string }>(
      `/api/workspaces/${workspace.id}/attachments/${replyRef.attachmentId}/url`
    )
    expect(ownerUrlRes.status).toBe(200)
    const ownerCiphertext = new Uint8Array(await (await fetch(ownerUrlRes.data.url)).arrayBuffer())
    const ownerDecrypted = await decryptAttachmentBytes({
      ciphertext: ownerCiphertext,
      key: replyRef.key,
      iv: replyRef.iv,
    })
    expect(new TextDecoder().decode(ownerDecrypted)).toBe(`--- a/auth.ts\n+++ b/auth.ts ${testRunId}\n`)
  })
})
