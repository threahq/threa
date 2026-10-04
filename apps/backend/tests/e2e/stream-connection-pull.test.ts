import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { generateSlug, streamConnectionId } from "@threahq/backend-common"
import { StreamErrorCodes, StreamReadOnlyReasons, Visibilities, type StreamConnectionSnapshot } from "@threahq/types"
import { FeatureFlagService } from "../../src/features/feature-flags"
import { PersonaRepository } from "../../src/features/agents"
import { EventService, MessageRepository } from "../../src/features/messaging"
import {
  BridgeClient,
  StreamConnectionImportService,
  StreamConnectionPullService,
} from "../../src/features/stream-connections"
import { StreamEventRepository, StreamRepository } from "../../src/features/streams"
import { UserRepository } from "../../src/features/workspaces"
import { JobQueues } from "../../src/lib/queue"
import {
  TestClient,
  addReaction,
  archiveStream,
  createChannel,
  createThread,
  createWorkspace,
  deleteMessage,
  getBaseUrl,
  getBootstrap,
  getUserId,
  getWorkspaceBootstrap,
  joinStream,
  joinWorkspace,
  loginAs,
  removeReaction,
  sendMessage,
  updateMessage,
  updateStream,
} from "../client"
import { getTestDatabaseTarget } from "../test-database"

const testRunId = Math.random().toString(36).substring(7)
const BRIDGE_KEY = "test-bridge-key"

