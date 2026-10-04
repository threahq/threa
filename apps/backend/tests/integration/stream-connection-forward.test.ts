import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import {
  AuthorTypes,
  StreamConnectionErrorCodes,
  StreamTypes,
  bridgeEventsSchema,
  bridgeManifestSchema,
  type BridgeEvents,
  type BridgeManifest,
  type JSONContent,
} from "@threahq/types"
import { streamConnectionId } from "@threahq/backend-common"
import {
  addTestMember,
  createTestStorage,
  setupIsolatedTestDatabase,
  testContentJson,
  testMessageContent,
} from "./setup"
import { CommandAvailabilityService, CommandRegistry } from "../../src/features/commands"
import { EventService, MessageRepository } from "../../src/features/messaging"
import { StreamRepository, type Stream } from "../../src/features/streams"
import { FeatureFlagOverrideRepository, FeatureFlagService } from "../../src/features/feature-flags"
import { UserRepository, WorkspaceRepository, syncUserCopies } from "../../src/features/workspaces"
import {
  BridgeClient,
  StreamConnectionExportService,
  StreamConnectionForwardService,
  StreamConnectionPullService,
  StreamConnectionRepository,
  StreamConnectionWriteService,
} from "../../src/features/stream-connections"
import { messageId, streamId, userId, workspaceId } from "../../src/lib/id"

const REFUSED = { status: 403, code: StreamConnectionErrorCodes.WRITE_REFUSED }
const UNREACHABLE = { status: 503, code: StreamConnectionErrorCodes.HOST_UNREACHABLE }

type Address = Parameters<BridgeClient["getManifest"]>[0]

/** Answers the partner's bridge calls from the host's services in-process. */
class DirectBridgeClient extends BridgeClient {
  readonly sent: Array<Parameters<BridgeClient["sendMessage"]>[1]> = []

  constructor(
    private readonly host: { exporter: StreamConnectionExportService; writer: StreamConnectionWriteService }
  ) {
    super({ routerUrl: "http://bridge.invalid", apiKey: "unused" })
  }

  override async getManifest(address: Address): Promise<BridgeManifest> {
    return bridgeManifestSchema.parse(await this.host.exporter.getManifest(address))
  }

  override async listEvents(
    address: Address,
    params: Parameters<BridgeClient["listEvents"]>[1]
  ): Promise<BridgeEvents> {
    return bridgeEventsSchema.parse(await this.host.exporter.listEvents({ ...address, ...params }))
  }

  override sendMessage(address: Address, params: Parameters<BridgeClient["sendMessage"]>[1]) {
    this.sent.push(params)
    return this.host.writer.sendMessage({ ...address, ...params })
  }

  override editMessage(address: Address, params: Parameters<BridgeClient["editMessage"]>[1]) {
    return this.host.writer.editMessage({ ...address, ...params })
  }

  override deleteMessage(address: Address, params: Parameters<BridgeClient["deleteMessage"]>[1]) {
    return this.host.writer.deleteMessage({ ...address, ...params })
  }

  override addReaction(address: Address, params: Parameters<BridgeClient["addReaction"]>[1]) {
    return this.host.writer.addReaction({ ...address, ...params })
  }

  override removeReaction(address: Address, params: Parameters<BridgeClient["removeReaction"]>[1]) {
    return this.host.writer.removeReaction({ ...address, ...params })
  }
}

/** Rewrites each page the host returns, to hand a pull a page the real host would never send. */
class TamperedBridgeClient extends DirectBridgeClient {
  constructor(
    host: ConstructorParameters<typeof DirectBridgeClient>[0],
    private readonly tamper: (page: BridgeEvents) => BridgeEvents
  ) {
    super(host)
  }

  override async listEvents(address: Address, params: Parameters<BridgeClient["listEvents"]>[1]) {
    return this.tamper(await super.listEvents(address, params))
  }
}

/** Runs a competing pull between fetching its first page and returning it, so the page is stale when it arrives. */
class RacedBridgeClient extends DirectBridgeClient {
  private rival: (() => Promise<boolean>) | null

  constructor(host: ConstructorParameters<typeof DirectBridgeClient>[0], rival: () => Promise<boolean>) {
    super(host)
    this.rival = rival
  }

  override async listEvents(address: Address, params: Parameters<BridgeClient["listEvents"]>[1]) {
    const page = await super.listEvents(address, params)
    const rival = this.rival
    this.rival = null
    if (rival) await rival()
    return page
  }
}

