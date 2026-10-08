import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import {
  AuthorTypes,
  ConversationStatuses,
  StreamErrorCodes,
  StreamReadOnlyReasons,
  bridgeConversationIndexSchema,
  bridgeConversationsSchema,
  bridgeEventsSchema,
  bridgeManifestSchema,
  bridgeMemoIndexSchema,
  type BridgeConversation,
  type BridgeConversationIndex,
  type BridgeConversations,
  type BridgeEvents,
  type BridgeManifest,
  type BridgeMemoIndex,
} from "@threahq/types"
import { HttpError, streamConnectionId } from "@threahq/backend-common"
import { addTestMember, createTestStorage, setupIsolatedTestDatabase, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { EventService } from "../../src/features/messaging"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import {
  ConversationRepository,
  ConversationService,
  viewConversationsAsPartner,
  type InsertConversationParams,
} from "../../src/features/conversations"
import { FeatureFlagOverrideRepository, FeatureFlagService } from "../../src/features/feature-flags"
import {
  BridgeClient,
  StreamConnectionExportService,
  StreamConnectionPokeHandler,
  StreamConnectionPullService,
  StreamConnectionRepository,
} from "../../src/features/stream-connections"
import type { OutboxEvent } from "../../src/lib/outbox"
import { conversationId, streamId, userId, workspaceId } from "../../src/lib/id"

type Address = Parameters<BridgeClient["getManifest"]>[0]

/** Answers the partner's bridge calls from the host's export service in-process. */
class DirectBridgeClient extends BridgeClient {
  readonly conversationFetches: string[][] = []
  /** Rewrites what the host answers, standing in for a host that misbehaves. */
  tamper: ((conversations: BridgeConversation[]) => BridgeConversation[]) | null = null

  constructor(private readonly exporter: StreamConnectionExportService) {
    super({ routerUrl: "http://bridge.invalid", apiKey: "unused" })
  }

  override async getManifest(address: Address): Promise<BridgeManifest> {
    return bridgeManifestSchema.parse(await this.exporter.getManifest(address))
  }

  override async listEvents(
    address: Address,
    params: Parameters<BridgeClient["listEvents"]>[1]
  ): Promise<BridgeEvents> {
    return bridgeEventsSchema.parse(await this.exporter.listEvents({ ...address, ...params }))
  }

  override async getConversationIndex(address: Address): Promise<BridgeConversationIndex> {
    return bridgeConversationIndexSchema.parse(await this.exporter.getConversationIndex(address))
  }

  override async getConversations(address: Address, conversationIds: string[]): Promise<BridgeConversations> {
    this.conversationFetches.push(conversationIds)
    const { conversations } = bridgeConversationsSchema.parse(
      await this.exporter.getConversations({ ...address, conversationIds })
    )
    return { conversations: this.tamper ? this.tamper(conversations) : conversations }
  }

  override async getMemoIndex(address: Address): Promise<BridgeMemoIndex> {
    return bridgeMemoIndexSchema.parse(await this.exporter.getMemoIndex(address))
  }
}

/** Records the pokes a handler sends instead of sending them. */
class RecordingBridgeClient extends BridgeClient {
  readonly pokes: Parameters<BridgeClient["poke"]>[0][] = []

  constructor() {
    super({ routerUrl: "http://bridge.invalid", apiKey: "unused" })
  }

  override async poke(params: Parameters<BridgeClient["poke"]>[0]): Promise<void> {
    this.pokes.push(params)
  }
}

class TestPokeHandler extends StreamConnectionPokeHandler {
  run(events: OutboxEvent[]) {
    return this.processBatch(events)
  }
}

describe("Conversations in a shared channel's copy", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  let exporter: StreamConnectionExportService
  let featureFlagService: FeatureFlagService
  let eventService: EventService
  let conversationService: ConversationService

  beforeAll(async () => {
    const isolated = await setupIsolatedTestDatabase("conversation_copies")
    pool = isolated.pool
    cleanup = isolated.cleanup
    featureFlagService = new FeatureFlagService(pool)
    exporter = new StreamConnectionExportService({ pool, featureFlagService, storage: createTestStorage() })
    eventService = new EventService(pool)
    conversationService = new ConversationService(pool)
  }, 120_000)

  afterAll(async () => cleanup(), 120_000)

  async function seedWorkspace(name: string) {
    const id = workspaceId()
    await WorkspaceRepository.insert(pool, { id, name, slug: `convs-${id}`, createdBy: userId() })
    const admin = await addTestMember(pool, id, `admin-${id}`, "admin")
    await FeatureFlagOverrideRepository.replaceForSubject(pool, id, "workspace", id, { streamConnections: "on" })
    return { id, name, adminId: admin.id }
  }

  async function seedChannel(inWorkspace: { id: string; adminId: string }, displayName: string) {
    return StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: inWorkspace.id,
      type: "channel",
      slug: `convs-${crypto.randomUUID().slice(0, 8)}`,
      displayName,
      visibility: "public",
      createdBy: inWorkspace.adminId,
    })
  }

  async function seedWorld() {
    const host = await seedWorkspace("Conversation host")
    const partner = await seedWorkspace("Conversation partner")
    const channel = await seedChannel(host, "Conversations")
    await StreamMemberRepository.insert(pool, host.id, channel.id, host.adminId)
    const connectionId = streamConnectionId()
    await StreamConnectionRepository.applySnapshots(pool, [
      {
        id: connectionId,
        revision: 2,
        state: "active",
        hostWorkspaceId: host.id,
        hostWorkspaceName: host.name,
        hostRegion: "local",
        hostStreamId: channel.id,
        invitedBy: host.adminId,
        partnerWorkspaceId: partner.id,
        partnerWorkspaceName: partner.name,
        partnerRegion: "local",
        partnerVisibility: "private",
        acceptedBy: partner.adminId,
        peerWorkspaceIds: [],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    ])
    const bridgeClient = new DirectBridgeClient(exporter)
    const pull = () =>
      new StreamConnectionPullService({ pool, bridgeClient, featureFlagService }).pull({
        workspaceId: partner.id,
        connectionId,
      })
    return { host, partner, channel, connectionId, bridgeClient, pull }
  }

  type World = Awaited<ReturnType<typeof seedWorld>>

  async function hostMessage(world: World, text: string, inStreamId = world.channel.id, authorId = world.host.adminId) {
    return eventService.createMessage({
      workspaceId: world.host.id,
      streamId: inStreamId,
      authorId,
      authorType: AuthorTypes.USER,
      ...testMessageContent(text),
    })
  }

  /** A conversation the host found in the channel while it was shared, unless `overrides` say otherwise. */
  async function hostConversation(
    world: World,
    messageIds: string[],
    {
      participantIds = [world.host.adminId],
      ...overrides
    }: Partial<InsertConversationParams> & {
      participantIds?: string[]
    } = {}
  ): Promise<string> {
    const id = conversationId()
    await ConversationRepository.insert(pool, {
      id,
      streamId: world.channel.id,
      workspaceId: world.host.id,
      topicSummary: "Database choice",
      topicSummarySource: "generated",
      summary: "They picked postgres",
      status: ConversationStatuses.ACTIVE,
      sharedRootStreamId: world.channel.id,
      ...overrides,
    })
    await ConversationRepository.addPrimaryMessages(pool, world.host.id, id, messageIds, participantIds)
    return id
  }

  async function rows(inWorkspace: string, ids?: string[]) {
    const { rows } = await pool.query(
      `SELECT id, stream_id, message_ids, secondary_message_ids, participant_ids, topic_summary, topic_summary_source,
              summary, status, version, origin_workspace_id
       FROM conversations WHERE workspace_id = $1 AND ($2::text[] IS NULL OR id = ANY($2)) ORDER BY id`,
      [inWorkspace, ids ?? null]
    )
    return rows
  }

  async function partnerOutbox(world: World) {
    const { rows } = await pool.query(
      `SELECT event_type, payload FROM outbox
       WHERE event_type IN ('conversation:created', 'conversation:updated') AND payload->>'workspaceId' = $1
       ORDER BY id`,
      [world.partner.id]
    )
    return rows.map((row) => ({
      eventType: row.event_type,
      streamId: row.payload.streamId,
      conversationId: row.payload.conversationId,
      topicSummary: row.payload.conversation.topicSummary,
      status: row.payload.conversation.status,
      streamVisibility: row.payload.streamVisibility,
    }))
  }

  test("should copy each conversation in the channel under the host's id and announce it, when the partner pulls", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const shared = await hostConversation(world, [message.id])
    const [host] = await rows(world.host.id, [shared])

    expect(await world.pull()).toBe(true)

    expect({ copies: await rows(world.partner.id), outbox: await partnerOutbox(world) }).toEqual({
      copies: [{ ...host, origin_workspace_id: world.host.id }],
      outbox: [
        {
          eventType: "conversation:created",
          streamId: world.channel.id,
          conversationId: shared,
          topicSummary: "Database choice",
          status: ConversationStatuses.ACTIVE,
          streamVisibility: "private",
        },
      ],
    })
  })

  test("should copy a conversation without its title or summary when they were written before the share, until a rename while shared", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const before = await hostConversation(world, [message.id], { sharedRootStreamId: null })

    await world.pull()
    const [untitled] = await rows(world.partner.id, [before])
    await conversationService.updateConversation({
      workspaceId: world.host.id,
      conversationId: before,
      topicSummary: "Postgres it is",
      actorUserId: world.host.adminId,
    })
    await world.pull()
    const [renamed] = await rows(world.partner.id, [before])

    expect({
      untitled: { title: untitled.topic_summary, source: untitled.topic_summary_source, summary: untitled.summary },
      renamed: { title: renamed.topic_summary, source: renamed.topic_summary_source, summary: renamed.summary },
    }).toEqual({
      untitled: { title: null, source: null, summary: null },
      renamed: { title: "Postgres it is", source: "explicit", summary: null },
    })
  })

  test("should copy a conversation without its title or summary when they were written for another shared channel", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const elsewhere = await hostConversation(world, [message.id], { sharedRootStreamId: streamId() })

    await world.pull()
    const [copy] = await rows(world.partner.id, [elsewhere])

    expect({ title: copy.topic_summary, source: copy.topic_summary_source, summary: copy.summary }).toEqual({
      title: null,
      source: null,
      summary: null,
    })
  })

  test("should show the host's AI a title renamed while shared, not the pre-share title it read earlier", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const conversation = await hostConversation(world, [message.id], { sharedRootStreamId: null })
    const readEarlier = (await ConversationRepository.findById(pool, world.host.id, conversation))!
    await conversationService.updateConversation({
      workspaceId: world.host.id,
      conversationId: conversation,
      topicSummary: "Postgres it is",
      actorUserId: world.host.adminId,
    })

    const [seen] = await viewConversationsAsPartner(
      pool,
      world.host.id,
      { rootStreamId: world.channel.id, streamIds: new Set([world.channel.id]) },
      [readEarlier]
    )

    expect({ title: seen!.topicSummary, summary: seen!.summary }).toEqual({ title: "Postgres it is", summary: null })
  })

  test("should move the copy to the host's newest version when the conversation changes, and fetch nothing when it did not", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const conversation = await hostConversation(world, [message.id])
    await world.pull()
    await ConversationRepository.update(pool, world.host.id, conversation, { status: ConversationStatuses.RESOLVED })

    await world.pull()
    world.bridgeClient.conversationFetches.length = 0
    await world.pull()

    const [host] = await rows(world.host.id, [conversation])
    expect({
      host: host.version,
      copy: await rows(world.partner.id),
      fetches: world.bridgeClient.conversationFetches,
      outbox: (await partnerOutbox(world)).map((event) => [event.eventType, event.status]),
    }).toEqual({
      host: 2,
      copy: [{ ...host, origin_workspace_id: world.host.id }],
      fetches: [],
      outbox: [
        ["conversation:created", ConversationStatuses.ACTIVE],
        ["conversation:updated", ConversationStatuses.RESOLVED],
      ],
    })
  })

  test("should bump the version only for a host's own conversation when a copied field changes", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const conversation = await hostConversation(world, [message.id])
    await world.pull()

    const version = async (inWorkspace: string) => (await rows(inWorkspace, [conversation]))[0].version
    await ConversationRepository.updateEmbeddings(pool, world.host.id, [
      { id: conversation, embedding: Array(1536).fill(0.1), sourceHash: "h1", expectedSourceHash: null },
    ])
    const afterEmbedding = await version(world.host.id)
    await ConversationRepository.update(pool, world.host.id, conversation, { completenessScore: 4 })
    const afterScore = await version(world.host.id)
    await pool.query(`UPDATE conversations SET status = 'resolved' WHERE workspace_id = $1 AND id = $2`, [
      world.partner.id,
      conversation,
    ])

    expect({ afterEmbedding, afterScore, copy: await version(world.partner.id) }).toEqual({
      afterEmbedding: 1,
      afterScore: 2,
      copy: 1,
    })
  })

  test("should keep a title shared when a regenerate leaves its text, and withdraw it when a write outside the share replaces it", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const conversation = await hostConversation(world, [message.id])
    const write = (topicSummary: string, sharedRootStreamId: string | null | undefined) =>
      ConversationRepository.updateTopicSummary(pool, {
        workspaceId: world.host.id,
        conversationId: conversation,
        topicSummary,
        source: "generated",
        sharedRootStreamId,
      })

    await write("Database choice", undefined)
    await world.pull()
    const kept = (await rows(world.partner.id))[0].topic_summary
    await write("Unshared title", null)
    await world.pull()

    expect({ kept, withdrawn: (await rows(world.partner.id))[0].topic_summary }).toEqual({
      kept: "Database choice",
      withdrawn: null,
    })
  })

  test("should drop messages outside the shared tree and people who took part only outside it", async () => {
    const world = await seedWorld()
    const inside = await hostMessage(world, "we picked postgres")
    const elsewhere = await seedChannel(world.host, "Private")
    const bystander = await addTestMember(pool, world.host.id, `bystander-${world.host.id}`, "member")
    const outside = await hostMessage(world, "the budget is tight", elsewhere.id, bystander.id)
    const conversation = await hostConversation(world, [inside.id, outside.id], {
      participantIds: [world.host.adminId, bystander.id],
    })

    await world.pull()

    const [copy] = await rows(world.partner.id, [conversation])
    expect({ messageIds: copy.message_ids, participantIds: copy.participant_ids }).toEqual({
      messageIds: [inside.id],
      participantIds: [world.host.adminId],
    })
  })

  test("should copy a conversation in a thread under one of the channel's messages", async () => {
    const world = await seedWorld()
    const anchor = await hostMessage(world, "we picked postgres")
    const thread = await StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: world.host.id,
      type: "thread",
      parentStreamId: world.channel.id,
      parentAnchorId: anchor.id,
      rootStreamId: world.channel.id,
      visibility: "public",
      createdBy: world.host.adminId,
    })
    const reply = await hostMessage(world, "version 17", thread.id)
    const conversation = await hostConversation(world, [reply.id], { streamId: thread.id })
    const [host] = await rows(world.host.id, [conversation])

    await world.pull()

    expect({ host: host.stream_id, copies: await rows(world.partner.id) }).toEqual({
      host: thread.id,
      copies: [{ ...host, origin_workspace_id: world.host.id }],
    })
  })

  test("should keep a summary shared when an extraction pass leaves it unchanged", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const conversation = await hostConversation(world, [message.id])
    await ConversationRepository.applyExtractionUpdate(pool, world.host.id, conversation, {
      status: ConversationStatuses.RESOLVED,
      sharedRootStreamId: null,
    })
    const [host] = await rows(world.host.id, [conversation])

    await world.pull()

    expect({ host: [host.summary, host.status], copies: await rows(world.partner.id) }).toEqual({
      host: ["They picked postgres", ConversationStatuses.RESOLVED],
      copies: [{ ...host, origin_workspace_id: world.host.id }],
    })
  })

  test("should keep the newer copy when a body from an older version arrives after it", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const conversation = await hostConversation(world, [message.id])
    let firstBodies: BridgeConversation[] = []
    world.bridgeClient.tamper = (conversations) => {
      firstBodies = conversations
      return conversations
    }
    await world.pull()
    world.bridgeClient.tamper = null
    await ConversationRepository.update(pool, world.host.id, conversation, { status: ConversationStatuses.RESOLVED })
    await world.pull()
    const newer = await rows(world.partner.id)
    await ConversationRepository.update(pool, world.host.id, conversation, { completenessScore: 5 })
    world.bridgeClient.tamper = () => firstBodies

    expect(await world.pull()).toBe(true)

    expect({
      copies: await rows(world.partner.id),
      outbox: (await partnerOutbox(world)).map((event) => [event.eventType, event.status]),
    }).toEqual({
      copies: newer,
      outbox: [
        ["conversation:created", ConversationStatuses.ACTIVE],
        ["conversation:updated", ConversationStatuses.RESOLVED],
      ],
    })
  })

  test("should not copy a conversation from a channel the connection does not share", async () => {
    const world = await seedWorld()
    const elsewhere = await seedChannel(world.host, "Private")
    const message = await hostMessage(world, "the budget is tight", elsewhere.id)
    await hostConversation(world, [message.id], { streamId: elsewhere.id })

    await world.pull()

    expect(await rows(world.partner.id)).toEqual([])
  })

  test("should fail the pull and write nothing when a conversation names a stream of the partner's own", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    await hostConversation(world, [message.id])
    const own = await seedChannel(world.partner, "Own")
    world.bridgeClient.tamper = (conversations) => conversations.map((c) => ({ ...c, streamId: own.id }))

    await expect(world.pull()).rejects.toThrow(`Stream ${own.id} in ${world.partner.id} is not a copy`)

    expect(await rows(world.partner.id)).toEqual([])
  })

  test("should fail the pull and leave the partner's conversation alone when it shares an id with the host's", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const conversation = await hostConversation(world, [message.id])
    const own = await seedChannel(world.partner, "Own")
    await ConversationRepository.insert(pool, {
      id: conversation,
      streamId: own.id,
      workspaceId: world.partner.id,
      topicSummary: "Partner's own",
    })

    await expect(world.pull()).rejects.toThrow(
      `Conversation ${conversation} in ${world.partner.id} is not a copy in connection ${world.connectionId}`
    )

    expect(
      (await rows(world.partner.id)).map((row) => ({
        id: row.id,
        title: row.topic_summary,
        origin: row.origin_workspace_id,
      }))
    ).toEqual([{ id: conversation, title: "Partner's own", origin: null }])
  })

  test("should leave a conversation for a later pull when the partner has no copy of its stream yet", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const conversation = await hostConversation(world, [message.id])
    world.bridgeClient.tamper = (conversations) => conversations.map((c) => ({ ...c, streamId: streamId() }))

    expect(await world.pull()).toBe(true)
    const before = await rows(world.partner.id)
    world.bridgeClient.tamper = null
    await world.pull()

    expect({ before, after: (await rows(world.partner.id)).map((row) => row.id) }).toEqual({
      before: [],
      after: [conversation],
    })
  })

  test("should fetch changed conversations in bounded batches when more changed than one request carries", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const conversations: string[] = []
    for (let i = 0; i < 26; i++) conversations.push(await hostConversation(world, [message.id]))

    await world.pull()

    expect({
      copies: (await rows(world.partner.id)).map((row) => row.id),
      fetchSizes: world.bridgeClient.conversationFetches.map((ids) => ids.length),
    }).toEqual({ copies: [...conversations].sort(), fetchSizes: [25, 1] })
  })

  test("should leave a copy to its host when the staleness sweep runs", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const conversation = await hostConversation(world, [message.id])
    await world.pull()
    await pool.query(
      `UPDATE conversations SET last_activity_at = NOW() - INTERVAL '30 days' WHERE workspace_id = $1 AND id = $2`,
      [world.partner.id, conversation]
    )

    const swept = await ConversationRepository.sweepStale(pool, {
      stalledAfterSeconds: 60,
      resolvedAfterSeconds: 120,
      limit: 1000,
    })

    expect({
      swept: swept.filter((c) => c.workspaceId === world.partner.id),
      status: (await rows(world.partner.id))[0].status,
    }).toEqual({ swept: [], status: ConversationStatuses.ACTIVE })
  })

  test("should poke the partner when the host's conversation changes, and not when its copy does", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const conversation = await hostConversation(world, [message.id])
    await conversationService.updateConversation({
      workspaceId: world.host.id,
      conversationId: conversation,
      actorUserId: world.host.adminId,
      topicSummary: "Schema choice",
    })
    await world.pull()
    const { rows: events } = await pool.query(
      `SELECT id, event_type, payload, created_at FROM outbox
       WHERE event_type IN ('conversation:created', 'conversation:updated') AND payload->>'conversationId' = $1
       ORDER BY id`,
      [conversation]
    )
    const toOutboxEvent = (row: (typeof events)[number]): OutboxEvent => ({
      id: BigInt(row.id),
      eventType: row.event_type,
      payload: row.payload,
      createdAt: row.created_at,
    })
    const pokesFor = async (workspace: string) => {
      const sent = events.filter((row) => row.payload.workspaceId === workspace)
      const bridgeClient = new RecordingBridgeClient()
      await new TestPokeHandler(pool, bridgeClient).run(sent.map(toOutboxEvent))
      return { events: sent.map((row) => row.event_type), pokes: bridgeClient.pokes }
    }

    expect({ host: await pokesFor(world.host.id), copy: await pokesFor(world.partner.id) }).toEqual({
      host: {
        events: ["conversation:updated"],
        pokes: [
          { hostWorkspaceId: world.host.id, connectionId: world.connectionId, partnerWorkspaceId: world.partner.id },
        ],
      },
      copy: { events: ["conversation:created"], pokes: [] },
    })
  })

  test("should refuse a partner's rename or status change on a copy", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const conversation = await hostConversation(world, [message.id])
    await world.pull()
    await StreamMemberRepository.insert(pool, world.partner.id, world.channel.id, world.partner.adminId)

    const refusals = await Promise.all(
      [{ topicSummary: "Mine now" }, { status: ConversationStatuses.RESOLVED }].map((change) =>
        conversationService
          .updateConversation({
            workspaceId: world.partner.id,
            conversationId: conversation,
            actorUserId: world.partner.adminId,
            ...change,
          })
          .then(
            () => null,
            (error: HttpError) => ({ status: error.status, code: error.code, details: error.details })
          )
      )
    )

    const readOnly = {
      status: 403,
      code: StreamErrorCodes.READ_ONLY,
      details: { reason: StreamReadOnlyReasons.SHARED_COPY },
    }
    expect({ refusals, title: (await rows(world.partner.id))[0].topic_summary }).toEqual({
      refusals: [readOnly, readOnly],
      title: "Database choice",
    })
  })
})
