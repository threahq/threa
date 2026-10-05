import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { INTERNAL_API_KEY_HEADER, streamConnectionId } from "@threahq/backend-common"
import {
  BRIDGE_CONVERSATIONS_MAX_IDS,
  BRIDGE_MEMOS_MAX_IDS,
  BRIDGE_PROFILES_MAX_IDS,
  BRIDGE_WORKSPACE_HEADER,
  ConversationStatuses,
  StreamTypes,
  type BridgeChange,
  type BridgeEvents,
  type BridgeManifest,
  type BridgeMessage,
  type JSONContent,
  type StreamConnectionSnapshot,
} from "@threahq/types"
import { StreamRepository } from "../../src/features/streams"
import { ConversationRepository } from "../../src/features/conversations"
import { MemoRepository } from "../../src/features/memos"
import { JobQueues } from "../../src/lib/queue"
import { UserRepository } from "../../src/features/workspaces"
import { conversationId, memoId, streamId, userId, workspaceId } from "../../src/lib/id"
import {
  TestClient,
  addReaction,
  createChannel,
  createThread,
  createWorkspace,
  deleteMessage,
  loginAs,
  moveMessagesToThread,
  sendMessage,
  sendMessageWithAttachments,
  updateMessage,
  updateStream,
  uploadAttachment,
  validateMoveMessagesToThread,
  type Message,
} from "../client"
import { getTestDatabaseTarget } from "../test-database"

const testRunId = Math.random().toString(36).substring(7)
const BRIDGE_KEY = "test-bridge-key"
const MEMO_EMBEDDING = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))

const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content })
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content })
const text = (value: string, marks?: JSONContent["marks"]): JSONContent =>
  marks ? { type: "text", text: value, marks } : { type: "text", text: value }

/** The message fields the API returns that the shared test client leaves untyped. */
type WireMessage = Message & Pick<BridgeMessage, "contentJson" | "authorType" | "revision">

