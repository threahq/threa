import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { INTERNAL_API_KEY_HEADER, streamConnectionId } from "@threahq/backend-common"
import {
  BRIDGE_WORKSPACE_HEADER,
  StreamTypes,
  type BridgeChange,
  type BridgeEvents,
  type BridgeManifest,
  type BridgeMessage,
  type JSONContent,
  type StreamConnectionSnapshot,
} from "@threahq/types"
import { StreamRepository } from "../../src/features/streams"
import { UserRepository } from "../../src/features/workspaces"
import { streamId, userId, workspaceId } from "../../src/lib/id"
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
