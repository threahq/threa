/**
 * The public API's sealed read path, end to end: a `streams:read` +
 * `messages:read` key recovers an E2E scratchpad's stream key from
 * `GET /streams/{id}/e2e/key-wraps` and opens the bodies that
 * `GET /streams/{id}/messages` returns under `sealed`.
 *
 * This is what the CLI and any non-invocation client need — before it, the
 * public API was blind to sealed streams in both directions: reads returned the
 * placeholder with the ciphertext dropped, and the only wrap endpoint was the
 * harness-only POST that provisions generation 0.
 *
 * The crypto is the real SDK module (`@threahq/bot-runtime-client`, imported by
 * path like the other sealed tests), so this covers the exact bytes a client
 * runs.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { BotTraits, E2E_PLACEHOLDER_CONTENT_MARKDOWN, WORKSPACE_PERMISSION_SCOPES } from "@threahq/types"
import { botApiGet, createBot, createBotKey, createChannel, createWorkspace, loginAs, TestClient } from "../client"
import {
  base64ToBytes,
  buildMessageAad,
  buildWrapAad,
  bytesToBase64,
  exportPublicKey,
  generateKeyPair,
  openMessageAsString,
  parseSealedPayload,
  sealMessage,
  serializeSealedPayload,
  STREAM_ENVELOPE_VERSION,
  unwrapStreamKey,
  type StreamEnvelope,
} from "../../../../extensions/bot-runtime-client/src/crypto"
import { mintStreamKeyWraps, type BotIdentityKey } from "../../../../extensions/bot-runtime-client/src/sealed"

setDefaultTimeout(120_000)

const testRunId = Math.random().toString(36).substring(7)

interface WireWraps {
  currentKeyGeneration: number
  ownerUserId: string
  wraps: Array<{
    keyGeneration: number
    recipientKeyId: string
    recipientKind: string
    wrapEnc: string
    wrapCt: string
  }>
}

interface WireMessage {
  id: string
  content: string
  sealed?: { ciphertext: string; envelope: StreamEnvelope }
}

describe("public API sealed reads", () => {
  test("a streams:read key recovers the stream key and opens the sealed bodies it lists", async () => {
    const client = new TestClient()
    await loginAs(client, `pub-sealed-${testRunId}@test.com`, "Sealed Reader")
    const workspace = await createWorkspace(client, `Sealed Read WS ${testRunId}`)
    // `loginAs` hands back the WorkOS identity; the wraps response names the
    // workspace-scoped user (INV-50), which bootstrap is the source for.
    const bootstrap = await client.get<{ data: { users: Array<{ id: string }> } }>(
      `/api/workspaces/${workspace.id}/bootstrap`
    )
    const ownerUserId = bootstrap.data.data.users[0].id
    const bot = await createBot(client, workspace.id, {
      type: "personal",
      name: `Sealed Reader ${testRunId}`,
      slug: `sealed-read-${testRunId}`,
      traits: [BotTraits.ACTIVE_SCRATCHPAD, BotTraits.MENTIONABLE],
    })
    const runtimeKey = await createBotKey(client, workspace.id, bot.id, [
      WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE,
      WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE,
    ])
    // The reader key holds only the two read scopes a CLI needs — no runtime,
    // no invocation, no write.
    const readKey = await createBotKey(
      client,
      workspace.id,
      bot.id,
      [WORKSPACE_PERMISSION_SCOPES.STREAMS_READ, WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ],
      "sealed-reader"
    )

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

    const pair = await generateKeyPair()
    const bik: BotIdentityKey = {
      publicKeyId: `bik_${testRunId}`,
      publicKeyBase64: bytesToBase64(await exportPublicKey(pair.publicKey)),
      privateKey: pair.privateKey,
    }
    const instanceId = `sealed-read-inst-${testRunId}`
    const runtimeSessionId = `sealed-read-sess-${testRunId}`
    await client.request(
      "POST",
      `/api/v1/workspaces/${workspace.id}/bot-runtime/presence`,
      {
        runtimeKind: "claude-code-channel",
        instanceId,
        runtimeSessionId,
        status: "available",
        acceptingInvocations: true,
        publicKey: bik.publicKeyBase64,
        publicKeyId: bik.publicKeyId,
      },
      { Authorization: `Bearer ${runtimeKey}` }
    )

    const session = await client.request<{ data: { rootStreamId: string; e2eEnabled?: boolean } }>(
      "POST",
      `/api/v1/workspaces/${workspace.id}/bot-runtime/sessions`,
      {
        runtimeKind: "claude-code-channel",
        instanceId,
        runtimeSessionId,
        displayName: "Sealed read - e2e",
        localCwd: "/tmp/threa-sealed-read",
        e2e: { ownerKeyId },
      },
      { Authorization: `Bearer ${runtimeKey}` }
    )
    expect(session.status).toBe(200)
    expect(session.data.data.e2eEnabled).toBe(true)
    const rootStreamId = session.data.data.rootStreamId

    const minted = await mintStreamKeyWraps({
      streamId: rootStreamId,
      keyGeneration: 0,
      recipients: [
        { recipientKind: "user", recipientKeyId: ownerKeyId, publicKeyBase64: ownerPublicKeyB64 },
        { recipientKind: "bot", recipientKeyId: bik.publicKeyId, publicKeyBase64: bik.publicKeyBase64 },
      ],
    })
    const provision = await client.request(
      "POST",
      `/api/v1/workspaces/${workspace.id}/streams/${rootStreamId}/e2e/key-wraps`,
      { keyGeneration: 0, wraps: minted.wraps },
      { Authorization: `Bearer ${runtimeKey}` }
    )
    expect(provision.status).toBe(200)

    // The owner seals a message in, through the first-party send path.
    const ownerWrapsRes = await client.get<{ wraps: Array<Record<string, string | number>> }>(
      `/api/workspaces/${workspace.id}/streams/${rootStreamId}/e2e/key-wraps`
    )
    const ownerWrap = ownerWrapsRes.data.wraps.find((w) => w.recipientKeyId === ownerKeyId)!
    const ownerSsk = await unwrapStreamKey({
      enc: base64ToBytes(String(ownerWrap.wrapEnc)),
      ct: base64ToBytes(String(ownerWrap.wrapCt)),
      recipientPrivateKey: ownerKeyPair.privateKey,
      aad: buildWrapAad({ streamId: rootStreamId, keyGeneration: 0, recipientKeyId: ownerKeyId }),
    })
    const secret = `sealed-public-read-${testRunId}`
    const messageId = `msg_pubread_${testRunId}`
    const sealedBody = await sealMessage({
      key: ownerSsk,
      keyGeneration: 0,
      payload: serializeSealedPayload(secret),
      aad: buildMessageAad({ streamId: rootStreamId, messageId, senderId: ownerUserId }),
    })
    const sent = await client.post<{ message: { id: string } }>(`/api/workspaces/${workspace.id}/messages`, {
      streamId: rootStreamId,
      ciphertext: bytesToBase64(sealedBody.ciphertext),
      envelope: sealedBody.envelope,
      e2eVersion: 2,
    })
    expect(sent.status).toBe(201)
    const sentMessageId = sent.data.message.id

    // A message sealed under the pre-stream-key scheme (per-message key fanned
    // out to a recipient list). The web client still reads these; the public
    // wire has no shape for one, so it must ship as the placeholder alone
    // rather than as a `sealed` body no schema describes.
    const fanout = await client.post<{ message: { id: string } }>(`/api/workspaces/${workspace.id}/messages`, {
      streamId: rootStreamId,
      ciphertext: bytesToBase64(sealedBody.ciphertext),
      envelope: {
        v: 1,
        ciphertext: bytesToBase64(sealedBody.ciphertext),
        iv: sealedBody.envelope.iv,
        aad: sealedBody.envelope.aad,
        recipients: [{ recipientKeyId: ownerKeyId, enc: "ZW5j", ct: "Y3Q" }],
      },
      e2eVersion: 1,
    })
    expect(fanout.status).toBe(201)
    const fanoutMessageId = fanout.data.message.id

    // What a CLI actually does, with nothing but the read key: take the wraps,
    // open the one addressed to a key it holds, then decrypt the listed bodies.
    const wrapsRes = await botApiGet<{ data: WireWraps }>(
      client,
      workspace.id,
      `/streams/${rootStreamId}/e2e/key-wraps`,
      readKey
    )
    expect(wrapsRes.status).toBe(200)
    expect(wrapsRes.data.data.currentKeyGeneration).toBe(0)
    expect(wrapsRes.data.data.ownerUserId).toBe(ownerUserId)
    const botWrap = wrapsRes.data.data.wraps.find((w) => w.recipientKeyId === bik.publicKeyId)
    expect(botWrap).toMatchObject({ keyGeneration: 0, recipientKind: "bot" })

    const ssk = await unwrapStreamKey({
      enc: base64ToBytes(botWrap!.wrapEnc),
      ct: base64ToBytes(botWrap!.wrapCt),
      recipientPrivateKey: bik.privateKey,
      aad: buildWrapAad({ streamId: rootStreamId, keyGeneration: 0, recipientKeyId: bik.publicKeyId }),
    })

    const listed = await botApiGet<{ data: WireMessage[] }>(
      client,
      workspace.id,
      `/streams/${rootStreamId}/messages`,
      readKey
    )
    expect(listed.status).toBe(200)
    const row = listed.data.data.find((m) => m.id === sentMessageId)
    expect(row).toBeDefined()
    // The plaintext field still carries only the placeholder the server stores.
    expect(row!.content).toBe(E2E_PLACEHOLDER_CONTENT_MARKDOWN)
    expect(row!.sealed?.envelope).toMatchObject({ v: STREAM_ENVELOPE_VERSION, keyGeneration: 0 })

    const fanoutRow = listed.data.data.find((m) => m.id === fanoutMessageId)
    expect(fanoutRow).toBeDefined()
    expect(fanoutRow!.content).toBe(E2E_PLACEHOLDER_CONTENT_MARKDOWN)
    expect(fanoutRow!.sealed).toBeUndefined()

    const opened = await openMessageAsString({
      key: ssk,
      ciphertext: base64ToBytes(row!.sealed!.ciphertext),
      envelope: row!.sealed!.envelope,
    })
    expect(parseSealedPayload(opened).contentMarkdown).toBe(secret)
  })

  test("a plaintext stream has no wraps to hand out", async () => {
    const client = new TestClient()
    await loginAs(client, `pub-plain-${testRunId}@test.com`, "Plain Reader")
    const workspace = await createWorkspace(client, `Plain Read WS ${testRunId}`)
    const channel = await createChannel(client, workspace.id, `plain-${testRunId}`, "public")
    const bot = await createBot(client, workspace.id, {
      type: "shared",
      name: `Plain Reader ${testRunId}`,
      slug: `plain-read-${testRunId}`,
    })
    const readKey = await createBotKey(client, workspace.id, bot.id, [WORKSPACE_PERMISSION_SCOPES.STREAMS_READ])
    await client.post(`/api/workspaces/${workspace.id}/bots/${bot.id}/streams/${channel.id}/grant`, {})

    const res = await botApiGet<{ code: string }>(client, workspace.id, `/streams/${channel.id}/e2e/key-wraps`, readKey)
    expect(res.status).toBe(400)
    expect(res.data.code).toBe("STREAM_NOT_E2E")
  })
})
