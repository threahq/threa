import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import {
  AuthorTypes,
  ConversationStatuses,
  StreamErrorCodes,
  StreamReadOnlyReasons,
  bridgeEventsSchema,
  bridgeManifestSchema,
  bridgeMemoIndexSchema,
  bridgeMemosSchema,
  bridgeConversationIndexSchema,
  bridgeConversationsSchema,
  type BridgeEvents,
  type BridgeManifest,
  type BridgeMemo,
  type BridgeMemoIndex,
  type BridgeMemos,
  type BridgeConversationIndex,
  type BridgeConversations,
} from "@threahq/types"
import { HttpError, streamConnectionId } from "@threahq/backend-common"
import { addTestMember, createTestStorage, setupIsolatedTestDatabase, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { EventService } from "../../src/features/messaging"
import { StreamRepository } from "../../src/features/streams"
import { ConversationRepository } from "../../src/features/conversations"
import {
  MemoExplorerService,
  MemoRepository,
  StubReranker,
  type EmbeddingServiceLike,
  type InsertMemoParams,
} from "../../src/features/memos"
import { FeatureFlagOverrideRepository, FeatureFlagService } from "../../src/features/feature-flags"
import {
  BridgeClient,
  StreamConnectionExportService,
  StreamConnectionPullService,
  StreamConnectionRepository,
} from "../../src/features/stream-connections"
import { conversationId, eventId, memoId, streamId, userId, workspaceId } from "../../src/lib/id"

type Address = Parameters<BridgeClient["getManifest"]>[0]

/** Answers the partner's bridge calls from the host's export service in-process. */
class DirectBridgeClient extends BridgeClient {
  readonly memoFetches: string[][] = []
  /** Rewrites what the host answers, standing in for a host that misbehaves or raced the partner's pull. */
  tamper: ((memos: BridgeMemo[]) => BridgeMemo[]) | null = null
  /** Runs once after the host answers the next fetch, before the partner writes what it got. */
  beforeNextWrite: (() => Promise<void>) | null = null

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
    return bridgeConversationsSchema.parse(await this.exporter.getConversations({ ...address, conversationIds }))
  }

  override async getMemoIndex(address: Address): Promise<BridgeMemoIndex> {
    return bridgeMemoIndexSchema.parse(await this.exporter.getMemoIndex(address))
  }

  override async getMemos(address: Address, memoIds: string[]): Promise<BridgeMemos> {
    this.memoFetches.push(memoIds)
    const { memos } = bridgeMemosSchema.parse(await this.exporter.getMemos({ ...address, memoIds }))
    const interleaved = this.beforeNextWrite
    this.beforeNextWrite = null
    if (interleaved) await interleaved()
    return { memos: this.tamper ? this.tamper(memos) : memos }
  }
}

const EMBEDDING = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))