describe("Stream connection pull", () => {
  let pool: Pool
  let pullService: StreamConnectionPullService
  let importService: StreamConnectionImportService
  let n = 0

  beforeAll(() => {
    pool = new Pool({ connectionString: getTestDatabaseTarget().connectionUrl })
    const featureFlagService = new FeatureFlagService(pool)
    pullService = new StreamConnectionPullService({
      pool,
      bridgeClient: new BridgeClient({ routerUrl: getBaseUrl(), apiKey: BRIDGE_KEY }),
      featureFlagService,
    })
    importService = new StreamConnectionImportService({ pool, featureFlagService })
  })

  afterAll(async () => {
    await pool.end()
  })

  /** A host and a partner workspace in this region with Connect on, and the host's channel, not shared yet. */
  async function setup() {
    n++
    const hostClient = new TestClient()
    const hostLogin = await loginAs(hostClient, `pull-host-${n}-${testRunId}@test.com`, "Host Admin")
    const host = await createWorkspace(hostClient, `Pull host ${n} ${testRunId}`)
    await setConnectFlag(hostClient, host.id, "on")
    const channel = await createChannel(hostClient, host.id, `pull-${n}-${testRunId}`, "public")

    const partnerClient = new TestClient()
    const partnerLogin = await loginAs(partnerClient, `pull-partner-${n}-${testRunId}@test.com`, "Partner Admin")
    const partner = await createWorkspace(partnerClient, `Pull partner ${n} ${testRunId}`)
    await setConnectFlag(partnerClient, partner.id, "on")

    const hostAdminId = await getUserId(hostClient, host.id, hostLogin.id)
    const accepterId = await getUserId(partnerClient, partner.id, partnerLogin.id)
    const connection: StreamConnectionSnapshot = {
      id: streamConnectionId(),
      revision: 2,
      state: "active",
      hostWorkspaceId: host.id,
      hostWorkspaceName: host.name,
      hostRegion: "local",
      hostStreamId: channel.id,
      invitedBy: hostAdminId,
      partnerWorkspaceId: partner.id,
      partnerWorkspaceName: partner.name,
      partnerRegion: "local",
      partnerVisibility: "private",
      acceptedBy: accepterId,
      peerWorkspaceIds: [],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }
    const share = () => syncConnection(hostClient, connection)
    const ref = { workspaceId: partner.id, connectionId: connection.id }
    return { hostClient, partnerClient, host, partner, channel, connection, hostAdminId, accepterId, share, ref }
  }

  async function setConnectFlag(client: TestClient, wsId: string, value: "on" | "off") {
    const { status } = await client.internalRequest("POST", "/internal/feature-flags", {
      workspaceId: wsId,
      subjectType: "workspace",
      subjectId: wsId,
      overrides: { streamConnections: value },
    })
    expect(status).toBe(204)
  }

  async function syncConnection(client: TestClient, snapshot: StreamConnectionSnapshot) {
    const { status } = await client.internalRequest("POST", "/internal/stream-connections", snapshot)
    expect(status).toBe(204)
  }

  async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    let value = await read()
    while (!done(value) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      value = await read()
    }
    return value
  }

  /** Each message as a reader sees it, null where the workspace has no row. */
  async function messages(wsId: string, ids: string[]) {
    const found = await MessageRepository.findByIds(pool, wsId, ids)
    return ids.map((id) => {
      const message = found.get(id)
      if (!message) return null
      const {
        streamId,
        authorId,
        authorType,
        contentJson,
        contentMarkdown,
        reactions,
        createdAt,
        editedAt,
        deletedAt,
      } = message
      return {
        id,
        streamId,
        authorId,
        authorType,
        contentJson,
        contentMarkdown,
        reactions,
        createdAt,
        editedAt,
        deleted: deletedAt !== null,
      }
    })
  }

  /** Waits until the partner's copies read as the host's messages do, with `absent` never copied. */
  async function copiesMatch(hostId: string, partnerId: string, ids: string[], absent: string[] = []) {
    const expected = (await messages(hostId, ids)).map((message, index) => {
      if (absent.includes(ids[index])) return null
      if (!message) throw new Error(`Host message ${ids[index]} not found`)
      return message
    })
    const copies = await eventually(
      () => messages(partnerId, ids),
      (value) => Bun.deepEquals(value, expected)
    )
    return { copies, expected }
  }

  /** The dense per-stream broadcast numbers a timeline checks for holes (INV-61). */
  async function broadcastSequences(wsId: string, streamId: string) {
    const { rows } = await pool.query<{ seq: string }>(
      `SELECT broadcast_sequence::text AS seq FROM stream_events
       WHERE workspace_id = $1 AND stream_id = $2 AND broadcast_sequence IS NOT NULL
       ORDER BY broadcast_sequence`,
      [wsId, streamId]
    )
    return rows.map((row) => Number(row.seq))
  }

  const dense = (sequences: number[]) => sequences.map((_, index) => index + 1)

  /** The message ordinals a stream's sidebar activity carried, in outbox order. */
  async function activityOrdinals(wsId: string, streamId: string) {
    const { rows } = await pool.query<{ ordinal: number }>(
      `SELECT (payload->>'messageOrdinal')::int AS ordinal FROM outbox
       WHERE event_type = 'stream:activity' AND payload->>'workspaceId' = $1 AND payload->>'streamId' = $2
       ORDER BY id`,
      [wsId, streamId]
    )
    return rows.map((row) => row.ordinal)
  }

  async function copyStream(wsId: string, streamId: string) {
    const stream = await StreamRepository.findById(pool, wsId, streamId)
    if (!stream) return null
    const { type, slug, description, visibility, parentStreamId, rootStreamId, originWorkspaceId, archivedAt } = stream
    return {
      type,
      slug,
      description,
      visibility,
      parentStreamId,
      rootStreamId,
      originWorkspaceId,
      archived: archivedAt !== null,
    }
  }

  /** What a partner's copy of the host's stream should read as. */
  async function expectedCopy(hostId: string, streamId: string) {
    const stream = (await copyStream(hostId, streamId))!
    return { ...stream, visibility: Visibilities.PRIVATE, originWorkspaceId: hostId }
  }

  async function pendingPulls(partnerWorkspaceId: string, connectionId: string) {
    const result = await pool.query(
      `SELECT id FROM queue_messages
       WHERE queue_name = $1 AND workspace_id = $2 AND payload->>'connectionId' = $3
         AND completed_at IS NULL AND dlq_at IS NULL AND cancelled_at IS NULL`,
      [JobQueues.STREAM_CONNECTION_PULL, partnerWorkspaceId, connectionId]
    )
    return result.rows
  }

  /** Waits until an outbox listener has finished the latest event. */
  async function listenerCaughtUp(listenerId: string, timeoutMs = 15_000) {
    const { rows } = await pool.query<{ max: string }>("SELECT COALESCE(MAX(id), 0)::text AS max FROM outbox")
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const listener = await pool.query<{ done: boolean }>(
        `SELECT last_processed_id >= $1::bigint OR processed_ids ? $2 AS done
         FROM outbox_listeners WHERE listener_id = $3`,
        [rows[0].max, rows[0].max, listenerId]
      )
      if (listener.rows[0]?.done) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`Outbox listener ${listenerId} didn't catch up`)
  }

  test("should copy the channel and its threads under the host's ids when the connection turns active", async () => {
    const { hostClient, partnerClient, host, partner, channel, hostAdminId, accepterId, share } = await setup()
    const first = await sendMessage(hostClient, host.id, channel.id, "kickoff")
    const second = await sendMessage(hostClient, host.id, channel.id, "second")
    const doomed = await sendMessage(hostClient, host.id, channel.id, "doomed")
    await updateMessage(hostClient, host.id, first.id, "kickoff, edited")
    await addReaction(hostClient, host.id, second.id, ":+1:")
    await deleteMessage(hostClient, host.id, doomed.id)
    const thread = await createThread(hostClient, host.id, channel.id, second.id)
    const reply = await sendMessage(hostClient, host.id, thread.id, "in the thread")

    await share()

    const ids = [first.id, second.id, doomed.id, reply.id]
    const { copies, expected } = await copiesMatch(host.id, partner.id, ids, [doomed.id])
    const hostAdmin = (await UserRepository.findById(pool, host.id, hostAdminId))!
    const authorCopy = (await UserRepository.findById(pool, partner.id, hostAdminId))!
    const threadRead = await getBootstrap(partnerClient, partner.id, thread.id)
    const timelines = {
      channel: await broadcastSequences(partner.id, channel.id),
      thread: await broadcastSequences(partner.id, thread.id),
    }
    const ordinals = {
      channel: await activityOrdinals(partner.id, channel.id),
      thread: await activityOrdinals(partner.id, thread.id),
    }
    expect({
      copies,
      channel: await copyStream(partner.id, channel.id),
      thread: await copyStream(partner.id, thread.id),
      members: (await getBootstrap(partnerClient, partner.id, channel.id)).members.map((member) => member.memberId),
      threadRead: threadRead.events
        .filter((event) => event.eventType === "message_created")
        .map((event) => (event.payload as { messageId: string }).messageId),
      authorCopy: {
        name: authorCopy.name,
        slug: authorCopy.slug,
        email: authorCopy.email,
        workosUserId: authorCopy.workosUserId,
        origin: (await UserRepository.findOrigins(pool, partner.id, [hostAdminId])).get(hostAdminId),
      },
      timelines,
      ordinals,
    }).toEqual({
      copies: expected,
      channel: await expectedCopy(host.id, channel.id),
      thread: await expectedCopy(host.id, thread.id),
      members: [accepterId],
      threadRead: [reply.id],
      authorCopy: {
        name: "Host Admin",
        slug: `${hostAdmin.slug}-${generateSlug(host.name)}`,
        email: null,
        workosUserId: null,
        origin: host.id,
      },
      timelines: { channel: dense(timelines.channel), thread: dense(timelines.thread) },
      ordinals: { channel: [1, 2], thread: [1] },
    })
  }, 30_000)

  test("should follow the host's edits, deletes, reactions, renames and archive when the host changes the channel", async () => {
    const { hostClient, host, partner, channel, share } = await setup()
    const first = await sendMessage(hostClient, host.id, channel.id, "first")
    const gone = await sendMessage(hostClient, host.id, channel.id, "gone soon")
    await addReaction(hostClient, host.id, first.id, ":eyes:")
    await share()
    await copiesMatch(host.id, partner.id, [first.id, gone.id])

    await updateMessage(hostClient, host.id, first.id, "first, edited")
    await addReaction(hostClient, host.id, first.id, ":tada:")
    await removeReaction(hostClient, host.id, first.id, ":eyes:")
    const second = await sendMessage(hostClient, host.id, channel.id, "second")
    await deleteMessage(hostClient, host.id, gone.id)
    const renamed = `renamed-${n}-${testRunId}`
    const description = "Where the launch happens"
    expect((await updateStream(hostClient, host.id, channel.id, { slug: renamed, description })).status).toBe(200)

    const { copies, expected } = await copiesMatch(host.id, partner.id, [first.id, gone.id, second.id])
    const afterRename = await eventually(
      () => copyStream(partner.id, channel.id),
      (stream) => stream?.slug === renamed && stream.description === description
    )
    await archiveStream(hostClient, host.id, channel.id)
    const afterArchive = await eventually(
      () => copyStream(partner.id, channel.id),
      (stream) => stream?.archived === true
    )

    const timeline = await broadcastSequences(partner.id, channel.id)
    expect({
      copies,
      slug: afterRename?.slug,
      description: afterRename?.description,
      archived: afterArchive?.archived,
      timeline,
    }).toEqual({
      copies: expected,
      slug: renamed,
      description,
      archived: true,
      timeline: dense(timeline),
    })
    expect(expected.map((message) => ({ edited: message?.editedAt !== null, deleted: message?.deleted }))).toEqual([
      { edited: true, deleted: false },
      { edited: false, deleted: true },
      { edited: false, deleted: false },
    ])
  }, 30_000)

  test("should write nothing twice when the partner pulls pages it already applied", async () => {
    const { hostClient, host, partner, channel, connection, ref, share } = await setup()
    const root = await sendMessage(hostClient, host.id, channel.id, "root")
    await addReaction(hostClient, host.id, root.id, ":+1:")
    const thread = await createThread(hostClient, host.id, channel.id, root.id)
    const reply = await sendMessage(hostClient, host.id, thread.id, "reply")
    await share()
    await copiesMatch(host.id, partner.id, [root.id, reply.id])

    const snapshot = async () => {
      const events = await pool.query(
        `SELECT id, stream_id, event_type, sequence::text, broadcast_sequence::text FROM stream_events
         WHERE workspace_id = $1 ORDER BY sequence`,
        [partner.id]
      )
      const cursors = await pool.query(
        `SELECT stream_id, host_sequence::text FROM stream_connection_cursors
         WHERE workspace_id = $1 AND connection_id = $2 ORDER BY stream_id`,
        [partner.id, connection.id]
      )
      return { events: events.rows, cursors: cursors.rows, messages: await messages(partner.id, [root.id, reply.id]) }
    }
    await pullService.pull(ref)
    const before = await snapshot()

    await pool.query(
      `UPDATE stream_connection_cursors SET host_sequence = 0 WHERE workspace_id = $1 AND connection_id = $2`,
      [partner.id, connection.id]
    )
    await pullService.pull(ref)

    expect(await snapshot()).toEqual(before)
  }, 30_000)

  test("should follow a host rewrite of a message nobody edited without marking the copy edited", async () => {
    const { hostClient, host, partner, channel, share } = await setup()
    const message = await sendMessage(hostClient, host.id, channel.id, "before the rewrite")
    await share()
    await copiesMatch(host.id, partner.id, [message.id])

    const rewritten = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "rewritten" }] }] }
    await MessageRepository.rewriteContent(pool, host.id, message.id, rewritten, "rewritten")
    await addReaction(hostClient, host.id, message.id, ":eyes:")

    const { copies, expected } = await copiesMatch(host.id, partner.id, [message.id])
    const copy = await MessageRepository.findById(pool, partner.id, message.id)
    const edits = await pool.query(
      `SELECT id FROM stream_events WHERE workspace_id = $1 AND stream_id = $2 AND event_type = 'message_edited'`,
      [partner.id, channel.id]
    )
    expect({ copies, revision: copy?.revision, edits: edits.rows }).toEqual({
      copies: expected,
      revision: 1,
      edits: [],
    })
    expect(expected[0]).toMatchObject({ contentMarkdown: "rewritten", editedAt: null })
  }, 30_000)

  test("should mark the copy edited when the host edits a message and back between pulls", async () => {
    const { hostClient, partnerClient, host, partner, channel, ref, share } = await setup()
    const message = await sendMessage(hostClient, host.id, channel.id, "as first written")
    await share()
    await copiesMatch(host.id, partner.id, [message.id])

    await setConnectFlag(partnerClient, partner.id, "off")
    await updateMessage(hostClient, host.id, message.id, "changed for a moment")
    await updateMessage(hostClient, host.id, message.id, "as first written")
    await listenerCaughtUp("stream-connection-poke")
    await setConnectFlag(partnerClient, partner.id, "on")
    await pullService.pull(ref)

    const { copies, expected } = await copiesMatch(host.id, partner.id, [message.id])
    expect({ copies, edited: expected[0]?.editedAt !== null }).toEqual({ copies: expected, edited: true })
  }, 30_000)

  test("should copy a message whose author the host has since removed", async () => {
    const { hostClient, host, partner, channel, share } = await setup()
    const leaverClient = new TestClient()
    await loginAs(leaverClient, `pull-leaver-${n}-${testRunId}@test.com`, "Leaver")
    const leaver = await joinWorkspace(leaverClient, host.id)
    await joinStream(leaverClient, host.id, channel.id)
    const farewell = await sendMessage(leaverClient, host.id, channel.id, "signing off")
    const after = await sendMessage(hostClient, host.id, channel.id, "after they left")
    await UserRepository.remove(pool, host.id, leaver.id)

    await share()

    const { copies, expected } = await copiesMatch(host.id, partner.id, [farewell.id, after.id])
    expect({ copies, leaverCopy: await UserRepository.findById(pool, partner.id, leaver.id) }).toEqual({
      copies: expected,
      leaverCopy: null,
    })
  }, 30_000)

  test("should rename a user's copy and keep its slug when the host user's name changes", async () => {
    const { hostClient, host, partner, channel, hostAdminId, share } = await setup()
    const first = await sendMessage(hostClient, host.id, channel.id, "first")
    await share()
    await copiesMatch(host.id, partner.id, [first.id])
    const before = (await UserRepository.findById(pool, partner.id, hostAdminId))!

    await UserRepository.update(pool, host.id, hostAdminId, { name: "Host Renamed" })
    const second = await sendMessage(hostClient, host.id, channel.id, "second")
    await copiesMatch(host.id, partner.id, [second.id])

    const renamed = (await UserRepository.findById(pool, partner.id, hostAdminId))!
    expect({ name: renamed.name, slug: renamed.slug }).toEqual({ name: "Host Renamed", slug: before.slug })
  }, 30_000)

  test("should copy each change once and leave every cursor at the host's head when pulls run at the same time", async () => {
    const { hostClient, partnerClient, host, partner, channel, connection, ref, share } = await setup()
    await setConnectFlag(partnerClient, partner.id, "off")
    const root = await sendMessage(hostClient, host.id, channel.id, "root")
    await addReaction(hostClient, host.id, root.id, ":+1:")
    const thread = await createThread(hostClient, host.id, channel.id, root.id)
    const reply = await sendMessage(hostClient, host.id, thread.id, "reply")
    await share()
    await setConnectFlag(partnerClient, partner.id, "on")

    await Promise.all([pullService.pull(ref), pullService.pull(ref), pullService.pull(ref)])

    const { copies, expected } = await copiesMatch(host.id, partner.id, [root.id, reply.id])
    const writes = await pool.query<{ write: string }>(
      `SELECT event_type || ':' || (payload->>'messageId') AS write FROM stream_events
       WHERE workspace_id = $1 AND stream_id = ANY($2) AND event_type IN ('message_created', 'reaction_added')`,
      [partner.id, [channel.id, thread.id]]
    )
    const cursors = await pool.query<{ stream_id: string; host_sequence: string }>(
      `SELECT stream_id, host_sequence::text FROM stream_connection_cursors
       WHERE workspace_id = $1 AND connection_id = $2`,
      [partner.id, connection.id]
    )
    const heads = await StreamEventRepository.listHeadSequences(pool, host.id, [channel.id, thread.id])
    expect({
      copies,
      writes: writes.rows.map((row) => row.write).sort(),
      cursors: Object.fromEntries(cursors.rows.map((row) => [row.stream_id, row.host_sequence])),
    }).toEqual({
      copies: expected,
      writes: [`message_created:${reply.id}`, `message_created:${root.id}`, `reaction_added:${root.id}`].sort(),
      cursors: Object.fromEntries([...heads].map(([streamId, head]) => [streamId, head.toString()])),
    })
  }, 30_000)

  test("should refuse a partner member's writes into the copy", async () => {
    const { hostClient, partnerClient, host, partner, channel, share } = await setup()
    const root = await sendMessage(hostClient, host.id, channel.id, "root")
    await share()
    await copiesMatch(host.id, partner.id, [root.id])

    const refusal = async (request: Promise<{ status: number; data: unknown }>) => {
      const { status, data } = await request
      const { code, details } = data as { code?: string; details?: unknown }
      return { status, code, details }
    }
    const readOnly = {
      status: 403,
      code: StreamErrorCodes.READ_ONLY,
      details: { reason: StreamReadOnlyReasons.SHARED_COPY },
    }

    expect({
      send: await refusal(
        partnerClient.post(`/api/workspaces/${partner.id}/messages`, { streamId: channel.id, content: "hi" })
      ),
      thread: await refusal(
        partnerClient.post(`/api/workspaces/${partner.id}/streams`, {
          type: "thread",
          parentStreamId: channel.id,
          parentAnchorId: root.id,
        })
      ),
      react: await refusal(
        partnerClient.post(`/api/workspaces/${partner.id}/messages/${root.id}/reactions`, { emoji: ":+1:" })
      ),
      archive: await refusal(partnerClient.post(`/api/workspaces/${partner.id}/streams/${channel.id}/archive`)),
    }).toEqual({ send: readOnly, thread: readOnly, react: readOnly, archive: readOnly })
  }, 30_000)

  test("should record no emoji use in the partner workspace when copies carry emoji", async () => {
    const { hostClient, host, partner, channel, share } = await setup()
    const message = await sendMessage(hostClient, host.id, channel.id, "launch :tada:")
    await addReaction(hostClient, host.id, message.id, ":rocket:")
    await share()
    await copiesMatch(host.id, partner.id, [message.id])

    await listenerCaughtUp("emoji-usage")

    const usage = async (wsId: string) =>
      (
        await pool.query<{ shortcode: string }>(
          `SELECT shortcode FROM emoji_usage WHERE workspace_id = $1 ORDER BY shortcode`,
          [wsId]
        )
      ).rows.map((row) => row.shortcode)
    expect({ host: await usage(host.id), partner: await usage(partner.id) }).toEqual({
      host: ["rocket", "tada"],
      partner: [],
    })
  }, 30_000)

  test("should copy a change whose poke was refused once the sweep runs", async () => {
    const { hostClient, partnerClient, host, partner, channel, connection, share } = await setup()
    const first = await sendMessage(hostClient, host.id, channel.id, "first")
    await share()
    await copiesMatch(host.id, partner.id, [first.id])
    await eventually(
      () => pendingPulls(partner.id, connection.id),
      (rows) => rows.length === 0
    )

    await setConnectFlag(partnerClient, partner.id, "off")
    const missed = await sendMessage(hostClient, host.id, channel.id, "while the partner had Connect off")
    await listenerCaughtUp("stream-connection-poke")
    await setConnectFlag(partnerClient, partner.id, "on")
    const beforeSweep = {
      queued: await pendingPulls(partner.id, connection.id),
      copy: await messages(partner.id, [missed.id]),
    }

    await importService.enqueueAllPulls()

    const { copies, expected } = await copiesMatch(host.id, partner.id, [missed.id])
    expect({ beforeSweep, copies }).toEqual({ beforeSweep: { queued: [], copy: [null] }, copies: expected })
  }, 30_000)

  test("should serve the host persona's name in the partner's bootstrap when it wrote in the shared channel", async () => {
    const { hostClient, partnerClient, host, partner, channel, share, ref } = await setup()
    await sendMessage(hostClient, host.id, channel.id, "kickoff")
    const persona = await PersonaRepository.insertWorkspacePersona(pool, {
      workspaceId: host.id,
      slug: `helper-${n}-${testRunId}`,
      config: {
        name: "Host Helper",
        description: null,
        avatarEmoji: ":robot_face:",
        systemPrompt: "Base system prompt",
        model: "openai/gpt-5.4",
        escalationModel: null,
        temperature: null,
        maxTokens: null,
        enabledTools: [],
        tonePrompt: null,
        brevityPrompt: null,
      },
    })
    await new EventService(pool).createMessage({
      workspaceId: host.id,
      streamId: channel.id,
      authorId: persona.id,
      authorType: "persona",
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "from the helper" }] }],
      },
      contentMarkdown: "from the helper",
    })
    await share()
    await pullService.pull(ref)

    const bootstrap = await getWorkspaceBootstrap(partnerClient, partner.id)

    expect({
      actorCopies: bootstrap.actorCopies,
      listedAsPersona: bootstrap.personas.some((candidate) => candidate.id === persona.id),
    }).toEqual({
      actorCopies: [
        {
          id: persona.id,
          workspaceId: partner.id,
          originWorkspaceId: host.id,
          name: "Host Helper",
          avatarEmoji: ":robot_face:",
        },
      ],
      listedAsPersona: false,
    })
  }, 30_000)

  test("should copy nothing while the partner has Connect off or the connection is revoked", async () => {
    const { hostClient, partnerClient, host, partner, channel, connection, ref, share } = await setup()
    await setConnectFlag(partnerClient, partner.id, "off")
    const early = await sendMessage(hostClient, host.id, channel.id, "early")
    await share()
    await pullService.pull(ref)
    const whileOff = await copyStream(partner.id, channel.id)

    await setConnectFlag(partnerClient, partner.id, "on")
    await pullService.pull(ref)
    await copiesMatch(host.id, partner.id, [early.id])
    await syncConnection(hostClient, { ...connection, revision: connection.revision + 1, state: "revoked" })
    const late = await sendMessage(hostClient, host.id, channel.id, "after the revoke")
    await pullService.pull(ref)

    expect({ whileOff, afterRevoke: await messages(partner.id, [late.id]) }).toEqual({
      whileOff: null,
      afterRevoke: [null],
    })
  }, 30_000)
})
