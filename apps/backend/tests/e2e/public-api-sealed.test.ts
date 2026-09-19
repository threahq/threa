/**
 * The public API against an end-to-end-encrypted stream, in both directions: a
 * `streams:read` key recovers the stream key from
 * `GET /streams/{id}/e2e/key-wraps` and opens the bodies that
 * `GET /streams/{id}/messages` returns under `sealed`, and a `messages:write`
 * key posts a body it sealed itself.
 *
 * This is what the CLI and any non-invocation client need — before it, the
 * public API was blind to sealed streams in both directions: reads returned the
 * placeholder with the ciphertext dropped, writes were refused outright, and
 * the only wrap endpoint was the harness-only POST that provisions generation 0.
 *
 * The crypto is the real SDK module (`@threahq/bot-runtime-client`, imported by
 * path like the other sealed tests), so this covers the exact bytes a client
 * runs.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { BotTraits, E2E_PLACEHOLDER_CONTENT_MARKDOWN, WORKSPACE_PERMISSION_SCOPES } from "@threahq/types"
import {
  botApiGet,
  createBot,
  createBotKey,
  createChannel,
  createWorkspace,
  getBaseUrl,
  loginAs,
  TestClient,
} from "../client"
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
import { createTestPool } from "../integration/setup"
import { SealedStreamClient } from "../../../../extensions/bot-runtime-client/src/sealed-stream-client"

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

/** The first-party stream wire, which carries the ciphertext on the event payload. */
interface OwnerWireEvent {
  eventType: string
  payload: {
    messageId?: string
    contentMarkdown?: string
    ciphertext?: string
    envelope?: StreamEnvelope
  }
}

/**
 * A sealed scratchpad with generation-0 wraps for the owner and one bot
 * identity key — the state every sealed public-API call starts from. Built
 * through the real doors (bot-runtime presence + session + wrap provisioning),
 * so what the tests exercise is what a runtime actually produces.
 */
async function setupSealedScratchpad(label: string) {
  const runId = `${label}-${testRunId}`
  const client = new TestClient()
  await loginAs(client, `pub-${runId}@test.com`, "Sealed Reader")
  const workspace = await createWorkspace(client, `Sealed WS ${runId}`)
  // `loginAs` hands back the WorkOS identity; the wraps response names the
  // workspace-scoped user (INV-50), which bootstrap is the source for.
  const bootstrap = await client.get<{ data: { users: Array<{ id: string }> } }>(
    `/api/workspaces/${workspace.id}/bootstrap`
  )
  const ownerUserId = bootstrap.data.data.users[0].id
  const bot = await createBot(client, workspace.id, {
    type: "personal",
    name: `Sealed Bot ${runId}`,
    slug: `${runId}`,
    traits: [BotTraits.ACTIVE_SCRATCHPAD, BotTraits.MENTIONABLE],
  })
  const runtimeKey = await createBotKey(client, workspace.id, bot.id, [
    WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE,
    WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE,
  ])
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
    publicKeyId: `bik_${runId}`,
    publicKeyBase64: bytesToBase64(await exportPublicKey(pair.publicKey)),
    privateKey: pair.privateKey,
  }
  const instanceId = `inst-${runId}`
  const runtimeSessionId = `sess-${runId}`
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
      displayName: `Sealed ${runId}`,
      localCwd: "/tmp/threa-sealed",
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

  return {
    client,
    workspace,
    ownerUserId,
    bot,
    runtimeKey,
    ownerKeyId,
    ownerKeyPair,
    ownerPublicKeyB64,
    bik,
    rootStreamId,
  }
}