describe("Stream connection bridge", () => {
  let pool: Pool
  let n = 0

  beforeAll(() => {
    pool = new Pool({ connectionString: getTestDatabaseTarget().connectionUrl })
  })

  afterAll(async () => {
    await pool.end()
  })

  /** A host workspace with Connect on, one shared channel, and the partner the channel is shared with. */
  async function setup(options: { partnerWorkspaceId?: string; deferShare?: boolean } = {}) {
    const client = new TestClient()
    n++
    await loginAs(client, `bridge-${n}-${testRunId}@test.com`, "Host Admin")
    const workspace = await createWorkspace(client, `Bridge ${n} ${testRunId}`)
    await setConnectFlag(client, workspace.id, "on")
    const channel = await createChannel(client, workspace.id, `launch-${n}-${testRunId}`, "public")
    const partnerWorkspaceId = options.partnerWorkspaceId ?? workspaceId()
    const connection: StreamConnectionSnapshot = {
      id: streamConnectionId(),
      revision: 2,
      state: "active",
      hostWorkspaceId: workspace.id,
      hostWorkspaceName: workspace.name,
      hostRegion: "eu",
      hostStreamId: channel.id,
      invitedBy: "usr_inviter",
      partnerWorkspaceId,
      partnerWorkspaceName: "Globex",
      partnerRegion: "eu",
      partnerVisibility: "private",
      acceptedBy: "usr_accepter",
      peerWorkspaceIds: [],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }
    const share = () => syncConnection(client, connection)
    if (!options.deferShare) await share()
    const partner = (path: string, headers?: Record<string, string>) =>
      bridgeGet(workspace.id, connection.id, path, headers ?? partnerHeaders(partnerWorkspaceId))
    return { client, workspace, channel, connection, partnerWorkspaceId, partner, share }
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

  function partnerHeaders(callerWorkspaceId: string): Record<string, string> {
    return { [INTERNAL_API_KEY_HEADER]: BRIDGE_KEY, [BRIDGE_WORKSPACE_HEADER]: callerWorkspaceId }
  }

  /** The partner region carries no session, only the bridge credential. */
  function bridgeGet(hostWorkspaceId: string, connectionId: string, path: string, headers: Record<string, string>) {
    return new TestClient().request<unknown>(
      "GET",
      `/api/workspaces/${hostWorkspaceId}/stream-connections/${connectionId}/bridge${path}`,
      undefined,
      headers
    )
  }

  async function manifest(partner: Awaited<ReturnType<typeof setup>>["partner"]): Promise<BridgeManifest> {
    const { status, data } = await partner("/manifest")
    expect({ status }).toEqual({ status: 200 })
    return data as BridgeManifest
  }

  async function events(
    partner: Awaited<ReturnType<typeof setup>>["partner"],
    stream: string,
    query: { after?: string; limit?: number } = {}
  ): Promise<BridgeEvents> {
    const params = new URLSearchParams()
    if (query.after) params.set("after", query.after)
    if (query.limit) params.set("limit", String(query.limit))
    const { status, data } = await partner(`/streams/${stream}/events?${params}`)
    expect({ status, data }).toMatchObject({ status: 200 })
    return data as BridgeEvents
  }

  /** Reads a stream from the start to its head, one page at a time. */
  async function readAll(partner: Awaited<ReturnType<typeof setup>>["partner"], stream: string, limit = 200) {
    const pages: BridgeEvents[] = []
    let after = "0"
    do {
      pages.push(await events(partner, stream, { after, limit }))
      after = pages[pages.length - 1].cursor
    } while (pages[pages.length - 1].hasMore)
    return { changes: pages.flatMap((page) => page.changes), cursor: after, pages: pages.length }
  }

  function exported(sent: Message, overrides: Partial<BridgeMessage> = {}): BridgeChange {
    const message = sent as WireMessage
    return {
      kind: "message",
      message: {
        id: message.id,
        streamId: message.streamId,
        authorId: message.authorId,
        authorType: message.authorType,
        contentJson: message.contentJson,
        contentMarkdown: message.contentMarkdown,
        reactions: message.reactions,
        revision: message.revision,
        editedAt: message.editedAt,
        createdAt: message.createdAt,
        attachments: [],
        clientMessageId: null,
        ...overrides,
      },
    }
  }

  test("should refuse with the same 404 every caller but the connected partner, and any stream outside the tree", async () => {
    const { client, workspace, channel, connection, partnerWorkspaceId, partner } = await setup()
    const other = await createChannel(client, workspace.id, `other-${testRunId}`, "public")
    const anchor = await sendMessage(client, workspace.id, channel.id, "kickoff")
    const cardThread = await StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: workspace.id,
      type: StreamTypes.THREAD,
      parentStreamId: channel.id,
      parentAnchorId: "event_card",
      rootStreamId: channel.id,
      createdBy: anchor.authorId,
    })
    const outcome = async (path: string, headers?: Record<string, string>) => {
      const { status, data } = await partner(path, headers)
      return { status, code: (data as { code?: string }).code }
    }
    const notFound = { status: 404, code: "STREAM_CONNECTION_NOT_FOUND" }
    const unauthorized = { status: 401, code: "UNAUTHORIZED" }

    const refusals = {
      noKey: await outcome("/manifest", { [BRIDGE_WORKSPACE_HEADER]: partnerWorkspaceId }),
      internalKey: await outcome("/manifest", {
        [INTERNAL_API_KEY_HEADER]: "test-internal-key",
        [BRIDGE_WORKSPACE_HEADER]: partnerWorkspaceId,
      }),
      noCaller: await outcome("/manifest", { [INTERNAL_API_KEY_HEADER]: BRIDGE_KEY }),
      otherCaller: await outcome("/manifest", partnerHeaders(workspaceId())),
      otherConnection: await bridgeGet(
        workspace.id,
        streamConnectionId(),
        "/manifest",
        partnerHeaders(partnerWorkspaceId)
      ).then(({ status, data }) => ({ status, code: (data as { code?: string }).code })),
      otherChannel: await outcome(`/streams/${other.id}/events`),
      cardThread: await outcome(`/streams/${cardThread.id}/events`),
    }
    await setConnectFlag(client, workspace.id, "off")
    const flagOff = await outcome("/manifest")
    await setConnectFlag(client, workspace.id, "on")
    const live = await outcome("/manifest")
    await syncConnection(client, { ...connection, revision: connection.revision + 1, state: "revoked" })
    const revoked = await outcome(`/streams/${channel.id}/events`)

    expect({ ...refusals, flagOff, live, revoked }).toEqual({
      noKey: unauthorized,
      internalKey: unauthorized,
      noCaller: notFound,
      otherCaller: notFound,
      otherConnection: notFound,
      otherChannel: notFound,
      cardThread: notFound,
      flagOff: notFound,
      live: { status: 200, code: undefined },
      revoked: notFound,
    })
  })

  test("should refuse the partner's own row, which shares nothing from its side", async () => {
    const partnerClient = new TestClient()
    await loginAs(partnerClient, `bridge-partner-${testRunId}@test.com`, "Partner Admin")
    const partnerWorkspace = await createWorkspace(partnerClient, `Bridge partner ${testRunId}`)
    await setConnectFlag(partnerClient, partnerWorkspace.id, "on")
    const { workspace, connection } = await setup({ partnerWorkspaceId: partnerWorkspace.id })

    const { status, data } = await bridgeGet(
      partnerWorkspace.id,
      connection.id,
      "/manifest",
      partnerHeaders(workspace.id)
    )

    expect({ status, data }).toMatchObject({ status: 404, data: { code: "STREAM_CONNECTION_NOT_FOUND" } })
  })

  test("should share the channel and the threads under its messages at any depth, and nothing else", async () => {
    const { client, workspace, channel, partner } = await setup()
    const other = await createChannel(client, workspace.id, `elsewhere-${testRunId}`, "public")
    const otherRoot = await sendMessage(client, workspace.id, other.id, "elsewhere")
    await createThread(client, workspace.id, other.id, otherRoot.id)
    const root = await sendMessage(client, workspace.id, channel.id, "kickoff")
    const thread = await createThread(client, workspace.id, channel.id, root.id)
    const reply = await sendMessage(client, workspace.id, thread.id, "reply")
    const nested = await createThread(client, workspace.id, thread.id, reply.id)
    await StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: workspace.id,
      type: StreamTypes.THREAD,
      parentStreamId: channel.id,
      parentAnchorId: "event_card",
      rootStreamId: channel.id,
      createdBy: root.authorId,
    })
    const described = await updateStream(client, workspace.id, channel.id, {
      descriptionJson: doc(
        paragraph(
          text("Plans live in "),
          { type: "channelLink", attrs: { id: other.id, slug: other.slug } },
          text(", replies in "),
          { type: "channelLink", attrs: { id: channel.id, slug: channel.slug } }
        )
      ),
    })
    expect(described.status).toBe(200)

    const shared = await manifest(partner)
    const fullReads = await Promise.all(shared.streams.map((stream) => readAll(partner, stream.id)))

    const bare = { slug: null, description: null, descriptionJson: null, archivedAt: null, head: expect.any(String) }
    expect(shared).toEqual({
      streams: [
        {
          id: channel.id,
          parentStreamId: null,
          parentAnchorId: null,
          slug: channel.slug,
          displayName: channel.displayName,
          description: `Plans live in #${other.slug}, replies in [#${channel.slug}](channel:${channel.id})`,
          descriptionJson: doc(
            paragraph(text("Plans live in "), text(`#${other.slug}`), text(", replies in "), {
              type: "channelLink",
              attrs: { id: channel.id, slug: channel.slug },
            })
          ),
          archivedAt: null,
          head: expect.any(String),
        },
        {
          ...bare,
          id: thread.id,
          parentStreamId: channel.id,
          parentAnchorId: root.id,
          displayName: thread.displayName,
        },
        {
          ...bare,
          id: nested.id,
          parentStreamId: thread.id,
          parentAnchorId: reply.id,
          displayName: nested.displayName,
        },
      ],
    })
    // A full read of each stream ends exactly at the head the manifest named.
    expect(fullReads.map((read) => read.cursor)).toEqual(shared.streams.map((stream) => stream.head))
  })

  test("should export each changed message once, as it is now, with the users it names, drop deleted ones, and withhold what the host keeps to itself", async () => {
    const { client, workspace, channel, partner } = await setup()
    const first = await sendMessage(client, workspace.id, channel.id, "first")
    const second = await sendMessage(client, workspace.id, channel.id, "second")
    const doomed = await sendMessage(client, workspace.id, channel.id, "doomed")
    const edited = await updateMessage(client, workspace.id, first.id, "first, edited")
    const reacted = await addReaction(client, workspace.id, second.id, ":+1:")
    await deleteMessage(client, workspace.id, doomed.id)
    await createThread(client, workspace.id, channel.id, second.id)

    const page = await events(partner, channel.id)

    const author = (await UserRepository.findById(pool, workspace.id, first.authorId))!
    expect(page).toEqual({
      changes: [exported(edited), exported(reacted), { kind: "message_removed", messageId: doomed.id }],
      users: [{ id: author.id, name: "Host Admin", slug: author.slug }],
      actors: [],
      cursor: (await manifest(partner)).streams[0].head,
      hasMore: false,
    })
  })

  test("should share messages moved into a thread before the share with the thread, and page past the sequences they vacated", async () => {
    const { client, workspace, channel, partner, share } = await setup({ deferShare: true })
    const anchor = await sendMessage(client, workspace.id, channel.id, "anchor")
    const movedA = await sendMessage(client, workspace.id, channel.id, "moved a")
    const movedB = await sendMessage(client, workspace.id, channel.id, "moved b")
    const stays = await sendMessage(client, workspace.id, channel.id, "stays")
    const { destinationStreamId: threadStreamId } = await moveMessagesToThread(
      client,
      workspace.id,
      channel.id,
      anchor.id,
      [movedA.id, movedB.id]
    )
    await share()

    const heads = new Map((await manifest(partner)).streams.map((stream) => [stream.id, stream.head]))
    const channelRead = await readAll(partner, channel.id, 1)
    const threadRead = await readAll(partner, threadStreamId)
    const caughtUp = await events(partner, channel.id, { after: channelRead.cursor })

    const inThread = (message: Message) => exported(message, { streamId: threadStreamId })
    expect({ channelRead, threadRead, caughtUp }).toEqual({
      channelRead: {
        changes: [
          exported(anchor),
          exported(stays),
          { kind: "message_removed", messageId: movedA.id },
          { kind: "message_removed", messageId: movedB.id },
        ],
        cursor: heads.get(channel.id)!,
        pages: expect.any(Number),
      },
      threadRead: { changes: [inThread(movedA), inThread(movedB)], cursor: heads.get(threadStreamId)!, pages: 1 },
      caughtUp: { changes: [], users: [], actors: [], cursor: heads.get(channel.id)!, hasMore: false },
    })
  })

  test("should refuse to move messages when the channel is shared", async () => {
    const { client, workspace, channel } = await setup()
    const anchor = await sendMessage(client, workspace.id, channel.id, "anchor")
    const moving = await sendMessage(client, workspace.id, channel.id, "moving")

    const { status, data } = await validateMoveMessagesToThread<{ code: string }>(
      client,
      workspace.id,
      channel.id,
      anchor.id,
      [moving.id]
    )

    expect({ status, code: data.code }).toEqual({ status: 403, code: "STREAM_SHARED" })
  })

  test("should record each read as a disclosure to the partner, under its connection", async () => {
    const { client, workspace, channel, connection, partnerWorkspaceId, partner } = await setup()
    const message = await sendMessage(client, workspace.id, channel.id, "hello")

    const page = await events(partner, channel.id)

    let rows: unknown[] = []
    for (let attempt = 0; attempt < 40 && rows.length === 0; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 50))
      ;({ rows } = await pool.query(
        `SELECT actor_type, actor_id, auth_ref, access_kind, outcome, subjects FROM access_log
         WHERE workspace_id = $1 AND operation = 'stream_connections.bridge_events'`,
        [workspace.id]
      ))
    }
    expect(rows).toEqual([
      {
        actor_type: "system",
        actor_id: partnerWorkspaceId,
        auth_ref: connection.id,
        access_kind: "disclose",
        outcome: "success",
        subjects: [
          { type: "stream", id: channel.id, fromSeq: 0, toSeq: Number(page.cursor) },
          { type: "message", id: message.id },
        ],
      },
    ])
  })

  test("should land the partner's message in the host channel and record the write when the partner posts through the bridge", async () => {
    const { workspace, channel, connection, partnerWorkspaceId, partner } = await setup()
    const author = { id: userId(), name: "Pat Partner", slug: "pat" }
    const post = (headers: Record<string, string>) =>
      new TestClient().request<{ messageId: string }>(
        "POST",
        `/api/workspaces/${workspace.id}/stream-connections/${connection.id}/bridge/streams/${channel.id}/messages`,
        { author, users: [], clientMessageId: "client-e2e", contentJson: doc(paragraph(text("hello host"))) },
        headers
      )

    const stranger = await post(partnerHeaders(workspaceId()))
    const sent = await post(partnerHeaders(partnerWorkspaceId))
    const page = await events(partner, channel.id)

    let rows: unknown[] = []
    for (let attempt = 0; attempt < 40 && rows.length === 0; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 50))
      ;({ rows } = await pool.query(
        `SELECT actor_type, actor_id, auth_ref, access_kind, subjects FROM access_log
         WHERE workspace_id = $1 AND operation = 'stream_connections.bridge_send_message' AND outcome = 'success'`,
        [workspace.id]
      ))
    }
    expect({
      statuses: [stranger.status, sent.status],
      messages: page.changes.map((change) =>
        change.kind === "message"
          ? {
              id: change.message.id,
              authorId: change.message.authorId,
              contentMarkdown: change.message.contentMarkdown,
              clientMessageId: change.message.clientMessageId,
            }
          : change
      ),
      users: page.users,
      log: rows,
    }).toEqual({
      statuses: [404, 201],
      messages: [
        {
          id: sent.data.messageId,
          authorId: author.id,
          contentMarkdown: "hello host",
          clientMessageId: "client-e2e",
        },
      ],
      users: [],
      log: [
        {
          actor_type: "system",
          actor_id: partnerWorkspaceId,
          auth_ref: connection.id,
          access_kind: "write",
          subjects: [
            { type: "stream", id: channel.id },
            { type: "message", id: sent.data.messageId },
          ],
        },
      ],
    })
  })

  test("should refuse with 400 and land nothing when the partner posts a document whose nodes aren't nodes", async () => {
    const { workspace, channel, connection, partnerWorkspaceId, partner } = await setup()
    const textNode = (marks: unknown) => ({ type: "paragraph", content: [{ type: "text", text: "x", marks }] })
    const malformed = [
      { type: "paragraph", content: [] },
      { type: "doc", content: "not a list" },
      { type: "doc", content: [null] },
      { type: "doc", content: ["not a node"] },
      { type: "doc", content: [{ content: [] }] },
      { type: "doc", content: [textNode("bold")] },
      { type: "doc", content: [textNode([null])] },
    ]

    const statuses = await Promise.all(
      malformed.map(async (contentJson, index) => {
        const { status } = await new TestClient().request(
          "POST",
          `/api/workspaces/${workspace.id}/stream-connections/${connection.id}/bridge/streams/${channel.id}/messages`,
          {
            author: { id: userId(), name: "Pat Partner", slug: "pat" },
            users: [],
            clientMessageId: `bad-${index}`,
            contentJson,
          },
          partnerHeaders(partnerWorkspaceId)
        )
        return status
      })
    )

    expect({ statuses, changes: (await events(partner, channel.id)).changes }).toEqual({
      statuses: malformed.map(() => 400),
      changes: [],
    })
  })

  test("should hand the partner a url for a shared message's file, refuse a file outside the tree, and record both reads", async () => {
    const { client, workspace, channel, connection, partnerWorkspaceId, partner } = await setup()
    const other = await createChannel(client, workspace.id, `files-${testRunId}`, "private")
    const upload = (name: string, content: string) =>
      uploadAttachment(client, workspace.id, { content, filename: name, mimeType: "text/plain" })
    const shared = await upload("shared.txt", "shared bytes")
    const hidden = await upload("hidden.txt", "hidden bytes")
    await sendMessageWithAttachments(client, workspace.id, channel.id, "file", [shared.id])
    await sendMessageWithAttachments(client, workspace.id, other.id, "file", [hidden.id])

    const served = await partner(`/attachments/${shared.id}`)
    const refused = await partner(`/attachments/${hidden.id}`)

    const { url } = served.data as { url: string }
    expect({
      served: {
        status: served.status,
        answer: (served.data as { status: string }).status,
        bytes: await (await fetch(url)).text(),
      },
      refused: { status: refused.status, code: (refused.data as { code?: string }).code },
    }).toEqual({
      served: { status: 200, answer: "ready", bytes: "shared bytes" },
      refused: { status: 404, code: "STREAM_CONNECTION_NOT_FOUND" },
    })
    let rows: Array<{ outcome: string; subjects: unknown }> = []
    for (let attempt = 0; attempt < 40 && rows.length < 2; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 50))
      ;({ rows } = await pool.query(
        `SELECT actor_id, auth_ref, access_kind, outcome, subjects FROM access_log
         WHERE workspace_id = $1 AND operation = 'stream_connections.bridge_attachment' ORDER BY outcome`,
        [workspace.id]
      ))
    }
    const disclosure = { actor_id: partnerWorkspaceId, auth_ref: connection.id, access_kind: "disclose" }
    expect(rows).toEqual([
      {
        ...disclosure,
        outcome: "denied",
        subjects: [
          { type: "param", id: connection.id },
          { type: "param", id: hidden.id },
        ],
      },
      { ...disclosure, outcome: "success", subjects: [{ type: "attachment", id: shared.id }] },
    ])
  })

  test("should name only the asked members who wrote in the shared channel, refuse a stranger or an oversized page, and record the disclosure", async () => {
    const { client, workspace, channel, connection, partnerWorkspaceId } = await setup()
    const message = await sendMessage(client, workspace.id, channel.id, "hello")
    const ask = (userIds: string[], callerWorkspaceId: string) =>
      new TestClient().request<{ users?: unknown; code?: string }>(
        "POST",
        `/api/workspaces/${workspace.id}/stream-connections/${connection.id}/bridge/profiles`,
        { userIds },
        partnerHeaders(callerWorkspaceId)
      )

    const answered = await ask([message.authorId, userId()], partnerWorkspaceId)
    const stranger = await ask([message.authorId], workspaceId())
    const oversized = await ask(
      Array.from({ length: BRIDGE_PROFILES_MAX_IDS + 1 }, () => userId()),
      partnerWorkspaceId
    )

    let rows: unknown[] = []
    for (let attempt = 0; attempt < 40 && rows.length === 0; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 50))
      ;({ rows } = await pool.query(
        `SELECT actor_id, auth_ref, access_kind, subjects FROM access_log
         WHERE workspace_id = $1 AND operation = 'stream_connections.bridge_profiles' AND outcome = 'success'`,
        [workspace.id]
      ))
    }
    expect({
      answered: { status: answered.status, users: answered.data.users },
      stranger: { status: stranger.status, code: stranger.data.code },
      oversized: oversized.status,
      log: rows,
    }).toEqual({
      answered: { status: 200, users: [{ id: message.authorId, name: "Host Admin", avatar: null }] },
      stranger: { status: 404, code: "STREAM_CONNECTION_NOT_FOUND" },
      oversized: 400,
      log: [
        {
          actor_id: partnerWorkspaceId,
          auth_ref: connection.id,
          access_kind: "disclose",
          subjects: [{ type: "user", id: message.authorId }],
        },
      ],
    })
  })

  test("should queue a refresh of the partner's members when the partner pokes, and refuse a stranger's poke", async () => {
    const { workspace, connection, partnerWorkspaceId } = await setup()
    const poke = (callerWorkspaceId: string) =>
      new TestClient().request(
        "POST",
        `/api/workspaces/${workspace.id}/stream-connections/${connection.id}/bridge/profiles/poke`,
        undefined,
        partnerHeaders(callerWorkspaceId)
      )

    const stranger = await poke(workspaceId())
    const poked = await poke(partnerWorkspaceId)

    const { rows } = await pool.query(
      `SELECT payload FROM queue_messages WHERE queue_name = $1 AND workspace_id = $2`,
      [JobQueues.STREAM_CONNECTION_PROFILES, workspace.id]
    )
    expect({ statuses: [stranger.status, poked.status], jobs: rows }).toEqual({
      statuses: [404, 204],
      jobs: [{ payload: { workspaceId: workspace.id, connectionId: connection.id } }],
    })
  })

  test("should list and return the shared channel's memos to the partner, refuse a stranger or an oversized page, and record each disclosure", async () => {
    const { client, workspace, channel, connection, partnerWorkspaceId } = await setup()
    const message = await sendMessage(client, workspace.id, channel.id, "we ship friday")
    const conversation = conversationId()
    await ConversationRepository.insert(pool, {
      id: conversation,
      streamId: channel.id,
      workspaceId: workspace.id,
      status: ConversationStatuses.RESOLVED,
    })
    const memo = memoId()
    await MemoRepository.insert(pool, {
      id: memo,
      workspaceId: workspace.id,
      memoType: "conversation",
      sourceConversationId: conversation,
      title: "Ship friday",
      abstract: "The team ships on friday.",
      sourceMessageIds: [message.id],
      participantIds: [message.authorId, userId()],
      knowledgeType: "decision",
      sharedRootStreamId: channel.id,
    })
    await MemoRepository.updateEmbedding(pool, workspace.id, memo, MEMO_EMBEDDING)
    const ask = (method: "GET" | "POST", body: unknown, callerWorkspaceId: string) =>
      new TestClient().request<{ memos?: Array<Record<string, unknown>>; code?: string }>(
        method,
        `/api/workspaces/${workspace.id}/stream-connections/${connection.id}/bridge/memos`,
        body,
        partnerHeaders(callerWorkspaceId)
      )

    const index = await ask("GET", undefined, partnerWorkspaceId)
    const bodies = await ask("POST", { memoIds: [memo, memoId()] }, partnerWorkspaceId)
    const strangerIndex = await ask("GET", undefined, workspaceId())
    const strangerBodies = await ask("POST", { memoIds: [memo] }, workspaceId())
    const oversized = await ask(
      "POST",
      { memoIds: Array.from({ length: BRIDGE_MEMOS_MAX_IDS + 1 }, () => memoId()) },
      partnerWorkspaceId
    )

    let rows: unknown[] = []
    for (let attempt = 0; attempt < 40 && rows.length < 2; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 50))
      ;({ rows } = await pool.query(
        `SELECT operation, actor_id, auth_ref, access_kind, subjects FROM access_log
         WHERE workspace_id = $1 AND operation LIKE 'stream_connections.bridge_memo%' AND outcome = 'success'
         ORDER BY operation`,
        [workspace.id]
      ))
    }
    const disclosure = { actor_id: partnerWorkspaceId, auth_ref: connection.id, access_kind: "disclose" }
    expect({
      index: { status: index.status, memos: index.data.memos },
      bodies: {
        status: bodies.status,
        memos: bodies.data.memos?.map(
          ({ embedding, ...rest }): Record<string, unknown> => ({
            ...rest,
            embedding: (embedding as number[]).length,
          })
        ),
      },
      stranger: [strangerIndex, strangerBodies].map(({ status, data }) => ({ status, code: data.code })),
      oversized: oversized.status,
      log: rows,
    }).toEqual({
      index: { status: 200, memos: [{ id: memo, cardVersion: 1 }] },
      bodies: {
        status: 200,
        memos: [
          {
            id: memo,
            conversationId: conversation,
            streamId: channel.id,
            title: "Ship friday",
            abstract: "The team ships on friday.",
            keyPoints: [],
            sourceMessageIds: [message.id],
            participantIds: [message.authorId],
            knowledgeType: "decision",
            tags: [],
            version: 1,
            cardVersion: 1,
            embedding: MEMO_EMBEDDING.length,
            createdAt: expect.any(String),
          },
        ],
      },
      stranger: [
        { status: 404, code: "STREAM_CONNECTION_NOT_FOUND" },
        { status: 404, code: "STREAM_CONNECTION_NOT_FOUND" },
      ],
      oversized: 400,
      log: [
        {
          operation: "stream_connections.bridge_memo_index",
          ...disclosure,
          subjects: [{ type: "memo", id: memo }],
        },
        { operation: "stream_connections.bridge_memos", ...disclosure, subjects: [{ type: "memo", id: memo }] },
      ],
    })
  })

  test("should list and return the shared channel's conversations to the partner as the partner reads them, refuse a stranger or an oversized page, and record each disclosure", async () => {
    const { client, workspace, channel, connection, partnerWorkspaceId } = await setup()
    const message = await sendMessage(client, workspace.id, channel.id, "we ship friday")
    const other = await createChannel(client, workspace.id, `side-${testRunId}`, "private")
    const outside = await sendMessage(client, workspace.id, other.id, "secret")
    const seed = async (overrides: { sharedRootStreamId: string | null }) => {
      const id = conversationId()
      await ConversationRepository.insert(pool, {
        id,
        streamId: channel.id,
        workspaceId: workspace.id,
        topicSummary: "Ship friday",
        topicSummarySource: "generated",
        summary: "The team ships on friday.",
        completenessScore: 4,
        confidence: 0.8,
        status: ConversationStatuses.RESOLVED,
        ...overrides,
      })
      await ConversationRepository.addPrimaryMessages(
        pool,
        workspace.id,
        id,
        [message.id, outside.id],
        [message.authorId, userId()]
      )
      return id
    }
    const shared = await seed({ sharedRootStreamId: channel.id })
    const preShare = await seed({ sharedRootStreamId: null })
    const elsewhere = conversationId()
    await ConversationRepository.insert(pool, { id: elsewhere, streamId: other.id, workspaceId: workspace.id })
    const ask = (method: "GET" | "POST", body: unknown, callerWorkspaceId: string) =>
      new TestClient().request<{ conversations?: Array<Record<string, unknown>>; code?: string }>(
        method,
        `/api/workspaces/${workspace.id}/stream-connections/${connection.id}/bridge/conversations`,
        body,
        partnerHeaders(callerWorkspaceId)
      )

    const index = await ask("GET", undefined, partnerWorkspaceId)
    const bodies = await ask("POST", { conversationIds: [shared, preShare, elsewhere] }, partnerWorkspaceId)
    const strangerIndex = await ask("GET", undefined, workspaceId())
    const strangerBodies = await ask("POST", { conversationIds: [shared] }, workspaceId())
    const oversized = await ask(
      "POST",
      { conversationIds: Array.from({ length: BRIDGE_CONVERSATIONS_MAX_IDS + 1 }, () => conversationId()) },
      partnerWorkspaceId
    )

    let rows: Array<Record<string, unknown>> = []
    for (let attempt = 0; attempt < 40 && rows.length < 2; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 50))
      ;({ rows } = await pool.query(
        `SELECT operation, actor_id, auth_ref, access_kind, subjects FROM access_log
         WHERE workspace_id = $1 AND operation LIKE 'stream_connections.bridge_conversation%' AND outcome = 'success'
         ORDER BY operation`,
        [workspace.id]
      ))
    }
    // Boundary extraction may open its own conversation for the sent message, so only the seeded ones are compared.
    const seeded = new Set([shared, preShare, elsewhere])
    const ours = (items: Array<Record<string, unknown>> = []) =>
      items.filter((item) => seeded.has(String(item.id))).sort((a, b) => String(a.id).localeCompare(String(b.id)))
    const byId = (a: { id: unknown }, b: { id: unknown }) => String(a.id).localeCompare(String(b.id))
    const asPartnerReads = {
      streamId: channel.id,
      topicSummaryRevision: 1,
      summary: "The team ships on friday.",
      status: ConversationStatuses.RESOLVED,
      messageIds: [message.id],
      secondaryMessageIds: [],
      participantIds: [message.authorId],
      completenessScore: 4,
      confidence: 0.8,
      version: 1,
      lastActivityAt: expect.any(String),
      createdAt: expect.any(String),
    }
    const disclosure = { actor_id: partnerWorkspaceId, auth_ref: connection.id, access_kind: "disclose" }
    const subjects = [shared, preShare].map((id) => ({ type: "conversation", id })).sort(byId)
    expect({
      index: { status: index.status, conversations: ours(index.data.conversations) },
      bodies: { status: bodies.status, conversations: ours(bodies.data.conversations) },
      stranger: [strangerIndex, strangerBodies].map(({ status, data }) => ({ status, code: data.code })),
      oversized: oversized.status,
      log: rows.map(
        (row): Record<string, unknown> => ({
          ...row,
          subjects: ours(row.subjects as Array<Record<string, unknown>>),
        })
      ),
    }).toEqual({
      index: {
        status: 200,
        conversations: [
          { id: shared, version: 1 },
          { id: preShare, version: 1 },
        ].sort(byId),
      },
      bodies: {
        status: 200,
        conversations: [
          { id: shared, ...asPartnerReads, topicSummary: "Ship friday", topicSummarySource: "generated" },
          { id: preShare, ...asPartnerReads, topicSummary: null, topicSummarySource: null, summary: null },
        ].sort(byId),
      },
      stranger: [
        { status: 404, code: "STREAM_CONNECTION_NOT_FOUND" },
        { status: 404, code: "STREAM_CONNECTION_NOT_FOUND" },
      ],
      oversized: 400,
      log: [
        { operation: "stream_connections.bridge_conversation_index", ...disclosure, subjects },
        { operation: "stream_connections.bridge_conversations", ...disclosure, subjects },
      ],
    })
  })

  test("should keep pointers that resolve inside the shared tree and flatten or drop the rest", async () => {
    const { client, workspace, channel, partner } = await setup()
    const other = await createChannel(client, workspace.id, `private-${testRunId}`, "private")
    const outside = await sendMessage(client, workspace.id, other.id, "secret")
    const target = await sendMessage(client, workspace.id, channel.id, "target")
    const sharedFile = await uploadAttachment(client, workspace.id, {
      content: "shared",
      filename: "shared.txt",
      mimeType: "text/plain",
    })
    const resentFile = await uploadAttachment(client, workspace.id, {
      content: "resent",
      filename: "resent.txt",
      mimeType: "text/plain",
    })
    const carrier = await sendMessageWithAttachments(client, workspace.id, channel.id, "file", [sharedFile.id])
    await sendMessageWithAttachments(client, workspace.id, other.id, "file", [resentFile.id])
    const bold = [{ type: "bold" }]
    const quote = (message: Message) => ({
      type: "quoteReply",
      attrs: {
        messageId: message.id,
        streamId: message.streamId,
        authorName: "Host Admin",
        authorId: message.authorId,
        actorType: "user",
        snippet: message.contentMarkdown,
        version: 1,
        range: null,
      },
    })
    const share = (message: Message) => ({
      type: "sharedMessage",
      attrs: { messageId: message.id, streamId: message.streamId, authorName: "Host Admin", version: 1, range: null },
    })
    const fileRef = (file: { id: string; filename: string }) => ({
      type: "attachmentReference",
      attrs: { id: file.id, filename: file.filename, mimeType: "text/plain", sizeBytes: 6, status: "uploaded" },
    })
    const inAppLink = (stream: string, name: string, messageId: string | null = null) => ({
      type: "inAppLink",
      attrs: { url: `https://app.threa.io/w/${workspace.id}/s/${stream}`, streamId: stream, messageId, name },
      marks: bold,
    })
    const channelLink = (stream: { id: string; slug: string | null }) => ({
      type: "channelLink",
      attrs: { id: stream.id, slug: stream.slug },
    })
    const sent = await client.post<{ message: Message }>(`/api/workspaces/${workspace.id}/messages`, {
      streamId: channel.id,
      contentJson: doc(
        paragraph(
          channelLink(channel),
          text(" "),
          channelLink(other),
          text(" "),
          inAppLink(channel.id, "Target", target.id),
          text(" "),
          inAppLink(other.id, "Secret", outside.id),
          text(" "),
          inAppLink(channel.id, "Moved off", outside.id),
          text(" "),
          { type: "memoEmbed", attrs: { memoId: "memo_x", title: "Q3 plan" } }
        ),
        share(target),
        share(outside),
        quote(target),
        quote(outside),
        paragraph(fileRef(sharedFile), fileRef(resentFile))
      ),
      confirmedPrivacyWarning: true,
    })
    expect(sent.status).toBe(201)
    const readContent = async () => {
      const page = await events(partner, channel.id, { after: carrier.sequence })
      return (page.changes[0] as Extract<BridgeChange, { kind: "message" }>).message.contentJson
    }
    const expectedContent = (...files: Array<{ id: string; filename: string }>) =>
      doc(
        paragraph(
          channelLink(channel),
          text(" "),
          text(`#${other.slug}`),
          text(" "),
          inAppLink(channel.id, "Target", target.id),
          text(" "),
          text("Secret", bold),
          text(" "),
          text("Moved off", bold),
          text(" "),
          text("Q3 plan")
        ),
        share(target),
        quote(target),
        paragraph(...files.map(fileRef))
      )

    // Referencing a file in the channel lets the channel's readers open it, partners included.
    expect(await readContent()).toEqual(expectedContent(sharedFile, resentFile))

    // Content older than its reference rows points at a file no reader of the tree can open.
    await pool.query("DELETE FROM attachment_references WHERE attachment_id = $1 AND message_id = $2", [
      resentFile.id,
      sent.data.message.id,
    ])
    expect(await readContent()).toEqual(expectedContent(sharedFile))
  })
})
