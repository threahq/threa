import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import {
  AuthorTypes,
  bridgeEventsSchema,
  bridgeManifestSchema,
  bridgeMemoIndexSchema,
  bridgeConversationIndexSchema,
  bridgeConversationsSchema,
  type AuthorType,
  type BridgeActor,
  type BridgeChange,
  type BridgeEvents,
  type BridgeManifest,
  type BridgeMemoIndex,
  type BridgeConversationIndex,
  type BridgeConversations,
} from "@threahq/types"
import { streamConnectionId } from "@threahq/backend-common"
import { addTestMember, createTestStorage, setupIsolatedTestDatabase, testMessageContent } from "./setup"
import { ActorCopyRepository, WorkspaceRepository } from "../../src/features/workspaces"
import { ARIADNE_AGENT_ID, PersonaRepository } from "../../src/features/agents"
import { BotRepository } from "../../src/features/public-api"
import { EventService, MessageRepository } from "../../src/features/messaging"
import { StreamRepository } from "../../src/features/streams"
import { FeatureFlagOverrideRepository, FeatureFlagService } from "../../src/features/feature-flags"
import {
  BridgeClient,
  StreamConnectionExportService,
  StreamConnectionPullService,
  StreamConnectionRepository,
} from "../../src/features/stream-connections"
import { streamId, userId, workspaceId } from "../../src/lib/id"

/** Returns the page as the wire carries it, where a host that predates actor copies sends no `actors`. */
type Tamper = (page: BridgeEvents) => Omit<BridgeEvents, "actors"> & Partial<Pick<BridgeEvents, "actors">>

/** Answers the partner's bridge calls from the host's export service in-process, so a test can alter a page on the way. */
class DirectBridgeClient extends BridgeClient {
  constructor(
    private readonly exporter: StreamConnectionExportService,
    private readonly tamper: Tamper
  ) {
    super({ routerUrl: "http://bridge.invalid", apiKey: "unused" })
  }

  override async getManifest(address: Parameters<BridgeClient["getManifest"]>[0]): Promise<BridgeManifest> {
    return bridgeManifestSchema.parse(await this.exporter.getManifest(address))
  }

  override async listEvents(
    address: Parameters<BridgeClient["listEvents"]>[0],
    params: Parameters<BridgeClient["listEvents"]>[1]
  ): Promise<BridgeEvents> {
    const page = await this.exporter.listEvents({ ...address, ...params })
    return bridgeEventsSchema.parse(this.tamper(page))
  }

  override async getConversationIndex(
    address: Parameters<BridgeClient["getManifest"]>[0]
  ): Promise<BridgeConversationIndex> {
    return bridgeConversationIndexSchema.parse(await this.exporter.getConversationIndex(address))
  }

  override async getConversations(
    address: Parameters<BridgeClient["getManifest"]>[0],
    conversationIds: string[]
  ): Promise<BridgeConversations> {
    return bridgeConversationsSchema.parse(await this.exporter.getConversations({ ...address, conversationIds }))
  }

  override async getMemoIndex(address: Parameters<BridgeClient["getManifest"]>[0]): Promise<BridgeMemoIndex> {
    return bridgeMemoIndexSchema.parse(await this.exporter.getMemoIndex(address))
  }
}

const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id))