describe("public API sealed reads", () => {
  test("a streams:read key recovers the stream key and opens the sealed bodies it lists", async () => {
    const { client, workspace, ownerUserId, bot, ownerKeyPair, ownerKeyId, bik, rootStreamId } =
      await setupSealedScratchpad("read")
    // The reader key holds only the two read scopes a CLI needs — no runtime,
    // no invocation, no write.
    const readKey = await createBotKey(
      client,
      workspace.id,
      bot.id,
      [WORKSPACE_PERMISSION_SCOPES.STREAMS_READ, WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ],
      "sealed-reader"
    )

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

describe("public API sealed sends", () => {
  test("a messages:write key seals a body into the stream and reads it straight back", async () => {
    const { client, workspace, bot, bik, rootStreamId } = await setupSealedScratchpad("send")
    const writeKey = await createBotKey(
      client,
      workspace.id,
      bot.id,
      [
        WORKSPACE_PERMISSION_SCOPES.MESSAGES_WRITE,
        WORKSPACE_PERMISSION_SCOPES.STREAMS_READ,
        WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ,
      ],
      "sealed-writer"
    )

    const wrapsRes = await botApiGet<{ data: WireWraps }>(
      client,
      workspace.id,
      `/streams/${rootStreamId}/e2e/key-wraps`,
      writeKey
    )
    expect(wrapsRes.status).toBe(200)
    const botWrap = wrapsRes.data.data.wraps.find((w) => w.recipientKeyId === bik.publicKeyId)!
    const ssk = await unwrapStreamKey({
      enc: base64ToBytes(botWrap.wrapEnc),
      ct: base64ToBytes(botWrap.wrapCt),
      recipientPrivateKey: bik.privateKey,
      aad: buildWrapAad({ streamId: rootStreamId, keyGeneration: 0, recipientKeyId: bik.publicKeyId }),
    })

    const secret = `sealed-public-send-${testRunId}`
    const sealedBody = await sealMessage({
      key: ssk,
      keyGeneration: wrapsRes.data.data.currentKeyGeneration,
      payload: serializeSealedPayload(secret),
      aad: buildMessageAad({ streamId: rootStreamId, messageId: `msg_pubsend_${testRunId}`, senderId: bot.id }),
    })

    const sent = await client.request<{ data: WireMessage }>(
      "POST",
      `/api/v1/workspaces/${workspace.id}/streams/${rootStreamId}/messages`,
      { sealed: { ciphertext: bytesToBase64(sealedBody.ciphertext), envelope: sealedBody.envelope } },
      { Authorization: `Bearer ${writeKey}` }
    )
    expect(sent.status).toBe(201)
    // The echo carries the placeholder as `content` and the bytes back under
    // `sealed` — the sender never has to re-fetch to reconcile.
    expect(sent.data.data.content).toBe(E2E_PLACEHOLDER_CONTENT_MARKDOWN)
    expect(sent.data.data.sealed?.envelope).toMatchObject({ v: STREAM_ENVELOPE_VERSION, keyGeneration: 0 })

    const listed = await botApiGet<{ data: WireMessage[] }>(
      client,
      workspace.id,
      `/streams/${rootStreamId}/messages`,
      writeKey
    )
    const row = listed.data.data.find((m) => m.id === sent.data.data.id)
    expect(row).toBeDefined()
    const opened = await openMessageAsString({
      key: ssk,
      ciphertext: base64ToBytes(row!.sealed!.ciphertext),
      envelope: row!.sealed!.envelope,
    })
    expect(parseSealedPayload(opened).contentMarkdown).toBe(secret)
  })

  test("a sealed stream refuses a plaintext body", async () => {
    const { client, workspace, bot, rootStreamId } = await setupSealedScratchpad("plainrej")
    const writeKey = await createBotKey(
      client,
      workspace.id,
      bot.id,
      [WORKSPACE_PERMISSION_SCOPES.MESSAGES_WRITE],
      "plain-writer"
    )

    const res = await client.request<{ code: string }>(
      "POST",
      `/api/v1/workspaces/${workspace.id}/streams/${rootStreamId}/messages`,
      { content: "this would land in the clear" },
      { Authorization: `Bearer ${writeKey}` }
    )
    expect(res.status).toBe(400)
    expect(res.data.code).toBe("E2E_STREAM_REQUIRES_CIPHERTEXT")
  })

  test("a plaintext stream refuses a sealed body", async () => {
    const client = new TestClient()
    await loginAs(client, `pub-sealrej-${testRunId}@test.com`, "Seal Rejector")
    const workspace = await createWorkspace(client, `Seal Reject WS ${testRunId}`)
    const channel = await createChannel(client, workspace.id, `sealrej-${testRunId}`, "public")
    const bot = await createBot(client, workspace.id, {
      type: "shared",
      name: `Seal Rejector ${testRunId}`,
      slug: `sealrej-${testRunId}`,
    })
    const writeKey = await createBotKey(client, workspace.id, bot.id, [WORKSPACE_PERMISSION_SCOPES.MESSAGES_WRITE])
    await client.post(`/api/workspaces/${workspace.id}/bots/${bot.id}/streams/${channel.id}/grant`, {})

    const res = await client.request<{ code: string }>(
      "POST",
      `/api/v1/workspaces/${workspace.id}/streams/${channel.id}/messages`,
      {
        sealed: {
          ciphertext: "Y2lwaGVydGV4dA",
          envelope: { v: STREAM_ENVELOPE_VERSION, keyGeneration: 0, iv: "aXY", aad: "YWFk" },
        },
      },
      { Authorization: `Bearer ${writeKey}` }
    )
    expect(res.status).toBe(400)
    expect(res.data.code).toBe("E2E_PAYLOAD_REQUIRES_E2E_STREAM")
  })

  test("a body that is neither plaintext nor sealed is rejected before any write", async () => {
    const { client, workspace, bot, rootStreamId } = await setupSealedScratchpad("bothrej")
    const writeKey = await createBotKey(
      client,
      workspace.id,
      bot.id,
      [WORKSPACE_PERMISSION_SCOPES.MESSAGES_WRITE],
      "both-writer"
    )

    const both = await client.request<{ code: string }>(
      "POST",
      `/api/v1/workspaces/${workspace.id}/streams/${rootStreamId}/messages`,
      {
        content: "plaintext",
        sealed: {
          ciphertext: "Y2lwaGVydGV4dA",
          envelope: { v: STREAM_ENVELOPE_VERSION, keyGeneration: 0, iv: "aXY", aad: "YWFk" },
        },
      },
      { Authorization: `Bearer ${writeKey}` }
    )
    expect(both.status).toBe(400)

    const neither = await client.request<{ code: string }>(
      "POST",
      `/api/v1/workspaces/${workspace.id}/streams/${rootStreamId}/messages`,
      {},
      { Authorization: `Bearer ${writeKey}` }
    )
    expect(neither.status).toBe(400)
  })
})

describe("SealedStreamClient over the public API", () => {
  test("opens what the owner sealed and seals a reply the owner opens", async () => {
    const { client, workspace, ownerUserId, bot, ownerKeyPair, ownerKeyId, bik, rootStreamId } =
      await setupSealedScratchpad("sdk")
    // The scopes a sealed CLI or granted bot holds: read the stream, read its
    // messages, write one back. No runtime, no invocation scope.
    const apiKey = await createBotKey(
      client,
      workspace.id,
      bot.id,
      [
        WORKSPACE_PERMISSION_SCOPES.STREAMS_READ,
        WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ,
        WORKSPACE_PERMISSION_SCOPES.MESSAGES_WRITE,
      ],
      "sdk-client"
    )

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
    const fromOwner = `sdk-owner-${testRunId}`
    const ownerMessageId = `msg_sdkowner_${testRunId}`
    const ownerSealed = await sealMessage({
      key: ownerSsk,
      keyGeneration: 0,
      payload: serializeSealedPayload(fromOwner),
      aad: buildMessageAad({ streamId: rootStreamId, messageId: ownerMessageId, senderId: ownerUserId }),
    })
    const ownerSend = await client.post<{ message: { id: string } }>(`/api/workspaces/${workspace.id}/messages`, {
      streamId: rootStreamId,
      ciphertext: bytesToBase64(ownerSealed.ciphertext),
      envelope: ownerSealed.envelope,
      e2eVersion: 2,
    })
    expect(ownerSend.status).toBe(201)

    // Everything below is the SDK surface a bot author gets: no wrap fetch, no
    // unwrap, no AAD — a key source and two calls.
    const sealedClient = new SealedStreamClient({
      baseUrl: getBaseUrl(),
      apiKey,
      workspaceId: workspace.id,
      keys: { keysForStream: async () => [{ keyId: bik.publicKeyId, privateKey: bik.privateKey }] },
    })

    const page = await sealedClient.readMessages(rootStreamId)
    const read = page.messages.find((m) => m.id === ownerSend.data.message.id)
    expect(read).toMatchObject({ contentMarkdown: fromOwner, authorType: "user", authorId: ownerUserId })

    const fromBot = `sdk-bot-${testRunId}`
    const reply = await sealedClient.sendMessage(rootStreamId, fromBot)

    // The owner reads it back through the first-party wire and opens it with
    // the key it already had — the round trip the two ends actually need.
    const ownerView = await client.get<{ events: OwnerWireEvent[] }>(
      `/api/workspaces/${workspace.id}/streams/${rootStreamId}/events`
    )
    const event = ownerView.data.events.find(
      (candidate) => candidate.eventType === "message_created" && candidate.payload.messageId === reply.messageId
    )
    expect(event).toBeDefined()
    expect(event!.payload.contentMarkdown).toBe(E2E_PLACEHOLDER_CONTENT_MARKDOWN)
    expect(JSON.stringify(ownerView.data.events)).not.toContain(fromBot)
    const opened = await openMessageAsString({
      key: ownerSsk,
      ciphertext: base64ToBytes(event!.payload.ciphertext!),
      envelope: event!.payload.envelope!,
    })
    expect(parseSealedPayload(opened).contentMarkdown).toBe(fromBot)
    // The AAD names the bot the API key belongs to and the id the client
    // minted, so the stored body cannot be replayed under another author or id.
    expect(base64ToBytes(event!.payload.envelope!.aad)).toEqual(
      buildMessageAad({ streamId: rootStreamId, messageId: reply.clientMessageId, senderId: bot.id })
    )
  })
})

/**
 * The door a CLI comes through on a machine that has never run the web app:
 * an API key the user minted themselves fetches their own key, private half
 * included. The bundle is sealed under the user's passphrase, which the server
 * has never held, so what crosses the wire is useless on its own.
 */
describe("public API my encryption key", () => {
  test("hands a user key its own sealed bundle and refuses a bot key", async () => {
    const runId = `mykey-${testRunId}`
    const client = new TestClient()
    const workosUser = await loginAs(client, `${runId}@test.com`, "Key Owner")
    const workspace = await createWorkspace(client, `MyKey WS ${runId}`)

    // User-key auth clamps scopes against the owner's live workspace
    // permissions, and the e2e harness runs without a control-plane to mirror
    // them — without this row every user-key request 401s OWNER_INACTIVE.
    const pool = createTestPool()
    try {
      await pool.query(
        `INSERT INTO workspace_user_permissions (workspace_id, workos_user_id, role_slugs, status, last_event_at)
         VALUES ($1, $2, '{owner}', 'active', now()) ON CONFLICT DO NOTHING`,
        [workspace.id, workosUser.id]
      )
    } finally {
      await pool.end()
    }

    const userKeyRes = await client.post<{ value: string }>(`/api/workspaces/${workspace.id}/user-api-keys`, {
      name: runId,
      scopes: [WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ],
    })
    expect(userKeyRes.status).toBe(201)
    const userKey = userKeyRes.data.value

    // Before setup the route says so, rather than inventing a key.
    const missing = await botApiGet<{ code?: string }>(client, workspace.id, "/me/e2e-key", userKey)
    expect(missing.status).toBe(404)
    expect(missing.data.code).toBe("E2E_KEY_NOT_FOUND")

    const bundle = bytesToBase64(crypto.getRandomValues(new Uint8Array(45)))
    const salt = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)))
    const pair = await generateKeyPair()
    const publicKey = bytesToBase64(await exportPublicKey(pair.publicKey))
    const kdfParams = { algorithm: "argon2id", m: 65536, t: 3, p: 1, version: 19 }
    const setKey = await client.post<{ key: { keyId: string } }>(`/api/workspaces/${workspace.id}/users/me/e2e-key`, {
      publicKey,
      encryptedPrivateBundle: bundle,
      kdfSalt: salt,
      kdfParams,
    })
    expect(setKey.status).toBe(201)

    const mine = await botApiGet<{ data: Record<string, unknown> }>(client, workspace.id, "/me/e2e-key", userKey)
    expect(mine.status).toBe(200)
    expect(mine.data.data).toMatchObject({
      keyId: setKey.data.key.keyId,
      publicKey,
      encryptedPrivateBundle: bundle,
      kdfSalt: salt,
      kdfParams,
    })

    const bot = await createBot(client, workspace.id, {
      type: "personal",
      name: `MyKey Bot ${runId}`,
      slug: runId,
      traits: [BotTraits.MENTIONABLE],
    })
    const botKey = await createBotKey(
      client,
      workspace.id,
      bot.id,
      [WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ],
      "mykey-bot"
    )
    const refused = await botApiGet(client, workspace.id, "/me/e2e-key", botKey)
    expect(refused.status).toBe(403)
  })
})