/** Reports the first `losses` pulls as having lost the cursor race, without pulling. */
class LosingPullService extends StreamConnectionPullService {
  readonly calls: Array<{ streamId?: string }> = []

  constructor(
    deps: ConstructorParameters<typeof StreamConnectionPullService>[0],
    private readonly losses: number
  ) {
    super(deps)
  }

  override async pull(ref: Parameters<StreamConnectionPullService["pull"]>[0], options: { streamId?: string } = {}) {
    this.calls.push(options)
    if (this.calls.length <= this.losses) return false
    return super.pull(ref, options)
  }
}

describe("A partner's writes forwarded to a shared channel's host", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  let featureFlagService: FeatureFlagService
  let eventService: EventService
  let host: ConstructorParameters<typeof DirectBridgeClient>[0]
  let stubs: Array<{ stop: (force: boolean) => unknown }> = []

  beforeAll(async () => {
    const isolated = await setupIsolatedTestDatabase("connection_forward")
    pool = isolated.pool
    cleanup = isolated.cleanup
    featureFlagService = new FeatureFlagService(pool)
    eventService = new EventService(pool)
    host = {
      exporter: new StreamConnectionExportService({ pool, featureFlagService, storage: createTestStorage() }),
      writer: new StreamConnectionWriteService({ pool, featureFlagService, eventService }),
    }
  }, 120_000)

  afterAll(async () => {
    for (const stub of stubs) stub.stop(true)
    await cleanup()
  }, 120_000)

  async function seedWorkspace(name: string) {
    const id = workspaceId()
    await WorkspaceRepository.insert(pool, { id, name, slug: `forward-${id}`, createdBy: userId() })
    const admin = await addTestMember(pool, id, `admin-${id}`, "admin")
    await FeatureFlagOverrideRepository.replaceForSubject(pool, id, "workspace", id, { streamConnections: "on" })
    return { id, name, adminId: admin.id, adminSlug: admin.slug, adminName: admin.name }
  }

  const pullVia = (bridgeClient: BridgeClient) =>
    new StreamConnectionPullService({ pool, bridgeClient, featureFlagService })
  const forwardVia = (bridgeClient: BridgeClient, pullService = pullVia(bridgeClient)) =>
    new StreamConnectionForwardService({ pool, bridgeClient, pullService, featureFlagService })

  /** A host with a shared channel, a thread under it and a partner that has already copied both. */
  async function seedWorld() {
    const hostWs = await seedWorkspace("Forward host")
    const partner = await seedWorkspace("Forward partner")
    const channel = await StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: hostWs.id,
      type: StreamTypes.CHANNEL,
      slug: `forward-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Forward",
      visibility: "public",
      createdBy: hostWs.adminId,
    })
    const connectionId = streamConnectionId()
    await StreamConnectionRepository.applySnapshots(pool, [
      {
        id: connectionId,
        revision: 2,
        state: "active",
        hostWorkspaceId: hostWs.id,
        hostWorkspaceName: hostWs.name,
        hostRegion: "local",
        hostStreamId: channel.id,
        invitedBy: hostWs.adminId,
        partnerWorkspaceId: partner.id,
        partnerWorkspaceName: partner.name,
        partnerRegion: "local",
        partnerVisibility: "private",
        acceptedBy: partner.adminId,
        peerWorkspaceIds: [],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    ])
    const pat = await addTestMember(pool, partner.id, `pat-${partner.id}`)
    const sam = await addTestMember(pool, partner.id, `sam-${partner.id}`)

    const anchor = await hostSays(hostWs, channel.id, "anchor")
    const thread = await StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: hostWs.id,
      type: StreamTypes.THREAD,
      visibility: "public",
      parentStreamId: channel.id,
      parentAnchorId: anchor.id,
      rootStreamId: channel.id,
      createdBy: hostWs.adminId,
    })
    await hostSays(hostWs, thread.id, "in the thread")

    const bridge = new DirectBridgeClient(host)
    const ref = { workspaceId: partner.id, connectionId }
    expect(await pullVia(bridge).pull(ref)).toBe(true)
    const copyOf = async (id: string) => (await StreamRepository.findById(pool, partner.id, id))!
    return {
      host: hostWs,
      partner,
      channel,
      thread,
      connectionId,
      ref,
      pat,
      sam,
      bridge,
      channelCopy: await copyOf(channel.id),
      threadCopy: await copyOf(thread.id),
    }
  }

  type World = Awaited<ReturnType<typeof seedWorld>>

  function hostSays(hostWs: { id: string; adminId: string }, stream: string, text: string) {
    return eventService.createMessage({
      workspaceId: hostWs.id,
      streamId: stream,
      authorId: hostWs.adminId,
      authorType: AuthorTypes.USER,
      ...testMessageContent(text),
    })
  }

  /** The partner user a write is made by, in the copy stream it is made in. */
  const asPat = (world: World, stream: Stream = world.channelCopy) => ({
    workspaceId: world.partner.id,
    userId: world.pat.id,
    stream,
  })

  const patSend = (world: World, clientMessageId: string, text: string, stream?: Stream) => ({
    ...asPat(world, stream),
    clientMessageId,
    contentJson: testContentJson(text),
  })

  const profile = (user: { id: string; name: string; slug: string }) => ({
    id: user.id,
    name: user.name,
    slug: user.slug,
  })

  /** What a refused or failed write reports, so a test compares the whole outcome. */
  async function outcome(write: Promise<unknown>) {
    try {
      await write
      return "accepted"
    } catch (error) {
      const { status, code } = error as { status?: number; code?: string }
      return { status, code }
    }
  }

  const partnerMessage = (world: World, id: string) => MessageRepository.findById(pool, world.partner.id, id)

  async function createdPayloads(world: World, id: string) {
    const { rows } = await pool.query(
      `SELECT payload FROM stream_events
       WHERE workspace_id = $1 AND event_type = 'message_created' AND payload->>'messageId' = $2`,
      [world.partner.id, id]
    )
    return rows.map((row) => row.payload)
  }

  async function messageIdsByClientId(world: World, clientMessageId: string) {
    const { rows } = await pool.query("SELECT id FROM messages WHERE workspace_id = $1 AND client_message_id = $2", [
      world.partner.id,
      clientMessageId,
    ])
    return rows.map((row) => row.id)
  }

  /** A host standing in for an unreachable or refusing one, recording what it was asked. */
  function startStubHost(respondWith: () => number) {
    const requests: Array<{ call: string; callerWorkspace: string | null }> = []
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        requests.push({
          call: `${req.method} ${new URL(req.url).pathname}`,
          callerWorkspace: req.headers.get("X-Threa-Bridge-Workspace"),
        })
        return Response.json({ error: "Stub says no" }, { status: respondWith() })
      },
    })
    stubs.push(server)
    return { url: `http://localhost:${server.port}`, requests }
  }

  test("should send as the partner's user and return the copy carrying the client message id when the host takes the message", async () => {
    const world = await seedWorld()
    const forward = forwardVia(world.bridge)

    const message = await forward.sendMessage(patSend(world, "client-1", "hello host"))

    expect({
      message,
      payloads: await createdPayloads(world, message.id),
      sent: world.bridge.sent.map(({ author, users, clientMessageId }) => ({ author, users, clientMessageId })),
    }).toMatchObject({
      message: {
        streamId: world.channel.id,
        authorId: world.pat.id,
        authorType: "user",
        contentMarkdown: "hello host",
        clientMessageId: "client-1",
      },
      payloads: [{ clientMessageId: "client-1" }],
      sent: [{ author: profile(world.pat), users: [], clientMessageId: "client-1" }],
    })
  })

  test("should write into a thread copy through the shared channel's connection when the partner sends in a thread", async () => {
    const world = await seedWorld()

    const message = await forwardVia(world.bridge).sendMessage(
      patSend(world, "client-thread", "reply in the thread", world.threadCopy)
    )

    expect(message).toMatchObject({ streamId: world.thread.id, authorId: world.pat.id })
  })

  test("should send only the profiles of the partner's own users the content mentions when the partner sends", async () => {
    const world = await seedWorld()
    const mention = (user: { id: string; slug: string }): JSONContent => ({
      type: "mention",
      attrs: { id: user.id, slug: user.slug, mentionType: "user" },
    })
    const content: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            mention({ id: world.host.adminId, slug: world.host.adminSlug }),
            { type: "text", text: " " },
            mention(world.sam),
          ],
        },
      ],
    }

    const message = await forwardVia(world.bridge).sendMessage({
      ...asPat(world),
      clientMessageId: "client-mention",
      contentJson: content,
    })

    expect({ users: world.bridge.sent.map((sent) => sent.users), contentJson: message.contentJson }).toEqual({
      users: [[profile(world.sam)]],
      contentJson: content,
    })
  })

  test("should return the edited copy when the partner edits their message", async () => {
    const world = await seedWorld()
    const forward = forwardVia(world.bridge)
    const sent = await forward.sendMessage(patSend(world, "client-edit", "first draft"))

    const edited = await forward.editMessage({
      ...asPat(world),
      messageId: sent.id,
      contentJson: testContentJson("second draft"),
    })

    expect(edited).toMatchObject({ id: sent.id, contentMarkdown: "second draft", revision: 2 })
  })

  test("should delete the copy when the partner deletes their message", async () => {
    const world = await seedWorld()
    const forward = forwardVia(world.bridge)
    const sent = await forward.sendMessage(patSend(world, "client-delete", "to delete"))

    await forward.deleteMessage({ ...asPat(world), messageId: sent.id })

    expect((await partnerMessage(world, sent.id))?.deletedAt).not.toBeNull()
  })

  test("should add and remove the partner user's reaction on the copy when the partner reacts", async () => {
    const world = await seedWorld()
    const forward = forwardVia(world.bridge)
    const target = (await hostSays(world.host, world.channel.id, "react to me")).id
    await forward.addReaction({ ...asPat(world), messageId: target, emoji: ":+1:" })
    const added = (await partnerMessage(world, target))?.reactions

    const removed = await forward.removeReaction({ ...asPat(world), messageId: target, emoji: ":+1:" })

    expect({ added, removed: removed.reactions }).toEqual({ added: { ":+1:": [world.pat.id] }, removed: {} })
  })

  test("should refuse the write without calling the host when the stream is not a shared channel's copy", async () => {
    const world = await seedWorld()
    const local = await StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: world.partner.id,
      type: StreamTypes.CHANNEL,
      slug: `local-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Local",
      visibility: "public",
      createdBy: world.partner.adminId,
    })

    const refused = await outcome(
      forwardVia(world.bridge).sendMessage(patSend(world, "client-local", "not shared", local))
    )

    expect({ refused, sent: world.bridge.sent }).toEqual({ refused: REFUSED, sent: [] })
  })

  test("should refuse the write without calling the host when the partner has shared channels off", async () => {
    const world = await seedWorld()
    await FeatureFlagOverrideRepository.replaceForSubject(pool, world.partner.id, "workspace", world.partner.id, {
      streamConnections: "off",
    })
    const pullService = new LosingPullService({ pool, bridgeClient: world.bridge, featureFlagService }, 0)

    const refused = await outcome(
      forwardVia(world.bridge, pullService).sendMessage(patSend(world, "client-off", "flag is off"))
    )

    expect({
      refused,
      sent: world.bridge.sent,
      pulls: pullService.calls,
      local: await messageIdsByClientId(world, "client-off"),
    }).toEqual({ refused: REFUSED, sent: [], pulls: [], local: [] })
  })

  test("should throw HOST_UNREACHABLE and leave no local message when the host cannot be reached", async () => {
    const world = await seedWorld()
    const deadHost = new BridgeClient({ routerUrl: "http://127.0.0.1:1", apiKey: "unused" })

    const sent = await outcome(forwardVia(deadHost).sendMessage(patSend(world, "client-dead", "into the void")))

    expect({ sent, local: await messageIdsByClientId(world, "client-dead") }).toEqual({ sent: UNREACHABLE, local: [] })
  })

  test("should refuse a write the host answers with a 4xx, giving the host's reason, and call it unreachable when it answers with a 5xx, rejects the bridge key or asks to slow down", async () => {
    const world = await seedWorld()
    let status = 403
    const stub = startStubHost(() => status)
    const forward = forwardVia(new BridgeClient({ routerUrl: stub.url, apiKey: "unused" }))
    const send = () => outcome(forward.sendMessage(patSend(world, "client-stub", "to the stub")))

    const outcomes: unknown[] = []
    for (status of [403, 404, 401, 408, 429, 500, 503]) outcomes.push(await send())
    status = 403
    const reason = await forward
      .sendMessage(patSend(world, "client-stub", "to the stub"))
      .catch((error: Error) => error.message)

    expect({
      outcomes,
      reason,
      requests: stub.requests[0],
      local: await messageIdsByClientId(world, "client-stub"),
    }).toEqual({
      outcomes: [REFUSED, REFUSED, UNREACHABLE, UNREACHABLE, UNREACHABLE, UNREACHABLE, UNREACHABLE],
      reason: expect.stringContaining("answered 403: Stub says no"),
      requests: {
        call: `POST /api/workspaces/${world.host.id}/stream-connections/${world.connectionId}/bridge/streams/${world.channel.id}/messages`,
        callerWorkspace: world.partner.id,
      },
      local: [],
    })
  })

  test("should pull again when a pull loses the cursor race", async () => {
    const world = await seedWorld()
    const pullService = new LosingPullService({ pool, bridgeClient: world.bridge, featureFlagService }, 2)

    const message = await forwardVia(world.bridge, pullService).sendMessage(
      patSend(world, "client-race", "after two lost pulls")
    )

    expect({ message, calls: pullService.calls }).toMatchObject({
      message: { authorId: world.pat.id, clientMessageId: "client-race" },
      calls: [{ streamId: world.channel.id }, { streamId: world.channel.id }, { streamId: world.channel.id }],
    })
  })

  test("should throw HOST_UNREACHABLE after three pulls and bring in the same message when the send is retried", async () => {
    const world = await seedWorld()
    const pullService = new LosingPullService({ pool, bridgeClient: world.bridge, featureFlagService }, 3)
    const send = (service: StreamConnectionForwardService) =>
      service.sendMessage(patSend(world, "client-retry", "sent twice"))

    const first = await outcome(send(forwardVia(world.bridge, pullService)))
    const copiedAfterFirst = await messageIdsByClientId(world, "client-retry")
    const retried = await send(forwardVia(world.bridge))

    expect({ first, calls: pullService.calls.length, copiedAfterFirst, retried: retried.id }).toEqual({
      first: UNREACHABLE,
      calls: 3,
      copiedAfterFirst: [],
      retried: (await messageIdsByClientId(world, "client-retry"))[0],
    })
    expect(await messageIdsByClientId(world, "client-retry")).toHaveLength(1)
  })

  test("should throw HOST_UNREACHABLE rather than return the stale copy when an edit's pulls all lose", async () => {
    const world = await seedWorld()
    const sent = await forwardVia(world.bridge).sendMessage(patSend(world, "client-stale", "first draft"))
    const losing = new LosingPullService({ pool, bridgeClient: world.bridge, featureFlagService }, 3)

    const edit = await outcome(
      forwardVia(world.bridge, losing).editMessage({
        ...asPat(world),
        messageId: sent.id,
        contentJson: testContentJson("second draft"),
      })
    )

    expect(edit).toEqual(UNREACHABLE)
  })

  test("should offer no commands in a shared channel's copy while the host's channel keeps them", async () => {
    const world = await seedWorld()
    const registry = new CommandRegistry()
    registry.register({
      name: "invite",
      description: "Invite someone",
      execute: () => Promise.reject(new Error("not run here")),
    })
    const availability = new CommandAvailabilityService({ pool, commandRegistry: registry })
    const names = async (workspaceId: string, userId: string, stream: string) =>
      (await availability.listStreamCommands({ workspaceId, userId, streamId: stream })).map((command) => command.name)

    expect({
      channel: await names(world.host.id, world.host.adminId, world.channel.id),
      channelCopy: await names(world.partner.id, world.pat.id, world.channelCopy.id),
      threadCopy: await names(world.partner.id, world.pat.id, world.threadCopy.id),
    }).toEqual({ channel: ["invite"], channelCopy: [], threadCopy: [] })
  })

  describe("when the copy pulls the host's pages", () => {
    test("should apply a page authored by the partner's own user and keep its client message id when the host returns the partner's message", async () => {
      const world = await seedWorld()
      const { messageId: id } = await host.writer.sendMessage({
        workspaceId: world.host.id,
        connectionId: world.connectionId,
        callerWorkspaceId: world.partner.id,
        streamId: world.channel.id,
        author: profile(world.pat),
        users: [],
        clientMessageId: "client-echo",
        contentJson: testContentJson("from the partner"),
      })

      const reached = await pullVia(world.bridge).pull(world.ref)

      const { rows } = await pool.query(
        "SELECT author_id, author_type, client_message_id FROM messages WHERE workspace_id = $1 AND id = $2",
        [world.partner.id, id]
      )
      expect({
        reached,
        row: rows,
        payloads: await createdPayloads(world, id),
        pat: await UserRepository.findById(pool, world.partner.id, world.pat.id),
      }).toMatchObject({
        reached: true,
        row: [{ author_id: world.pat.id, author_type: "user", client_message_id: "client-echo" }],
        payloads: [{ messageId: id, clientMessageId: "client-echo" }],
        pat: { id: world.pat.id, originWorkspaceId: null },
      })
    })

    test("should refuse a page naming a copy from a third workspace and apply nothing when the page is pulled", async () => {
      const world = await seedWorld()
      const third = await seedWorkspace("Forward third")
      const tess = { id: userId(), name: "Tess", slug: "tess" }
      await syncUserCopies(pool, {
        workspaceId: world.partner.id,
        originWorkspaceId: third.id,
        originWorkspaceName: third.name,
        users: [tess],
      })
      const news = await hostSays(world.host, world.channel.id, "news")
      const tampered = new TamperedBridgeClient(host, (page) => ({
        ...page,
        changes: page.changes.map((change) =>
          change.kind === "message" ? { ...change, message: { ...change.message, authorId: tess.id } } : change
        ),
      }))

      const refused = await pullVia(tampered)
        .pull(world.ref)
        .then(
          () => "pulled",
          (error: Error) => error.message
        )
      const afterRefusal = await partnerMessage(world, news.id)
      const reached = await pullVia(world.bridge).pull(world.ref)

      expect({ refused, afterRefusal, reached, applied: (await partnerMessage(world, news.id))?.authorId }).toEqual({
        refused: expect.stringContaining("is not a copy from its host"),
        afterRefusal: null,
        reached: true,
        applied: world.host.adminId,
      })
    })

    test("should refuse a page typing a user author as a persona and apply nothing when the page is pulled", async () => {
      const world = await seedWorld()
      const news = await hostSays(world.host, world.channel.id, "news")
      const tampered = new TamperedBridgeClient(host, (page) => ({
        ...page,
        changes: page.changes.map((change) =>
          change.kind === "message"
            ? { ...change, message: { ...change.message, authorType: AuthorTypes.PERSONA } }
            : change
        ),
      }))

      const refused = await pullVia(tampered)
        .pull(world.ref)
        .then(
          () => "pulled",
          (error: Error) => error.message
        )

      expect({ refused, applied: await partnerMessage(world, news.id) }).toEqual({
        refused: expect.stringContaining("is typed as a persona"),
        applied: null,
      })
    })

    test("should sync only the named stream and report whether it reached the head when a stream id is given", async () => {
      const world = await seedWorld()
      const channelNews = await hostSays(world.host, world.channel.id, "channel news")
      const threadNews = await hostSays(world.host, world.thread.id, "thread news")
      const pull = (options?: { streamId?: string }) => pullVia(world.bridge).pull(world.ref, options)

      const reachedThread = await pull({ streamId: world.thread.id })
      const afterThread = [await partnerMessage(world, channelNews.id), await partnerMessage(world, threadNews.id)]
      const reachedUnknown = await pull({ streamId: messageId() })
      const reachedAll = await pull()

      expect({
        reachedThread,
        afterThread: afterThread.map((message) => message?.id ?? null),
        reachedUnknown,
        reachedAll,
        afterAll: (await partnerMessage(world, channelNews.id))?.id,
      }).toEqual({
        reachedThread: true,
        afterThread: [null, threadNews.id],
        reachedUnknown: false,
        reachedAll: true,
        afterAll: channelNews.id,
      })
    })

    test("should report false and apply the page once when a concurrent pull moves the cursor first", async () => {
      const world = await seedWorld()
      const raced = await hostSays(world.host, world.channel.id, "raced")
      const rival = pullVia(world.bridge)
      const racer = pullVia(new RacedBridgeClient(host, () => rival.pull(world.ref)))

      const reached = await racer.pull(world.ref, { streamId: world.channel.id })
      const { rows: copies } = await pool.query("SELECT id FROM messages WHERE workspace_id = $1 AND id = $2", [
        world.partner.id,
        raced.id,
      ])
      const next = await pullVia(world.bridge).pull(world.ref, { streamId: world.channel.id })

      expect({ reached, copies, next }).toEqual({ reached: false, copies: [{ id: raced.id }], next: true })
    })
  })
})