describe("Actor copies", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  let exporter: StreamConnectionExportService
  let featureFlagService: FeatureFlagService
  let eventService: EventService

  beforeAll(async () => {
    const isolated = await setupIsolatedTestDatabase("actor_copies")
    pool = isolated.pool
    cleanup = isolated.cleanup
    featureFlagService = new FeatureFlagService(pool)
    exporter = new StreamConnectionExportService({ pool, featureFlagService, storage: createTestStorage() })
    eventService = new EventService(pool)
  }, 120_000)

  afterAll(async () => cleanup(), 120_000)

  async function seedWorkspace(name: string) {
    const id = workspaceId()
    await WorkspaceRepository.insert(pool, { id, name, slug: `actors-${id}`, createdBy: userId() })
    const admin = await addTestMember(pool, id, `admin-${id}`, "admin")
    await FeatureFlagOverrideRepository.replaceForSubject(pool, id, "workspace", id, { streamConnections: "on" })
    return { id, name, adminId: admin.id }
  }

  async function seedPersona(wsId: string, name: string, avatarEmoji: string | null, ownerUserId?: string) {
    return PersonaRepository.insertWorkspacePersona(pool, {
      workspaceId: wsId,
      ownerUserId,
      slug: `persona-${crypto.randomUUID().slice(0, 8)}`,
      config: {
        name,
        description: null,
        avatarEmoji,
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
  }

  async function seedBot(wsId: string, name: string, avatarEmoji: string | null) {
    return BotRepository.create(pool, {
      id: `bot_${crypto.randomUUID().slice(0, 8)}`,
      workspaceId: wsId,
      type: "shared",
      ownerUserId: null,
      slug: `bot-${crypto.randomUUID().slice(0, 8)}`,
      name,
      avatarEmoji,
    })
  }

  /** A host with a shared channel, an active partner, and a host persona and bot with names of their own. */
  async function seedWorld() {
    const host = await seedWorkspace("Actors host")
    const partner = await seedWorkspace("Actors partner")
    const channel = await StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: host.id,
      type: "channel",
      slug: `launch-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Launch",
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
        partnerVisibility: "private",
        acceptedBy: partner.adminId,
        peerWorkspaceIds: [],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    ])
    const persona = await seedPersona(host.id, "Hostly", ":robot_face:")
    const bot = await seedBot(host.id, "Deploy Bot", null)
    const caller = { workspaceId: host.id, connectionId, callerWorkspaceId: partner.id }
    const pull = (tamper: Tamper = (page) => page) =>
      new StreamConnectionPullService({
        pool,
        bridgeClient: new DirectBridgeClient(exporter, tamper),
        featureFlagService,
      }).pull({ workspaceId: partner.id, connectionId })
    return { host, partner, channel, persona, bot, caller, pull }
  }

  type World = Awaited<ReturnType<typeof seedWorld>>

  async function say(world: World, authorId: string, authorType: AuthorType, text: string) {
    return eventService.createMessage({
      workspaceId: world.host.id,
      streamId: world.channel.id,
      authorId,
      authorType,
      ...testMessageContent(text),
    })
  }

  async function react(world: World, messageId: string, reactorId: string, actorType: AuthorType) {
    await eventService.addReactionInternal({
      workspaceId: world.host.id,
      messageId,
      streamId: world.channel.id,
      emoji: ":+1:",
      userId: reactorId,
      actorType,
    })
  }

  async function exportedActors(world: World): Promise<BridgeActor[]> {
    const page = await exporter.listEvents({ ...world.caller, streamId: world.channel.id, after: 0n, limit: 200 })
    return byId(page.actors)
  }

  async function announced(wsId: string) {
    const { rows } = await pool.query<{ actorCopy: unknown }>(
      `SELECT payload->'actorCopy' AS "actorCopy" FROM outbox
       WHERE event_type = 'actor_copy:upserted' AND payload->>'workspaceId' = $1
       ORDER BY id`,
      [wsId]
    )
    return rows.map((row) => row.actorCopy)
  }

  test("should list host custom personas and bots by name and emoji when they author or react, and leave built-ins out", async () => {
    const world = await seedWorld()
    const first = await say(world, world.persona.id, AuthorTypes.PERSONA, "from the persona")
    await say(world, world.bot.id, AuthorTypes.BOT, "from the bot")
    await say(world, ARIADNE_AGENT_ID, AuthorTypes.PERSONA, "from a built-in")
    await react(world, first.id, world.bot.id, AuthorTypes.BOT)

    expect(await exportedActors(world)).toEqual(
      byId([
        { id: world.persona.id, name: "Hostly", avatarEmoji: ":robot_face:" },
        { id: world.bot.id, name: "Deploy Bot", avatarEmoji: null },
      ])
    )
  })

  test("should leave a personal persona out when it authors in the channel", async () => {
    const world = await seedWorld()
    const personal = await seedPersona(world.host.id, "Private Helper", null, world.host.adminId)
    await say(world, personal.id, AuthorTypes.PERSONA, "from a personal persona")
    await say(world, world.persona.id, AuthorTypes.PERSONA, "from the shared persona")

    expect(await exportedActors(world)).toEqual([{ id: world.persona.id, name: "Hostly", avatarEmoji: ":robot_face:" }])
  })

  test("should list a bot that only reacted when it wrote nothing in the channel", async () => {
    const world = await seedWorld()
    const message = await say(world, world.host.adminId, AuthorTypes.USER, "from a person")
    await react(world, message.id, world.bot.id, AuthorTypes.BOT)

    expect(await exportedActors(world)).toEqual([{ id: world.bot.id, name: "Deploy Bot", avatarEmoji: null }])
  })

  test("should write a copy and announce it once per actor when the partner pulls pages that name host actors", async () => {
    const world = await seedWorld()
    const first = await say(world, world.persona.id, AuthorTypes.PERSONA, "from the persona")
    await say(world, ARIADNE_AGENT_ID, AuthorTypes.PERSONA, "from a built-in")
    await react(world, first.id, world.bot.id, AuthorTypes.BOT)

    await world.pull()

    const expected = byId([
      {
        id: world.persona.id,
        workspaceId: world.partner.id,
        originWorkspaceId: world.host.id,
        name: "Hostly",
        avatarEmoji: ":robot_face:",
      },
      {
        id: world.bot.id,
        workspaceId: world.partner.id,
        originWorkspaceId: world.host.id,
        name: "Deploy Bot",
        avatarEmoji: null,
      },
    ])
    expect({
      copies: await ActorCopyRepository.listByWorkspace(pool, world.partner.id),
      announced: byId((await announced(world.partner.id)) as typeof expected),
      hostCopies: await ActorCopyRepository.listByWorkspace(pool, world.host.id),
    }).toEqual({ copies: expected, announced: expected, hostCopies: [] })
  })

  test("should update the copy and announce only the rename when a later page carries a renamed actor, and nothing when it is unchanged", async () => {
    const world = await seedWorld()
    await say(world, world.persona.id, AuthorTypes.PERSONA, "before")
    await say(world, world.bot.id, AuthorTypes.BOT, "before")
    await world.pull()
    const announcedAfterFirst = (await announced(world.partner.id)).length

    await say(world, world.persona.id, AuthorTypes.PERSONA, "unchanged")
    await say(world, world.bot.id, AuthorTypes.BOT, "unchanged")
    await world.pull()
    const announcedAfterUnchanged = (await announced(world.partner.id)).length

    await pool.query(
      "UPDATE personas SET name = 'Hostly Two', avatar_emoji = NULL WHERE workspace_id = $1 AND id = $2",
      [world.host.id, world.persona.id]
    )
    await say(world, world.persona.id, AuthorTypes.PERSONA, "after rename")
    await say(world, world.bot.id, AuthorTypes.BOT, "after rename")
    await world.pull()

    const renamed = {
      id: world.persona.id,
      workspaceId: world.partner.id,
      originWorkspaceId: world.host.id,
      name: "Hostly Two",
      avatarEmoji: null,
    }
    const events = await announced(world.partner.id)
    expect({
      announcedAfterFirst,
      announcedAfterUnchanged,
      copy: (await ActorCopyRepository.listByWorkspace(pool, world.partner.id)).find(
        (copy) => copy.id === world.persona.id
      ),
      latest: events[events.length - 1],
      total: events.length,
    }).toEqual({ announcedAfterFirst: 2, announcedAfterUnchanged: 2, copy: renamed, latest: renamed, total: 3 })
  })

  test("should keep each workspace's copies to itself when two partners copy the same actor", async () => {
    const world = await seedWorld()
    const other = await seedWorkspace("Other partner")
    await ActorCopyRepository.upsert(pool, {
      workspaceId: other.id,
      originWorkspaceId: world.host.id,
      actors: [{ id: world.persona.id, name: "Elsewhere", avatarEmoji: null }],
    })
    await say(world, world.persona.id, AuthorTypes.PERSONA, "hello")

    await world.pull()

    const names = async (wsId: string) =>
      (await ActorCopyRepository.listByWorkspace(pool, wsId)).map(({ id, name }) => ({ id, name }))
    expect({ other: await names(other.id), partner: await names(world.partner.id) }).toEqual({
      other: [{ id: world.persona.id, name: "Elsewhere" }],
      partner: [{ id: world.persona.id, name: "Hostly" }],
    })
  })

  describe("when a page names a user, persona or bot of the partner itself", () => {
    const mapMessages =
      (edit: (message: Extract<BridgeChange, { kind: "message" }>["message"]) => object): Tamper =>
      (page) => ({
        ...page,
        changes: page.changes.map(
          (change): BridgeChange =>
            change.kind === "message" ? { ...change, message: { ...change.message, ...edit(change.message) } } : change
        ),
      })
    const asAuthor = (authorId: string, authorType: AuthorType) => mapMessages(() => ({ authorId, authorType }))
    const asReactor = (reactorId: string) => mapMessages(() => ({ reactions: { ":+1:": [reactorId] } }))
    const asListed =
      (id: string): Tamper =>
      (page) => ({ ...page, actors: [...page.actors, { id, name: "Impostor", avatarEmoji: null }] })

    const cases = [
      ["persona", "author", (id: string) => asAuthor(id, AuthorTypes.PERSONA)],
      ["persona", "author typed as a bot", (id: string) => asAuthor(id, AuthorTypes.BOT)],
      ["persona", "reactor", asReactor],
      ["persona", "listed actor", asListed],
      ["bot", "author", (id: string) => asAuthor(id, AuthorTypes.BOT)],
      ["bot", "author typed as a persona", (id: string) => asAuthor(id, AuthorTypes.PERSONA)],
      ["bot", "reactor", asReactor],
      ["bot", "listed actor", asListed],
      ["user", "author typed as a bot", (id: string) => asAuthor(id, AuthorTypes.BOT)],
    ] as const

    const seedOwn = {
      persona: (world: World) => seedPersona(world.partner.id, "Partner own", null),
      bot: (world: World) => seedBot(world.partner.id, "Partner own", null),
      user: async (world: World) => ({ id: world.partner.adminId }),
    }

    for (const [kind, role, tamper] of cases) {
      test(`should refuse the page and write nothing when it names a partner ${kind} as ${role}`, async () => {
        const world = await seedWorld()
        const own = await seedOwn[kind](world)
        const message = await say(world, world.persona.id, AuthorTypes.PERSONA, "hello")

        await expect(world.pull(tamper(own.id))).rejects.toThrow(own.id)

        expect({
          copies: await ActorCopyRepository.listByWorkspace(pool, world.partner.id),
          announced: await announced(world.partner.id),
          messageCopied: (await MessageRepository.findByIds(pool, world.partner.id, [message.id])).has(message.id),
        }).toEqual({ copies: [], announced: [], messageCopied: false })
      })
    }
  })

  test("should refuse the page and write nothing when it lists a built-in persona as an actor to copy", async () => {
    const world = await seedWorld()
    const message = await say(world, world.persona.id, AuthorTypes.PERSONA, "hello")
    const listsBuiltIn: Tamper = (page) => ({
      ...page,
      actors: [...page.actors, { id: ARIADNE_AGENT_ID, name: "Ariadne", avatarEmoji: null }],
    })

    await expect(world.pull(listsBuiltIn)).rejects.toThrow("is built in and cannot be copied")

    expect({
      copies: await ActorCopyRepository.listByWorkspace(pool, world.partner.id),
      announced: await announced(world.partner.id),
      messageCopied: (await MessageRepository.findByIds(pool, world.partner.id, [message.id])).has(message.id),
    }).toEqual({ copies: [], announced: [], messageCopied: false })
  })

  test("should copy the messages and no actors when the host predates actor copies", async () => {
    const world = await seedWorld()
    const message = await say(world, world.persona.id, AuthorTypes.PERSONA, "hello")
    await react(world, message.id, world.bot.id, AuthorTypes.BOT)

    await world.pull((page) => ({ ...page, actors: undefined }))

    expect({
      copies: await ActorCopyRepository.listByWorkspace(pool, world.partner.id),
      messageCopied: (await MessageRepository.findByIds(pool, world.partner.id, [message.id])).has(message.id),
    }).toEqual({ copies: [], messageCopied: true })
  })

  test("should copy the messages when a built-in persona authors or reacts in the page", async () => {
    const world = await seedWorld()
    const message = await say(world, ARIADNE_AGENT_ID, AuthorTypes.PERSONA, "from a built-in")
    await react(world, message.id, ARIADNE_AGENT_ID, AuthorTypes.PERSONA)

    await world.pull()

    const copy = (await MessageRepository.findByIds(pool, world.partner.id, [message.id])).get(message.id)
    expect({
      authorId: copy?.authorId,
      reactions: copy?.reactions,
      copies: await ActorCopyRepository.listByWorkspace(pool, world.partner.id),
    }).toEqual({ authorId: ARIADNE_AGENT_ID, reactions: { ":+1:": [ARIADNE_AGENT_ID] }, copies: [] })
  })

  describe("when an actor id already has a copy from another workspace", () => {
    const unlisted: Tamper = (page) => ({ ...page, actors: [] })
    const cases = [
      ["lists it", undefined],
      ["names it without listing it", unlisted],
    ] as const

    for (const [how, tamper] of cases) {
      test(`should refuse the page, keep that copy and copy nothing when the page ${how}`, async () => {
        const world = await seedWorld()
        const elsewhere = await seedWorkspace("Elsewhere host")
        const original = { id: world.persona.id, name: "Original", avatarEmoji: null }
        await ActorCopyRepository.upsert(pool, {
          workspaceId: world.partner.id,
          originWorkspaceId: elsewhere.id,
          actors: [original],
        })
        const message = await say(world, world.persona.id, AuthorTypes.PERSONA, "hello")
        await react(world, message.id, world.bot.id, AuthorTypes.BOT)

        await expect(world.pull(tamper)).rejects.toThrow(`Actor ${world.persona.id} in a page of connection`)

        expect({
          copies: await ActorCopyRepository.listByWorkspace(pool, world.partner.id),
          announced: await announced(world.partner.id),
        }).toEqual({
          copies: [{ ...original, workspaceId: world.partner.id, originWorkspaceId: elsewhere.id }],
          announced: [],
        })
      })
    }
  })
})
