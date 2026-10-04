import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import {
  AuthorTypes,
  StreamConnectionErrorCodes,
  StreamTypes,
  type BridgeWriteUser,
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
import { PersonaRepository } from "../../src/features/agents"
import { AttachmentRepository } from "../../src/features/attachments"
import { EventService, MessageRepository } from "../../src/features/messaging"
import { StreamRepository } from "../../src/features/streams"
import { FeatureFlagOverrideRepository, FeatureFlagService } from "../../src/features/feature-flags"
import { UserRepository, WorkspaceRepository, syncUserCopies } from "../../src/features/workspaces"
import {
  StreamConnectionExportService,
  StreamConnectionRepository,
  StreamConnectionWriteService,
} from "../../src/features/stream-connections"
import { attachmentId, messageId, streamId, userId, workspaceId } from "../../src/lib/id"

const REFUSED = { status: 403, code: StreamConnectionErrorCodes.WRITE_REFUSED }
const NOT_FOUND = { status: 404, code: StreamConnectionErrorCodes.NOT_FOUND }

describe("A partner's writes to a shared channel", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  let writer: StreamConnectionWriteService
  let exporter: StreamConnectionExportService
  let eventService: EventService

  beforeAll(async () => {
    const isolated = await setupIsolatedTestDatabase("connection_writes")
    pool = isolated.pool
    cleanup = isolated.cleanup
    const featureFlagService = new FeatureFlagService(pool)
    eventService = new EventService(pool)
    writer = new StreamConnectionWriteService({ pool, featureFlagService, eventService })
    exporter = new StreamConnectionExportService({ pool, featureFlagService, storage: createTestStorage() })
  }, 120_000)

  afterAll(async () => cleanup(), 120_000)

  async function seedWorkspace(name: string) {
    const id = workspaceId()
    await WorkspaceRepository.insert(pool, { id, name, slug: `writes-${id}`, createdBy: userId() })
    const admin = await addTestMember(pool, id, `admin-${id}`, "admin")
    await FeatureFlagOverrideRepository.replaceForSubject(pool, id, "workspace", id, { streamConnections: "on" })
    return { id, name, adminId: admin.id, adminSlug: admin.slug }
  }

  async function seedChannel(hostId: string, createdBy: string, visibility: "public" | "private" = "public") {
    return StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: hostId,
      type: StreamTypes.CHANNEL,
      slug: `writes-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Writes",
      visibility,
      createdBy,
    })
  }

  async function seedThread(hostId: string, root: string, createdBy: string, anchorId: string = messageId()) {
    return StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: hostId,
      type: StreamTypes.THREAD,
      visibility: "public",
      parentStreamId: root,
      parentAnchorId: anchorId,
      rootStreamId: root,
      createdBy,
    })
  }

  function partnerUser(name: string): BridgeWriteUser {
    return { id: userId(), name, slug: name.toLowerCase() }
  }

  /** A host with a shared channel and one active partner. */
  async function seedWorld(visibility: "public" | "private" = "public") {
    const host = await seedWorkspace("Writes host")
    const partner = await seedWorkspace("Writes partner")
    const channel = await seedChannel(host.id, host.adminId, visibility)
    const connectionId = streamConnectionId()
    const snapshot = {
      id: connectionId,
      revision: 2,
      state: "active" as const,
      hostWorkspaceId: host.id,
      hostWorkspaceName: host.name,
      hostRegion: "local",
      hostStreamId: channel.id,
      invitedBy: host.adminId,
      partnerWorkspaceId: partner.id,
      partnerWorkspaceName: partner.name,
      partnerRegion: "local",
      partnerVisibility: "private" as const,
      acceptedBy: partner.adminId,
      peerWorkspaceIds: [],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }
    await StreamConnectionRepository.applySnapshots(pool, [snapshot])
    const caller = { workspaceId: host.id, connectionId, callerWorkspaceId: partner.id }
    return { host, partner, channel, connectionId, snapshot, caller, pat: partnerUser("Pat"), sam: partnerUser("Sam") }
  }

  type World = Awaited<ReturnType<typeof seedWorld>>

  /** A user of a third workspace, whose copy the host holds. */
  async function seedThirdWorkspaceUser(world: World) {
    const third = await seedWorkspace("Writes third")
    const user = partnerUser("Tess")
    await syncUserCopies(pool, {
      workspaceId: world.host.id,
      originWorkspaceId: third.id,
      originWorkspaceName: third.name,
      users: [user],
    })
    return user
  }

  function send(
    world: World,
    content: JSONContent | string,
    overrides: Partial<Parameters<typeof writer.sendMessage>[0]> = {}
  ) {
    return writer.sendMessage({
      ...world.caller,
      streamId: world.channel.id,
      author: world.pat,
      users: [],
      clientMessageId: `client-${crypto.randomUUID()}`,
      contentJson: typeof content === "string" ? testContentJson(content) : content,
      ...overrides,
    })
  }

  async function hostSays(world: World, text: string, streamIdOverride = world.channel.id) {
    return eventService.createMessage({
      workspaceId: world.host.id,
      streamId: streamIdOverride,
      authorId: world.host.adminId,
      authorType: AuthorTypes.USER,
      ...testMessageContent(text),
    })
  }

  async function stored(world: World, id: string) {
    return MessageRepository.findById(pool, world.host.id, id)
  }

  /** What a refused write reports, so a test compares the whole outcome. */
  async function outcome(write: Promise<unknown>) {
    try {
      await write
      return "accepted"
    } catch (error) {
      const { status, code } = error as { status?: number; code?: string }
      return { status, code }
    }
  }

  const mention = (id: string, slug: string): JSONContent => ({
    type: "mention",
    attrs: { id, slug, mentionType: "user" },
  })

  test("should land a host message authored by a copy of the partner's user when the partner sends", async () => {
    const world = await seedWorld()

    const { messageId: id } = await send(world, "hello from the partner", { clientMessageId: "client-1" })

    expect({
      message: await stored(world, id),
      user: await UserRepository.findById(pool, world.host.id, world.pat.id),
    }).toMatchObject({
      message: {
        id,
        streamId: world.channel.id,
        authorId: world.pat.id,
        authorType: "user",
        contentMarkdown: "hello from the partner",
        clientMessageId: "client-1",
      },
      user: { id: world.pat.id, name: "Pat", originWorkspaceId: world.partner.id, email: null },
    })
  })

  test("should create one message when the same client message id is sent twice", async () => {
    const world = await seedWorld()

    const first = await send(world, "once", { clientMessageId: "client-dup" })
    const second = await send(world, "once", { clientMessageId: "client-dup" })

    const { rows } = await pool.query(
      "SELECT id FROM messages WHERE workspace_id = $1 AND stream_id = $2 AND client_message_id = 'client-dup'",
      [world.host.id, world.channel.id]
    )
    expect({ second, rows }).toEqual({ second: first, rows: [{ id: first.messageId }] })
  })

  test("should refuse the send when another user already sent under the client message id", async () => {
    const world = await seedWorld()
    await send(world, "mine", { clientMessageId: "client-taken" })

    expect(await outcome(send(world, "yours", { author: world.sam, clientMessageId: "client-taken" }))).toEqual(REFUSED)
  })

  test("should change the content when the author edits their message", async () => {
    const world = await seedWorld()
    const { messageId: id } = await send(world, "first draft")

    await writer.editMessage({
      ...world.caller,
      streamId: world.channel.id,
      messageId: id,
      author: world.pat,
      users: [],
      contentJson: testContentJson("second draft"),
    })

    expect(await stored(world, id)).toMatchObject({ contentMarkdown: "second draft", revision: 2 })
  })

  test("should refuse an edit and a delete when the message is another author's", async () => {
    const world = await seedWorld()
    const hostMessage = await hostSays(world, "host words")
    const { messageId: patsId } = await send(world, "pat words")
    const target = (id: string) => ({ ...world.caller, streamId: world.channel.id, messageId: id })
    const edit = (id: string, author: BridgeWriteUser) =>
      writer.editMessage({ ...target(id), author, users: [], contentJson: testContentJson("rewritten") })

    const outcomes = await Promise.all([
      outcome(edit(hostMessage.id, world.pat)),
      outcome(edit(patsId, world.sam)),
      outcome(writer.deleteMessage({ ...target(hostMessage.id), authorId: world.pat.id })),
      outcome(writer.deleteMessage({ ...target(patsId), authorId: world.sam.id })),
    ])

    expect({
      outcomes,
      host: (await stored(world, hostMessage.id))?.contentMarkdown,
      pat: (await stored(world, patsId))?.contentMarkdown,
      deleted: [(await stored(world, hostMessage.id))?.deletedAt, (await stored(world, patsId))?.deletedAt],
    }).toEqual({
      outcomes: [REFUSED, REFUSED, REFUSED, REFUSED],
      host: "host words",
      pat: "pat words",
      deleted: [null, null],
    })
  })

  test("should delete the message when its author deletes it", async () => {
    const world = await seedWorld()
    const { messageId: id } = await send(world, "to delete")

    await writer.deleteMessage({ ...world.caller, streamId: world.channel.id, messageId: id, authorId: world.pat.id })

    expect((await stored(world, id))?.deletedAt).not.toBeNull()
  })

  test("should refuse a send when the stream or one above it is archived, or it is outside the shared tree", async () => {
    const world = await seedWorld()
    const adminId = world.host.adminId
    const thread = await seedThread(world.host.id, world.channel.id, adminId, (await hostSays(world, "a")).id)
    const sibling = await seedThread(world.host.id, world.channel.id, adminId, (await hostSays(world, "b")).id)
    const elsewhere = await seedChannel(world.host.id, adminId)
    const unsharedThread = await seedThread(world.host.id, elsewhere.id, adminId)
    const sendTo = (id: string) => outcome(send(world, "hi", { streamId: id }))

    const live = await sendTo(thread.id)
    await StreamRepository.update(pool, world.host.id, thread.id, { archivedAt: new Date() })
    const archived = await sendTo(thread.id)
    await StreamRepository.update(pool, world.host.id, world.channel.id, { archivedAt: new Date() })
    const underArchived = await sendTo(sibling.id)
    const outside = await Promise.all([sendTo(elsewhere.id), sendTo(unsharedThread.id)])

    expect([live, archived, underArchived, ...outside]).toEqual(["accepted", REFUSED, REFUSED, REFUSED, REFUSED])
  })

  test("should refuse a send when its author is a host user or another workspace's copy", async () => {
    const world = await seedWorld()
    const thirdUser = await seedThirdWorkspaceUser(world)
    const hostUser: BridgeWriteUser = { id: world.host.adminId, name: "Impostor", slug: "impostor" }

    const outcomes = await Promise.all([
      outcome(send(world, "as host", { author: hostUser })),
      outcome(send(world, "as third", { author: thirdUser })),
      outcome(send(world, "mentioning host", { users: [hostUser] })),
    ])

    const { rows } = await pool.query("SELECT name FROM users WHERE workspace_id = $1 AND id = $2", [
      world.host.id,
      world.host.adminId,
    ])
    expect({ outcomes, hostUserName: rows[0].name }).toEqual({
      outcomes: [REFUSED, REFUSED, REFUSED],
      hostUserName: expect.not.stringMatching("Impostor"),
    })
  })

  test("should answer 404 when the connection is not active, names another caller, or is the partner's own row", async () => {
    const world = await seedWorld()
    const stranger = await seedWorkspace("Writes stranger")
    const sendAs = (caller: typeof world.caller) =>
      outcome(send(world, "hi", { ...caller, streamId: world.channel.id }))
    const asStranger = await sendAs({ ...world.caller, callerWorkspaceId: stranger.id })
    const asPartnerRow = await sendAs({ ...world.caller, workspaceId: world.partner.id })
    await StreamConnectionRepository.applySnapshots(pool, [{ ...world.snapshot, revision: 3, state: "revoked" }])
    const afterRevoke = await sendAs(world.caller)

    expect([asStranger, asPartnerRow, afterRevoke]).toEqual([NOT_FOUND, NOT_FOUND, NOT_FOUND])
  })

  test("should answer 404 when the host has Connect off", async () => {
    const world = await seedWorld()
    await FeatureFlagOverrideRepository.replaceForSubject(pool, world.host.id, "workspace", world.host.id, {
      streamConnections: "off",
    })

    expect(await outcome(send(world, "hi"))).toEqual(NOT_FOUND)
  })

  test("should keep mentions of host users and the partner's own users and flatten every other mention when the partner sends", async () => {
    const world = await seedWorld()
    const thirdUser = await seedThirdWorkspaceUser(world)
    const persona = await PersonaRepository.insertWorkspacePersona(pool, {
      workspaceId: world.host.id,
      slug: "hostly",
      config: {
        name: "Hostly",
        description: null,
        avatarEmoji: null,
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
    const hostMention = mention(world.host.adminId, world.host.adminSlug)
    const ownMention = mention(world.sam.id, "sam")
    const content: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            hostMention,
            { type: "text", text: " " },
            ownMention,
            { type: "text", text: " " },
            { type: "mention", attrs: { id: persona.id, slug: "hostly", mentionType: "persona" } },
            { type: "text", text: " " },
            mention(thirdUser.id, "tess-writes-third"),
            { type: "text", text: " " },
            { type: "mention", attrs: { id: "broadcast:channel", slug: "channel", mentionType: "broadcast" } },
          ],
        },
      ],
    }

    const { messageId: id } = await send(world, content, { users: [world.sam] })

    expect((await stored(world, id))?.contentJson).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            hostMention,
            { type: "text", text: " " },
            ownMention,
            { type: "text", text: " " },
            { type: "text", text: "@hostly" },
            { type: "text", text: " " },
            { type: "text", text: "@tess-writes-third" },
            { type: "text", text: " " },
            { type: "text", text: "@channel" },
          ],
        },
      ],
    })
  })

  test("should drop quotes, shares and file references without failing when the partner sends in a private channel", async () => {
    const world = await seedWorld("private")
    const elsewhere = await seedChannel(world.host.id, world.host.adminId, "private")
    const outside = await hostSays(world, "private words", elsewhere.id)
    const inside = await hostSays(world, "shared words")
    const fileId = attachmentId()
    await AttachmentRepository.insert(pool, {
      id: fileId,
      workspaceId: world.host.id,
      streamId: world.channel.id,
      uploadedBy: world.host.adminId,
      filename: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
      storagePath: `${world.host.id}/${fileId}/report.pdf`,
      safetyStatus: "clean",
    })
    await eventService.createMessage({
      workspaceId: world.host.id,
      streamId: world.channel.id,
      authorId: world.host.adminId,
      authorType: AuthorTypes.USER,
      ...testMessageContent("the report"),
      attachmentIds: [fileId],
    })
    const pointer = (type: string, target: { id: string; streamId: string }): JSONContent => ({
      type,
      attrs: {
        messageId: target.id,
        streamId: target.streamId,
        authorName: "Host",
        authorId: world.host.adminId,
        actorType: "user",
        snippet: "words",
      },
    })
    const reference: JSONContent = {
      type: "attachmentReference",
      attrs: { id: fileId, filename: "report.pdf", mimeType: "application/pdf", sizeBytes: 2048, status: "uploaded" },
    }

    const { messageId: id } = await send(world, {
      type: "doc",
      content: [
        pointer("quoteReply", outside),
        pointer("quoteReply", inside),
        pointer("sharedMessage", inside),
        { type: "paragraph", content: [reference, { type: "text", text: "see above" }] },
      ],
    })

    expect((await stored(world, id))?.contentJson).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "see above" }] }],
    })
  })

  test("should refuse content that is not a document when the partner sends it", async () => {
    const world = await seedWorld()
    const paragraph = (...content: unknown[]) => ({ type: "paragraph", content })
    const malformed = [
      { type: "doc", content: "not a list" },
      { type: "doc", content: [null] },
      { type: "doc", content: ["not a node"] },
      { type: "doc", content: [{ content: [] }] },
      { type: "doc", content: [{ type: "script" }] },
      { type: "doc", content: [paragraph({ type: "text", text: "x", marks: "bold" })] },
      { type: "doc", content: [paragraph({ type: "text", text: "x", marks: [null] })] },
    ] as JSONContent[]

    const outcomes = await Promise.all(malformed.map((content) => outcome(send(world, content))))

    expect(outcomes).toEqual(malformed.map(() => REFUSED))
  })

  test("should store an agent block as a blockquote without crediting its agent when the partner sends", async () => {
    const world = await seedWorld()
    const block = (type: string): JSONContent => ({
      type,
      ...(type === "agentBlock" && { attrs: { authorId: "persona_hostly", authorName: "Hostly" } }),
      content: [{ type: "paragraph", content: [{ type: "text", text: "Two options." }] }],
    })

    const { messageId: id } = await send(world, { type: "doc", content: [block("agentBlock")] })

    expect({ content: (await stored(world, id))?.contentJson, metadata: (await stored(world, id))?.metadata }).toEqual({
      content: { type: "doc", content: [block("blockquote")] },
      metadata: {},
    })
  })

  test("should add and remove a partner user's reaction when the message is in the stream", async () => {
    const world = await seedWorld()
    const message = await hostSays(world, "react to me")
    const target = { ...world.caller, streamId: world.channel.id, messageId: message.id, emoji: ":+1:" }

    await writer.addReaction({ ...target, author: world.pat })
    const added = (await stored(world, message.id))?.reactions
    await writer.removeReaction({ ...target, userId: world.pat.id })
    const removed = (await stored(world, message.id))?.reactions

    expect({ added, removed }).toEqual({ added: { ":+1:": [world.pat.id] }, removed: {} })
  })

  test("should refuse a reaction when the message is in another stream or the user is not the partner's", async () => {
    const world = await seedWorld()
    const elsewhere = await seedChannel(world.host.id, world.host.adminId)
    const outside = await hostSays(world, "elsewhere", elsewhere.id)
    const inside = await hostSays(world, "inside")
    const reactAs = (target: { id: string }, author: BridgeWriteUser) =>
      writer.addReaction({ ...world.caller, streamId: world.channel.id, messageId: target.id, emoji: ":+1:", author })

    const outcomes = await Promise.all([
      outcome(reactAs(outside, world.pat)),
      outcome(reactAs(inside, { id: world.host.adminId, name: "Impostor", slug: "impostor" })),
      outcome(
        writer.removeReaction({
          ...world.caller,
          streamId: world.channel.id,
          messageId: inside.id,
          emoji: ":+1:",
          userId: world.pat.id,
        })
      ),
    ])

    expect(outcomes).toEqual([REFUSED, REFUSED, REFUSED])
  })

  test("should list no partner users and carry the client message id only for the partner's own authors when the host exports", async () => {
    const world = await seedWorld()
    const hostMessage = await hostSays(world, "from the host")
    const { messageId: patsId } = await send(world, "from pat", { clientMessageId: "client-echo" })
    await writer.addReaction({
      ...world.caller,
      streamId: world.channel.id,
      messageId: hostMessage.id,
      emoji: ":+1:",
      author: world.sam,
    })

    const page = await exporter.listEvents({ ...world.caller, streamId: world.channel.id, after: 0n, limit: 200 })

    expect({
      users: page.users.map((user) => user.id),
      clientMessageIds: page.changes.map((change) =>
        change.kind === "message" ? { id: change.message.id, clientMessageId: change.message.clientMessageId } : change
      ),
    }).toEqual({
      users: [world.host.adminId],
      clientMessageIds: [
        { id: hostMessage.id, clientMessageId: null },
        { id: patsId, clientMessageId: "client-echo" },
      ],
    })
  })
})
