import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { seedBotRuntimeFixture, testContentJson, type BotRuntimeFixture } from "./setup"
import { BotRuntimeService, BotRuntimeSessionLinkRepository } from "../../src/features/bot-runtimes"
import { StreamService } from "../../src/features/streams"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { MessageRepository } from "../../src/features/messaging"
import { BotRepository } from "../../src/features/public-api"
import { BotChannelAccessRepository } from "../../src/features/api-keys"
import { messageId, streamId, userId } from "../../src/lib/id"

describe("attachRuntimeSessionToThread", () => {
  let fixture: BotRuntimeFixture
  let pool: Pool
  let workspace: string
  let root: string
  let author: string
  let bot: string
  const service = () => new BotRuntimeService({ pool, streamService: new StreamService(pool) })

  beforeAll(async () => {
    fixture = await seedBotRuntimeFixture({ label: "session_attach", instanceIds: [] })
    ;({ pool, workspace, stream: root, author, bot } = fixture)
  }, 30_000)

  afterAll(async () => {
    await fixture?.cleanup()
  }, 30_000)

  let sequence = 0n
  async function anchorMessage(streamIdForAnchor = root, markdown = "anchor message") {
    sequence += 1n
    return MessageRepository.insert(pool, {
      id: messageId(),
      streamId: streamIdForAnchor,
      sequence,
      authorId: author,
      authorType: "user",
      contentJson: testContentJson(markdown),
      contentMarkdown: markdown,
    })
  }

  test("links the session to a new thread under a message anchor when the root is the owner's scratchpad", async () => {
    const desk = await service().createOrLinkPiRemoteSession({
      workspaceId: workspace,
      botId: bot,
      runtimeKind: "pi-local",
      instanceId: "desk-instance",
      runtimeSessionId: "desk-session",
      rootStreamId: root,
      activeStreamId: root,
      linkedBy: author,
    })

    const anchor = await anchorMessage()
    const { link, stream } = await service().attachRuntimeSessionToThread({
      workspaceId: workspace,
      botId: bot,
      ownerUserId: author,
      runtimeKind: "pi-local",
      instanceId: "thread-instance",
      runtimeSessionId: "thread-session",
      rootStreamId: root,
      anchorId: anchor.id,
      displayName: "Sub work",
      traits: ["active-scratchpad"],
    })

    expect(link).toMatchObject({ rootStreamId: root, activeStreamId: stream.id, status: "active" })
    expect(stream).toMatchObject({ type: "thread", parentStreamId: root, parentAnchorId: anchor.id })

    const threadLink = await BotRuntimeSessionLinkRepository.findActiveByStream(pool, {
      workspaceId: workspace,
      botId: bot,
      rootStreamId: root,
      activeStreamId: stream.id,
    })
    expect(threadLink).toMatchObject({ id: link.id })

    const rootLink = await BotRuntimeSessionLinkRepository.findActiveByStream(pool, {
      workspaceId: workspace,
      botId: bot,
      rootStreamId: root,
      activeStreamId: root,
    })
    expect(rootLink).toMatchObject({ id: desk.id })
  })

  test("grants the bot access to the root before creating the thread", async () => {
    // `/spawn pi` in a scratchpad only the Claude bot can reach: without the
    // grant the bot's own thread create is refused as STREAM_READ_ONLY /
    // not_a_member by `resolveLockedStreamAuthorities`.
    const stranger = `bot_${crypto.randomUUID().slice(0, 8)}`
    await BotRepository.create(pool, {
      id: stranger,
      workspaceId: workspace,
      type: "personal",
      ownerUserId: author,
      traits: ["active-scratchpad", "mentionable"],
      slug: `bot-${crypto.randomUUID().slice(0, 8)}`,
      name: "Ungranted bot",
    })
    expect(await BotChannelAccessRepository.getGrantedStreamIds(pool, workspace, stranger)).toEqual([])

    const anchor = await anchorMessage()
    const { stream } = await service().attachRuntimeSessionToThread({
      workspaceId: workspace,
      botId: stranger,
      ownerUserId: author,
      runtimeKind: "pi-local",
      instanceId: "stranger-instance",
      runtimeSessionId: "stranger-session",
      rootStreamId: root,
      anchorId: anchor.id,
      displayName: "Fresh perspective",
      traits: ["active-scratchpad"],
    })

    expect(stream).toMatchObject({ type: "thread", parentStreamId: root, parentAnchorId: anchor.id })
    expect(await BotChannelAccessRepository.getGrantedStreamIds(pool, workspace, stranger)).toEqual([root])
  })

  test("refuses when the root scratchpad is archived", async () => {
    const archived = streamId()
    await pool.query(
      "INSERT INTO streams (id, workspace_id, type, visibility, created_by, archived_at) VALUES ($1, $2, 'scratchpad', 'private', $3, NOW())",
      [archived, workspace, author]
    )
    const anchor = await anchorMessage(archived)

    await expect(
      service().attachRuntimeSessionToThread({
        workspaceId: workspace,
        botId: bot,
        ownerUserId: author,
        runtimeKind: "pi-local",
        instanceId: "archived-instance",
        runtimeSessionId: "archived-session",
        rootStreamId: archived,
        anchorId: anchor.id,
        displayName: "Sub work",
        traits: ["active-scratchpad"],
      })
    ).rejects.toMatchObject({ status: 409, code: "SCRATCHPAD_ARCHIVED" })
  })

  test("refuses when the root scratchpad is end-to-end encrypted and writes no thread", async () => {
    const encrypted = streamId()
    await pool.query(
      "INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'scratchpad', 'private', $3)",
      [encrypted, workspace, author]
    )
    await E2eStreamsRepository.markStreamE2e(pool, {
      streamId: encrypted,
      workspaceId: workspace,
      ownerUserId: author,
      ownerUserKeyId: "e2ek_attach",
    })
    const anchor = await anchorMessage(encrypted)

    await expect(
      service().attachRuntimeSessionToThread({
        workspaceId: workspace,
        botId: bot,
        ownerUserId: author,
        runtimeKind: "pi-local",
        instanceId: "e2e-instance",
        runtimeSessionId: "e2e-session",
        rootStreamId: encrypted,
        anchorId: anchor.id,
        displayName: "Sub work",
        traits: ["active-scratchpad"],
      })
    ).rejects.toMatchObject({ status: 400, code: "E2E_STREAM_PLAINTEXT_UNSUPPORTED" })

    const threads = await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM streams WHERE parent_stream_id = $1",
      [encrypted]
    )
    expect(threads.rows[0]!.count).toBe("0")
  })

  test("refuses when the root is not a scratchpad", async () => {
    const channel = streamId()
    await pool.query(
      "INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'channel', 'public', $3)",
      [channel, workspace, author]
    )
    const anchor = await anchorMessage(channel)

    await expect(
      service().attachRuntimeSessionToThread({
        workspaceId: workspace,
        botId: bot,
        ownerUserId: author,
        runtimeKind: "pi-local",
        instanceId: "channel-instance",
        runtimeSessionId: "channel-session",
        rootStreamId: channel,
        anchorId: anchor.id,
        displayName: "Sub work",
        traits: ["active-scratchpad"],
      })
    ).rejects.toMatchObject({ status: 400, code: "ATTACH_ROOT_NOT_SCRATCHPAD" })
  })

  test("refuses when the scratchpad belongs to another user", async () => {
    const otherOwner = userId()
    const foreign = streamId()
    await pool.query(
      "INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'scratchpad', 'private', $3)",
      [foreign, workspace, otherOwner]
    )
    const anchor = await anchorMessage(foreign)

    await expect(
      service().attachRuntimeSessionToThread({
        workspaceId: workspace,
        botId: bot,
        ownerUserId: author,
        runtimeKind: "pi-local",
        instanceId: "foreign-instance",
        runtimeSessionId: "foreign-session",
        rootStreamId: foreign,
        anchorId: anchor.id,
        displayName: "Sub work",
        traits: ["active-scratchpad"],
      })
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" })
  })

  test("refuses when the anchor is not on the root", async () => {
    const otherStream = streamId()
    await pool.query(
      "INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'scratchpad', 'private', $3)",
      [otherStream, workspace, author]
    )
    const anchor = await anchorMessage(otherStream)

    await expect(
      service().attachRuntimeSessionToThread({
        workspaceId: workspace,
        botId: bot,
        ownerUserId: author,
        runtimeKind: "pi-local",
        instanceId: "wrong-anchor-instance",
        runtimeSessionId: "wrong-anchor-session",
        rootStreamId: root,
        anchorId: anchor.id,
        displayName: "Sub work",
        traits: ["active-scratchpad"],
      })
    ).rejects.toMatchObject({ status: 404, code: "MESSAGE_NOT_FOUND" })
  })

  test("refuses a second identity on the same anchor and leaves the first link untouched", async () => {
    const anchor = await anchorMessage()
    const first = await service().attachRuntimeSessionToThread({
      workspaceId: workspace,
      botId: bot,
      ownerUserId: author,
      runtimeKind: "pi-local",
      instanceId: "first-instance",
      runtimeSessionId: "first-session",
      rootStreamId: root,
      anchorId: anchor.id,
      displayName: "Sub work",
      traits: ["active-scratchpad"],
    })

    await expect(
      service().attachRuntimeSessionToThread({
        workspaceId: workspace,
        botId: bot,
        ownerUserId: author,
        runtimeKind: "pi-local",
        instanceId: "second-instance",
        runtimeSessionId: "second-session",
        rootStreamId: root,
        anchorId: anchor.id,
        displayName: "Sub work",
        traits: ["active-scratchpad"],
      })
    ).rejects.toMatchObject({ status: 409, code: "THREAD_SESSION_EXISTS" })

    const stillFirst = await BotRuntimeSessionLinkRepository.findActiveByStream(pool, {
      workspaceId: workspace,
      botId: bot,
      rootStreamId: root,
      activeStreamId: first.stream.id,
    })
    expect(stillFirst).toMatchObject({ id: first.link.id, runtimeSessionId: "first-session" })
  })

  test("rolls back the thread when the link insert loses to a runtime-identity conflict", async () => {
    const conflictingIdentity = {
      runtimeKind: "pi-local" as const,
      instanceId: "conflict-instance",
      runtimeSessionId: "conflict-session",
    }
    // Pre-seed the identity on an unrelated stream so the attach's link upsert
    // hits the (workspace, bot, kind, instance, session) unique key instead of
    // the (workspace, bot, root, active) one the ON CONFLICT targets.
    await service().createOrLinkPiRemoteSession({
      workspaceId: workspace,
      botId: bot,
      ...conflictingIdentity,
      rootStreamId: root,
      activeStreamId: root,
      linkedBy: author,
    })

    const anchor = await anchorMessage()

    await expect(
      service().attachRuntimeSessionToThread({
        workspaceId: workspace,
        botId: bot,
        ownerUserId: author,
        ...conflictingIdentity,
        rootStreamId: root,
        anchorId: anchor.id,
        displayName: "Sub work",
        traits: ["active-scratchpad"],
      })
    ).rejects.toMatchObject({ code: "23505" })

    const orphanThread = await pool.query("SELECT 1 FROM streams WHERE parent_anchor_id = $1", [anchor.id])
    expect(orphanThread.rows).toHaveLength(0)
  })
})
