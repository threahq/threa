import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { streamConnectionId } from "@threahq/backend-common"
import {
  StreamConnectionErrorCodes,
  StreamErrorCodes,
  StreamReadOnlyReasons,
  Visibilities,
  type StreamConnectionSnapshot,
  type Visibility,
} from "@threahq/types"
import { MessageRepository } from "../../src/features/messaging"
import { StreamRepository } from "../../src/features/streams"
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
  getUserId,
  joinWorkspace,
  loginAs,
  removeReaction,
  sendMessage,
  updateMessage,
} from "../client"
import { getTestDatabaseTarget } from "../test-database"

const testRunId = Math.random().toString(36).substring(7)

describe("Stream connection partner writes", () => {
  let pool: Pool
  let n = 0

  beforeAll(() => {
    pool = new Pool({ connectionString: getTestDatabaseTarget().connectionUrl })
  })

  afterAll(async () => {
    await pool.end()
  })

  /** A host channel shared with a partner workspace and copied there, with one host message `root` in it. */
  async function setup(options: { partnerVisibility?: Visibility } = {}) {
    n++
    const hostClient = new TestClient()
    const hostLogin = await loginAs(hostClient, `write-host-${n}-${testRunId}@test.com`, "Host Admin")
    const host = await createWorkspace(hostClient, `Write host ${n} ${testRunId}`)
    await setConnectFlag(hostClient, host.id, "on")
    const channel = await createChannel(hostClient, host.id, `write-${n}-${testRunId}`, "public")

    const partnerClient = new TestClient()
    const partnerLogin = await loginAs(partnerClient, `write-partner-${n}-${testRunId}@test.com`, "Partner Admin")
    const partner = await createWorkspace(partnerClient, `Write partner ${n} ${testRunId}`)
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
      partnerVisibility: options.partnerVisibility ?? Visibilities.PRIVATE,
      acceptedBy: accepterId,
      peerWorkspaceIds: [],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }
    const root = await sendMessage(hostClient, host.id, channel.id, "root")
    const { status } = await hostClient.internalRequest("POST", "/internal/stream-connections", connection)
    expect(status).toBe(204)
    await eventually(
      () => view(partner.id, root.id),
      (copy) => copy !== null
    )
    return { hostClient, partnerClient, host, partner, channel, connection, hostAdminId, accepterId, root }
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

  async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    let value = await read()
    while (!done(value) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      value = await read()
    }
    return value
  }

  /** The message as a reader in the workspace sees it, null where the workspace has no row. */
  async function view(wsId: string, id: string) {
    const message = (await MessageRepository.findByIds(pool, wsId, [id])).get(id)
    if (!message) return null
    const { streamId, authorId, contentMarkdown, clientMessageId, reactions, editedAt, deletedAt } = message
    return {
      streamId,
      authorId,
      contentMarkdown,
      clientMessageId,
      reactions,
      edited: editedAt !== null,
      deleted: deletedAt !== null,
    }
  }

  async function messageIdsWithClientId(wsId: string, streamId: string, clientMessageId: string) {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM messages WHERE workspace_id = $1 AND stream_id = $2 AND client_message_id = $3`,
      [wsId, streamId, clientMessageId]
    )
    return rows.map((row) => row.id)
  }

  async function messageCount(wsId: string, streamId: string) {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM messages WHERE workspace_id = $1 AND stream_id = $2`,
      [wsId, streamId]
    )
    return Number(rows[0].count)
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

  const send = (client: TestClient, wsId: string, streamId: string, body: Record<string, unknown>) =>
    client.post<{ message: { id: string; streamId: string; authorId: string; contentMarkdown: string } }>(
      `/api/workspaces/${wsId}/messages`,
      { streamId, ...body }
    )

  const refusal = async (request: Promise<{ status: number; data: unknown }>) => {
    const { status, data } = await request
    const { code, details } = data as { code?: string; details?: unknown }
    return { status, code, details }
  }

  const readOnly = (reason: string) => ({
    status: 403,
    code: StreamErrorCodes.READ_ONLY,
    details: { reason },
  })

  test("should land a partner's message on the host and back in the copy when a partner member sends in the copy", async () => {
    const { partnerClient, host, partner, channel, accepterId } = await setup()
    const clientMessageId = `cm_${testRunId}_land`

    const { status, data } = await send(partnerClient, partner.id, channel.id, {
      content: "hello from the partner",
      clientMessageId,
    })

    const id = data.message.id
    const written = {
      streamId: channel.id,
      authorId: accepterId,
      contentMarkdown: "hello from the partner",
      clientMessageId,
      reactions: {},
      edited: false,
      deleted: false,
    }
    expect({
      status,
      response: {
        streamId: data.message.streamId,
        authorId: data.message.authorId,
        contentMarkdown: data.message.contentMarkdown,
      },
      host: await view(host.id, id),
      copy: await view(partner.id, id),
      hostAuthorOrigin: (await UserRepository.findOrigins(pool, host.id, [accepterId])).get(accepterId),
    }).toEqual({
      status: 201,
      response: { streamId: channel.id, authorId: accepterId, contentMarkdown: "hello from the partner" },
      host: written,
      copy: written,
      hostAuthorOrigin: partner.id,
    })
  }, 30_000)

  test("should create one host message when the same clientMessageId is sent twice", async () => {
    const { partnerClient, host, partner, channel } = await setup()
    const clientMessageId = `cm_${testRunId}_twice`
    const body = { content: "once only", clientMessageId }

    const first = await send(partnerClient, partner.id, channel.id, body)
    const second = await send(partnerClient, partner.id, channel.id, body)

    expect({
      statuses: [first.status, second.status],
      sameMessage: first.data.message.id === second.data.message.id,
      host: await messageIdsWithClientId(host.id, channel.id, clientMessageId),
      copy: await messageIdsWithClientId(partner.id, channel.id, clientMessageId),
    }).toEqual({
      statuses: [201, 201],
      sameMessage: true,
      host: [first.data.message.id],
      copy: [first.data.message.id],
    })
  }, 30_000)

  test("should edit, react, unreact and delete through the host when the partner author does it", async () => {
    const { partnerClient, host, partner, channel, accepterId } = await setup()
    const clientMessageId = `cm_${testRunId}_lifecycle`
    const { data } = await send(partnerClient, partner.id, channel.id, { content: "first draft", clientMessageId })
    const id = data.message.id
    const both = async () => ({ host: await view(host.id, id), copy: await view(partner.id, id) })

    const edited = await updateMessage(partnerClient, partner.id, id, "second draft")
    const afterEdit = await both()
    const reacted = await addReaction(partnerClient, partner.id, id, ":+1:")
    const afterReact = await both()
    const unreacted = await removeReaction(partnerClient, partner.id, id, ":+1:")
    const afterUnreact = await both()
    await deleteMessage(partnerClient, partner.id, id)
    const afterDelete = await both()

    const live = (overrides: Partial<NonNullable<Awaited<ReturnType<typeof view>>>>) => ({
      streamId: channel.id,
      authorId: accepterId,
      contentMarkdown: "second draft",
      clientMessageId,
      reactions: {},
      edited: true,
      deleted: false,
      ...overrides,
    })
    const states = (state: ReturnType<typeof live>) => ({ host: state, copy: state })
    expect({
      responses: {
        edited: edited.contentMarkdown,
        reacted: reacted.reactions,
        unreacted: unreacted.reactions,
      },
      afterEdit,
      afterReact,
      afterUnreact,
      afterDelete,
    }).toEqual({
      responses: { edited: "second draft", reacted: { ":+1:": [accepterId] }, unreacted: {} },
      afterEdit: states(live({})),
      afterReact: states(live({ reactions: { ":+1:": [accepterId] } })),
      afterUnreact: states(live({})),
      afterDelete: states(live({ deleted: true })),
    })
  }, 30_000)

  test("should show a partner member's reaction on both sides when the member reacts to a host message", async () => {
    const { partnerClient, host, partner, root, accepterId } = await setup()
    const reactions = async () => ({
      host: (await view(host.id, root.id))?.reactions,
      copy: (await view(partner.id, root.id))?.reactions,
    })

    const reacted = await addReaction(partnerClient, partner.id, root.id, ":+1:")
    const afterReact = await reactions()
    const unreacted = await removeReaction(partnerClient, partner.id, root.id, ":+1:")
    const afterUnreact = await reactions()

    expect({ reacted: reacted.reactions, afterReact, unreacted: unreacted.reactions, afterUnreact }).toEqual({
      reacted: { ":+1:": [accepterId] },
      afterReact: { host: { ":+1:": [accepterId] }, copy: { ":+1:": [accepterId] } },
      unreacted: {},
      afterUnreact: { host: {}, copy: {} },
    })
  }, 30_000)

  test("should refuse with 403 FORBIDDEN when a partner member edits a host user's message", async () => {
    const { partnerClient, host, partner, root } = await setup()

    const { status, data } = await partnerClient.patch<{ code: string }>(
      `/api/workspaces/${partner.id}/messages/${root.id}`,
      { content: "hijacked" }
    )

    expect({ status, code: data.code, hostMessage: await view(host.id, root.id) }).toEqual({
      status: 403,
      code: "FORBIDDEN",
      hostMessage: expect.objectContaining({ contentMarkdown: "root", edited: false }),
    })
  }, 30_000)

  test("should refuse with READ_ONLY when the host archived the channel and the copy has pulled the archive", async () => {
    const { hostClient, partnerClient, host, partner, channel } = await setup()
    const mine = await send(partnerClient, partner.id, channel.id, {
      content: "before the archive",
      clientMessageId: `cm_${testRunId}_before`,
    })
    await archiveStream(hostClient, host.id, channel.id)
    await eventually(
      () => StreamRepository.findById(pool, partner.id, channel.id),
      (copy) => copy?.archivedAt !== null
    )
    const hostCount = await messageCount(host.id, channel.id)

    const refused = {
      send: await refusal(
        send(partnerClient, partner.id, channel.id, { content: "too late", clientMessageId: `cm_${testRunId}_late` })
      ),
      edit: await refusal(
        partnerClient.patch(`/api/workspaces/${partner.id}/messages/${mine.data.message.id}`, { content: "edited" })
      ),
      react: await refusal(
        partnerClient.post(`/api/workspaces/${partner.id}/messages/${mine.data.message.id}/reactions`, {
          emoji: ":+1:",
        })
      ),
      delete: await refusal(partnerClient.delete(`/api/workspaces/${partner.id}/messages/${mine.data.message.id}`)),
    }

    const archived = readOnly(StreamReadOnlyReasons.ARCHIVED)
    expect({ refused, hostCount: await messageCount(host.id, channel.id) }).toEqual({
      refused: { send: archived, edit: archived, react: archived, delete: archived },
      hostCount,
    })
  }, 30_000)

  test("should refuse with WRITE_REFUSED when the host archived the channel before the copy pulled it", async () => {
    const { hostClient, partnerClient, host, partner, channel, connection } = await setup()
    await eventually(
      () => pendingPulls(partner.id, connection.id),
      (pending) => pending.length === 0
    )
    // With Connect off the poke is refused and no pull runs, so the copy stays unarchived while the host is not.
    await setConnectFlag(partnerClient, partner.id, "off")
    await archiveStream(hostClient, host.id, channel.id)
    await listenerCaughtUp("stream-connection-poke")
    await setConnectFlag(partnerClient, partner.id, "on")
    const clientMessageId = `cm_${testRunId}_stale`
    const hostCount = await messageCount(host.id, channel.id)

    const refused = await refusal(send(partnerClient, partner.id, channel.id, { content: "stale", clientMessageId }))

    expect({
      refused,
      copyArchived: (await StreamRepository.findById(pool, partner.id, channel.id))?.archivedAt !== null,
      hostCount: await messageCount(host.id, channel.id),
    }).toEqual({
      refused: { status: 403, code: StreamConnectionErrorCodes.WRITE_REFUSED, details: undefined },
      copyArchived: false,
      hostCount,
    })
  }, 30_000)

  test("should refuse with READ_ONLY NOT_A_MEMBER when a partner workspace user who isn't a member of the copy sends", async () => {
    const { host, partner, channel } = await setup({ partnerVisibility: Visibilities.PUBLIC })
    const outsiderClient = new TestClient()
    await loginAs(outsiderClient, `write-outsider-${n}-${testRunId}@test.com`, "Outsider")
    await joinWorkspace(outsiderClient, partner.id)
    const hostCount = await messageCount(host.id, channel.id)

    const refused = await refusal(
      send(outsiderClient, partner.id, channel.id, { content: "let me in", clientMessageId: `cm_${testRunId}_out` })
    )

    expect({ refused, hostCount: await messageCount(host.id, channel.id) }).toEqual({
      refused: readOnly(StreamReadOnlyReasons.NOT_A_MEMBER),
      hostCount,
    })
  }, 30_000)

  test("should refuse with COPY_WRITE_UNSUPPORTED when a partner member sends something the host can't carry", async () => {
    const { partnerClient, host, partner, channel } = await setup()
    const hostCount = await messageCount(host.id, channel.id)
    const attempt = (body: Record<string, unknown>) =>
      refusal(send(partnerClient, partner.id, channel.id, { clientMessageId: `cm_${testRunId}_${n}`, ...body }))

    const refused = {
      noClientMessageId: await refusal(send(partnerClient, partner.id, channel.id, { content: "no key" })),
      steer: await attempt({ content: "steering", steer: true }),
      files: await attempt({ content: "with a file", attachmentIds: ["attach_unknown"] }),
      metadata: await attempt({ content: "tagged", metadata: { ticket: "T-1" } }),
      conversation: await attempt({ content: "grouped", conversation: { intent: "new" } }),
      command: await attempt({
        contentJson: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "command", attrs: { name: "invite", args: "@someone" } }] }],
        },
      }),
    }

    const unsupported = { status: 400, code: StreamConnectionErrorCodes.COPY_WRITE_UNSUPPORTED, details: undefined }
    expect({ refused, hostCount: await messageCount(host.id, channel.id) }).toEqual({
      refused: {
        noClientMessageId: unsupported,
        steer: unsupported,
        files: unsupported,
        metadata: unsupported,
        conversation: unsupported,
        command: unsupported,
      },
      hostCount,
    })
  }, 30_000)

  /** A thread under the host's `root`, with one host reply, copied to the partner. */
  async function setupThread(options: { partnerVisibility?: Visibility } = {}) {
    const shared = await setup(options)
    const thread = await createThread(shared.hostClient, shared.host.id, shared.channel.id, shared.root.id)
    const reply = await sendMessage(shared.hostClient, shared.host.id, thread.id, "host reply")
    await eventually(
      () => view(shared.partner.id, reply.id),
      (copy) => copy !== null
    )
    return { ...shared, thread }
  }

  test("should land a partner member's reply on the host and in the thread copy when the member replies in a thread of the copy", async () => {
    const { partnerClient, host, partner, thread, accepterId } = await setupThread()
    const clientMessageId = `cm_${testRunId}_thread`

    const { status, data } = await send(partnerClient, partner.id, thread.id, {
      content: "reply from the partner",
      clientMessageId,
    })

    const written = {
      streamId: thread.id,
      authorId: accepterId,
      contentMarkdown: "reply from the partner",
      clientMessageId,
      reactions: {},
      edited: false,
      deleted: false,
    }
    expect({
      status,
      host: await view(host.id, data.message.id),
      copy: await view(partner.id, data.message.id),
    }).toEqual({ status: 201, host: written, copy: written })
  }, 30_000)

  test("should refuse with READ_ONLY NOT_A_MEMBER when a partner workspace user who isn't a member of the copy replies in its thread", async () => {
    const { host, partner, thread } = await setupThread({ partnerVisibility: Visibilities.PUBLIC })
    const outsiderClient = new TestClient()
    await loginAs(outsiderClient, `write-thread-outsider-${n}-${testRunId}@test.com`, "Outsider")
    await joinWorkspace(outsiderClient, partner.id)
    const hostCount = await messageCount(host.id, thread.id)

    const refused = await refusal(
      send(outsiderClient, partner.id, thread.id, { content: "let me in", clientMessageId: `cm_${testRunId}_tout` })
    )

    expect({ refused, hostCount: await messageCount(host.id, thread.id) }).toEqual({
      refused: readOnly(StreamReadOnlyReasons.NOT_A_MEMBER),
      hostCount,
    })
  }, 30_000)
})