describe("Memos in a shared channel's copy", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  let exporter: StreamConnectionExportService
  let featureFlagService: FeatureFlagService
  let eventService: EventService

  beforeAll(async () => {
    const isolated = await setupIsolatedTestDatabase("memo_copies")
    pool = isolated.pool
    cleanup = isolated.cleanup
    featureFlagService = new FeatureFlagService(pool)
    exporter = new StreamConnectionExportService({ pool, featureFlagService, storage: createTestStorage() })
    eventService = new EventService(pool)
  }, 120_000)

  afterAll(async () => cleanup(), 120_000)

  async function seedWorkspace(name: string) {
    const id = workspaceId()
    await WorkspaceRepository.insert(pool, { id, name, slug: `memos-${id}`, createdBy: userId() })
    const admin = await addTestMember(pool, id, `admin-${id}`, "admin")
    await FeatureFlagOverrideRepository.replaceForSubject(pool, id, "workspace", id, { streamConnections: "on" })
    return { id, name, adminId: admin.id }
  }

  async function seedWorld(partnerVisibility: "private" | "public" = "private") {
    const host = await seedWorkspace("Memo host")
    const partner = await seedWorkspace("Memo partner")
    const channel = await StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: host.id,
      type: "channel",
      slug: `memos-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Memos",
      visibility: "public",
      createdBy: host.adminId,
    })
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
        partnerVisibility,
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

  async function hostMessage(world: World, text: string) {
    return eventService.createMessage({
      workspaceId: world.host.id,
      streamId: world.channel.id,
      authorId: world.host.adminId,
      authorType: AuthorTypes.USER,
      ...testMessageContent(text),
    })
  }

  async function hostConversation(world: World, inStreamId = world.channel.id): Promise<string> {
    const id = conversationId()
    await ConversationRepository.insert(pool, {
      id,
      streamId: inStreamId,
      workspaceId: world.host.id,
      status: ConversationStatuses.RESOLVED,
    })
    return id
  }

  /** A memo the host captured from `conversation` while the channel was shared, unless `overrides` say otherwise. */
  async function hostMemo(
    world: World,
    conversation: string,
    title: string,
    sourceMessageIds: string[],
    overrides: Partial<InsertMemoParams> = {}
  ): Promise<string> {
    const id = memoId()
    await MemoRepository.insert(pool, {
      id,
      workspaceId: world.host.id,
      memoType: "conversation",
      sourceConversationId: conversation,
      title,
      abstract: `${title} abstract`,
      keyPoints: [`${title} point`],
      sourceMessageIds,
      participantIds: [world.host.adminId],
      knowledgeType: "decision",
      tags: ["shared"],
      sharedRootStreamId: world.channel.id,
      ...overrides,
    })
    await MemoRepository.updateEmbedding(pool, world.host.id, id, EMBEDDING)
    return id
  }

  async function partnerCopies(world: World) {
    const { rows } = await pool.query(
      `SELECT id, memo_type, source_conversation_id, title, abstract, key_points, source_message_ids, participant_ids,
              knowledge_type, tags, status, card_version, scope, authored_by_kind, shared_root_stream_id,
              origin_workspace_id, embedding IS NOT NULL AS embedded
       FROM memos WHERE workspace_id = $1 ORDER BY title`,
      [world.partner.id]
    )
    return rows
  }

  async function partnerCaptures(world: World) {
    const { rows } = await pool.query(
      `SELECT stream_id, payload FROM stream_events
       WHERE workspace_id = $1 AND event_type = 'memos:captured' ORDER BY payload->>'conversationId'`,
      [world.partner.id]
    )
    return rows
  }

  async function partnerLandmarks(world: World) {
    const { rows } = await pool.query(
      `SELECT stream_id, ref_id, source_message_id, detail FROM stream_context_items
       WHERE workspace_id = $1 AND category = 'memo' ORDER BY ref_id`,
      [world.partner.id]
    )
    return rows
  }

  async function partnerMemoCreatedOutbox(world: World) {
    const { rows } = await pool.query(
      `SELECT payload FROM outbox WHERE event_type = 'memo:created' AND payload->>'workspaceId' = $1
       ORDER BY payload->>'memoId'`,
      [world.partner.id]
    )
    return rows.map((row) => row.payload)
  }

  test("should copy each memo the host captured while sharing, and show it captured in its stream, when the partner pulls", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const first = await hostConversation(world)
    const second = await hostConversation(world)
    const db = await hostMemo(world, first, "A database", [message.id])
    const queue = await hostMemo(world, first, "B queue", [message.id])
    const cache = await hostMemo(world, second, "C cache", [message.id])
    await hostMemo(world, second, "D before share", [message.id], { sharedRootStreamId: undefined })

    expect(await world.pull()).toBe(true)

    const copy = (id: string, conversation: string, title: string) => ({
      id,
      memo_type: "conversation",
      source_conversation_id: conversation,
      title,
      abstract: `${title} abstract`,
      key_points: [`${title} point`],
      source_message_ids: [message.id],
      participant_ids: [world.host.adminId],
      knowledge_type: "decision",
      tags: ["shared"],
      status: "active",
      card_version: 1,
      scope: "workspace",
      authored_by_kind: "pipeline",
      shared_root_stream_id: world.channel.id,
      origin_workspace_id: world.host.id,
      embedded: true,
    })
    const captured = (id: string, title: string) => ({
      memoId: id,
      title,
      knowledgeType: "decision",
      sourceMessageIds: [message.id],
    })
    const landmark = (id: string, title: string) => ({
      stream_id: world.channel.id,
      ref_id: id,
      source_message_id: message.id,
      detail: { title, knowledgeType: "decision" },
    })
    expect({
      copies: await partnerCopies(world),
      captures: await partnerCaptures(world),
      landmarks: await partnerLandmarks(world),
      created: await partnerMemoCreatedOutbox(world),
    }).toEqual({
      copies: [copy(db, first, "A database"), copy(queue, first, "B queue"), copy(cache, second, "C cache")],
      captures: [
        {
          stream_id: world.channel.id,
          payload: { conversationId: first, memos: [captured(db, "A database"), captured(queue, "B queue")] },
        },
        { stream_id: world.channel.id, payload: { conversationId: second, memos: [captured(cache, "C cache")] } },
      ].sort((a, b) => a.payload.conversationId.localeCompare(b.payload.conversationId)),
      landmarks: [landmark(db, "A database"), landmark(queue, "B queue"), landmark(cache, "C cache")].sort((a, b) =>
        a.ref_id.localeCompare(b.ref_id)
      ),
      created: [db, queue, cache]
        .sort()
        .map((id) => ({ workspaceId: world.partner.id, streamId: world.channel.id, memoId: id })),
    })
  })

  test("should rewrite a copy without a second capture when the host edits its card, and fetch nothing when the host changed nothing", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const conversation = await hostConversation(world)
    const memo = await hostMemo(world, conversation, "Database", [message.id])
    await world.pull()
    await MemoRepository.update(pool, world.host.id, memo, { title: "Database, edited" })

    await world.pull()
    world.bridgeClient.memoFetches.length = 0
    await world.pull()

    const [copy] = await partnerCopies(world)
    expect({
      title: copy.title,
      cardVersion: copy.card_version,
      captures: await partnerCaptures(world),
      fetchesWithoutChange: world.bridgeClient.memoFetches,
    }).toEqual({
      title: "Database, edited",
      cardVersion: 2,
      captures: [
        {
          stream_id: world.channel.id,
          payload: {
            conversationId: conversation,
            memos: [{ memoId: memo, title: "Database", knowledgeType: "decision", sourceMessageIds: [message.id] }],
          },
        },
      ],
      fetchesWithoutChange: [],
    })
  })

  test("should repaint the partner's cards citing a copy when the host edits the memo", async () => {
    const world = await seedWorld("public")
    const message = await hostMessage(world, "we picked postgres")
    const conversation = await hostConversation(world)
    const memo = await hostMemo(world, conversation, "Database", [message.id])
    await world.pull()
    const notes = await StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: world.partner.id,
      type: "channel",
      slug: `notes-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Notes",
      visibility: "public",
      createdBy: world.partner.adminId,
    })
    await eventService.createMessage({
      workspaceId: world.partner.id,
      streamId: notes.id,
      authorId: world.partner.adminId,
      authorType: AuthorTypes.USER,
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "memoEmbed", attrs: { memoId: memo, title: "Database" } }] }],
      },
      contentMarkdown: `[Database](memo:${memo})`,
    })
    await MemoRepository.update(pool, world.host.id, memo, { title: "Database, edited" })

    await world.pull()

    const { rows } = await pool.query(
      `SELECT payload FROM outbox WHERE event_type = 'memo:updated' AND payload->>'workspaceId' = $1`,
      [world.partner.id]
    )
    expect(
      rows.map(({ payload }) => ({
        streamId: payload.streamId,
        memoId: payload.memoId,
        title: payload.summary.title,
        version: payload.summary.version,
      }))
    ).toEqual([{ streamId: notes.id, memoId: memo, title: "Database, edited", version: 2 }])
  })

  test("should delete the copy when the host stops sharing the memo, and keep the rest", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const conversation = await hostConversation(world)
    const kept = await hostMemo(world, conversation, "Kept", [message.id])
    const archived = await hostMemo(world, conversation, "Archived", [message.id])
    await world.pull()
    await MemoRepository.archive(pool, world.host.id, archived)

    await world.pull()

    expect((await partnerCopies(world)).map((row) => row.id)).toEqual([kept])
  })

  test("should delete the withdrawn copy when another memo's update fails the pull", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const conversation = await hostConversation(world)
    const edited = await hostMemo(world, conversation, "Edited", [message.id])
    const archived = await hostMemo(world, conversation, "Archived", [message.id])
    await world.pull()
    await MemoRepository.archive(pool, world.host.id, archived)
    await MemoRepository.update(pool, world.host.id, edited, { title: "Edited again" })
    const own = await StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: world.partner.id,
      type: "channel",
      slug: `own-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Own",
      visibility: "public",
      createdBy: world.partner.adminId,
    })
    world.bridgeClient.tamper = (memos) => memos.map((m) => ({ ...m, streamId: own.id }))

    await expect(world.pull()).rejects.toThrow(`Stream ${own.id} in ${world.partner.id} is not a copy`)

    expect((await partnerCopies(world)).map((row) => ({ id: row.id, title: row.title }))).toEqual([
      { id: edited, title: "Edited" },
    ])
  })

  test("should leave a memo for a later pull when the partner has no copy of its stream yet", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const memo = await hostMemo(world, await hostConversation(world), "Database", [message.id])
    world.bridgeClient.tamper = (memos) => memos.map((m) => ({ ...m, streamId: streamId() }))

    expect(await world.pull()).toBe(true)
    const beforeCopy = await partnerCopies(world)
    world.bridgeClient.tamper = null
    await world.pull()

    expect({ beforeCopy, afterCopy: (await partnerCopies(world)).map((row) => row.id) }).toEqual({
      beforeCopy: [],
      afterCopy: [memo],
    })
  })

  test("should fail the pull and write nothing when a memo names a stream of the partner's own", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    await hostMemo(world, await hostConversation(world), "Database", [message.id])
    const own = await StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: world.partner.id,
      type: "channel",
      slug: `own-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Own",
      visibility: "public",
      createdBy: world.partner.adminId,
    })
    world.bridgeClient.tamper = (memos) => memos.map((m) => ({ ...m, streamId: own.id }))

    await expect(world.pull()).rejects.toThrow(`Stream ${own.id} in ${world.partner.id} is not a copy`)

    expect({ copies: await partnerCopies(world), captures: await partnerCaptures(world) }).toEqual({
      copies: [],
      captures: [],
    })
  })

  test("should fail the pull and leave the partner's memo alone when it shares an id with a host memo", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const memo = await hostMemo(world, await hostConversation(world), "Database", [message.id])
    await MemoRepository.insert(pool, {
      id: memo,
      workspaceId: world.partner.id,
      memoType: "conversation",
      sourceConversationId: conversationId(),
      title: "Partner's own",
      abstract: "Partner's own abstract",
      sourceMessageIds: [],
      participantIds: [world.partner.adminId],
      knowledgeType: "context",
    })

    await expect(world.pull()).rejects.toThrow(
      `Memo ${memo} in ${world.partner.id} is not a copy in connection ${world.connectionId}`
    )

    expect({
      memos: (await partnerCopies(world)).map((row) => ({
        id: row.id,
        title: row.title,
        origin: row.origin_workspace_id,
      })),
      captures: await partnerCaptures(world),
    }).toEqual({ memos: [{ id: memo, title: "Partner's own", origin: null }], captures: [] })
  })

  test("should copy and announce a memo once when another pull writes it between this pull's fetch and write", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const conversation = await hostConversation(world)
    const memo = await hostMemo(world, conversation, "Database", [message.id])
    let interleaved: boolean | undefined
    world.bridgeClient.beforeNextWrite = async () => {
      interleaved = await world.pull()
    }

    const outer = await world.pull()

    expect({
      pulls: [outer, interleaved],
      copies: (await partnerCopies(world)).map((row) => row.id),
      captures: await partnerCaptures(world),
      landmarks: (await partnerLandmarks(world)).map((row) => row.ref_id),
      created: await partnerMemoCreatedOutbox(world),
    }).toEqual({
      pulls: [true, true],
      copies: [memo],
      captures: [
        {
          stream_id: world.channel.id,
          payload: {
            conversationId: conversation,
            memos: [{ memoId: memo, title: "Database", knowledgeType: "decision", sourceMessageIds: [message.id] }],
          },
        },
      ],
      landmarks: [memo],
      created: [{ workspaceId: world.partner.id, streamId: world.channel.id, memoId: memo }],
    })
  })

  test("should fetch changed memos in bounded batches when more changed than one request carries", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const conversation = await hostConversation(world)
    const memos: string[] = []
    for (let i = 0; i < 26; i++) {
      memos.push(await hostMemo(world, conversation, `Memo ${String(i).padStart(2, "0")}`, [message.id]))
    }

    await world.pull()

    expect({
      copies: (await partnerCopies(world)).map((row) => row.id).sort(),
      fetchSizes: world.bridgeClient.memoFetches.map((ids) => ids.length),
    }).toEqual({ copies: [...memos].sort(), fetchSizes: [25, 1] })
  })

  test("should share only workspace memos from the channel and its message threads, naming only people who took part there", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const outsider = await addTestMember(pool, world.host.id, `outsider-${world.host.id}`, "member")
    const conversation = await hostConversation(world)
    const otherChannel = await StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: world.host.id,
      type: "channel",
      slug: `other-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Other",
      visibility: "public",
      createdBy: world.host.adminId,
    })
    const cardThread = await StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: world.host.id,
      type: "thread",
      parentStreamId: world.channel.id,
      parentAnchorId: eventId(),
      rootStreamId: world.channel.id,
      visibility: "public",
      createdBy: world.host.adminId,
    })
    const shared = await hostMemo(world, conversation, "Shared", [message.id], {
      participantIds: [world.host.adminId, outsider.id],
    })
    const personal = await hostMemo(world, conversation, "Personal", [message.id], {
      scope: "user",
      scopeUserId: world.host.adminId,
    })
    const fromCardThread = await hostMemo(world, await hostConversation(world, cardThread.id), "Card thread", [
      message.id,
    ])
    const otherRoot = await hostMemo(world, conversation, "Other root", [message.id], {
      sharedRootStreamId: otherChannel.id,
    })
    const caller = { workspaceId: world.host.id, connectionId: world.connectionId, callerWorkspaceId: world.partner.id }

    const index = await exporter.getMemoIndex(caller)
    const { memos } = await exporter.getMemos({ ...caller, memoIds: [shared, personal, fromCardThread, otherRoot] })

    expect({ index, bodies: memos.map((memo) => ({ id: memo.id, participantIds: memo.participantIds })) }).toEqual({
      index: { memos: [{ id: shared, cardVersion: 1 }] },
      bodies: [{ id: shared, participantIds: [world.host.adminId] }],
    })
  })

  test("should refuse to edit, archive, restore or delete a copy in the partner's memory explorer", async () => {
    const world = await seedWorld()
    const message = await hostMessage(world, "we picked postgres")
    const memo = await hostMemo(world, await hostConversation(world), "Database", [message.id])
    await world.pull()
    const explorer = new MemoExplorerService({
      pool,
      embeddingService: { embed: async () => EMBEDDING } as unknown as EmbeddingServiceLike,
      reranker: new StubReranker(),
    })
    const permissions = {
      accessibleStreamIds: [world.channel.id],
      userId: world.partner.adminId,
      audiences: [{ kind: "users" as const, userIds: [world.partner.adminId] }],
    }

    const refusals = await Promise.all(
      [
        () => explorer.update(world.partner.id, memo, permissions, { title: "Mine now" }),
        () => explorer.archive(world.partner.id, memo, permissions),
        () => explorer.unarchive(world.partner.id, memo, permissions),
        () => explorer.delete(world.partner.id, memo, permissions),
      ].map((act) =>
        act().then(
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
    expect({ refusals, title: (await partnerCopies(world))[0].title }).toEqual({
      refusals: [readOnly, readOnly, readOnly, readOnly],
      title: "Database",
    })
  })
})
