/**
 * A bot key reacts as the bot, only in streams it can write. Outside its
 * grants the message is hidden (404), same as any other bot write.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import type { Request, Response } from "express"
import { Pool } from "pg"
import { AuthorTypes, StreamTypes, Visibilities } from "@threahq/types"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository, StreamMemberRepository, StreamService } from "../../src/features/streams"
import { BotChannelAccessRepository, BotChannelService } from "../../src/features/api-keys"
import { BotRuntimeService } from "../../src/features/bot-runtimes"
import { EventService } from "../../src/features/messaging"
import { BotRepository } from "../../src/features/public-api"
import { createPublicApiHandlers, type PublicApiDeps } from "../../src/features/public-api/handlers"
import { userId, workspaceId, streamId, botId, botChannelAccessId } from "../../src/lib/id"

describe("public API bot reactions", () => {
  let pool: Pool
  let testWorkspaceId: string
  let bot: string
  let grantedMessageId: string
  let hiddenMessageId: string
  let postInGrantedChannel: () => Promise<string>
  let handlers: ReturnType<typeof createPublicApiHandlers>

  function request(params: Record<string, string>): Request {
    return { workspaceId: testWorkspaceId, params, botApiKey: { botId: bot } } as unknown as Request
  }

  function response(): Response {
    const res = {} as Response
    res.status = (() => res) as Response["status"]
    res.send = (() => res) as Response["send"]
    return res
  }

  async function reactors(messageId: string, emoji = ":+1:"): Promise<string[]> {
    const message = await new EventService(pool).getMessageById(testWorkspaceId, messageId)
    return message?.reactions[emoji] ?? []
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    testWorkspaceId = workspaceId()
    bot = botId()
    const grantedChannelId = streamId()
    const hiddenChannelId = streamId()
    const events = new EventService(pool)
    let ownerId = userId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Bot Reactions",
        slug: `bot-react-${testWorkspaceId}`,
        createdBy: ownerId,
      })
      ownerId = (await addTestMember(client, testWorkspaceId, ownerId)).id
      for (const id of [grantedChannelId, hiddenChannelId]) {
        await StreamRepository.insert(client, {
          id,
          workspaceId: testWorkspaceId,
          type: StreamTypes.CHANNEL,
          visibility: Visibilities.PRIVATE,
          slug: `s-${id.slice(-10)}`,
          createdBy: ownerId,
        })
        await StreamMemberRepository.insert(client, testWorkspaceId, id, ownerId)
      }
      await BotRepository.create(client, {
        id: bot,
        workspaceId: testWorkspaceId,
        type: "shared",
        ownerUserId: null,
        slug: "reactor-bot",
        name: "Reactor",
      })
      await BotChannelAccessRepository.grantAccess(client, {
        id: botChannelAccessId(),
        workspaceId: testWorkspaceId,
        botId: bot,
        streamId: grantedChannelId,
        grantedBy: ownerId,
      })
    })

    const post = async (targetStreamId: string) =>
      (
        await events.createMessageForPrincipalReturningConversation(
          { kind: "user", userId: ownerId },
          {
            workspaceId: testWorkspaceId,
            streamId: targetStreamId,
            authorId: ownerId,
            authorType: AuthorTypes.USER,
            contentJson: { type: "doc", content: [] },
            contentMarkdown: "hello",
          }
        )
      ).message.id
    postInGrantedChannel = () => post(grantedChannelId)
    grantedMessageId = await postInGrantedChannel()
    hiddenMessageId = await post(hiddenChannelId)

    handlers = createPublicApiHandlers({
      pool,
      io: { to: () => ({ emit: () => undefined }) } as unknown as PublicApiDeps["io"],
      eventService: events,
      streamService: new StreamService(pool),
      botRuntimeService: new BotRuntimeService({ pool }),
      botChannelService: new BotChannelService({ pool }),
      searchService: {} as PublicApiDeps["searchService"],
      memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
      preparedRecall: {} as PublicApiDeps["preparedRecall"],
      attachmentService: {} as PublicApiDeps["attachmentService"],
      labelService: {} as PublicApiDeps["labelService"],
      labelAssignmentService: {} as PublicApiDeps["labelAssignmentService"],
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  async function reactionRecords(messageId: string, emoji: string) {
    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM stream_events
       WHERE workspace_id = $1 AND event_type IN ('reaction_added', 'reaction_removed')
         AND payload ->> 'messageId' = $2 AND payload ->> 'emoji' = $3
       ORDER BY sequence`,
      [testWorkspaceId, messageId, emoji]
    )
    const outbox = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM outbox
       WHERE event_type IN ('reaction:added', 'reaction:removed')
         AND payload ->> 'messageId' = $1 AND payload ->> 'emoji' = $2
       ORDER BY id`,
      [messageId, emoji]
    )
    return { events: events.rows.map((row) => row.event_type), outbox: outbox.rows.map((row) => row.event_type) }
  }

  test("adds and removes a reaction as the bot", async () => {
    await handlers.addMessageReaction(request({ messageId: grantedMessageId, emoji: "👍" }), response())
    expect(await reactors(grantedMessageId)).toEqual([bot])

    await handlers.removeMessageReaction(request({ messageId: grantedMessageId, emoji: ":+1:" }), response())
    expect(await reactors(grantedMessageId)).toEqual([])
  })

  test("records one event and one outbox row per actual change however often the call repeats", async () => {
    const add = request({ messageId: grantedMessageId, emoji: ":heart:" })
    const remove = request({ messageId: grantedMessageId, emoji: ":heart:" })

    for (let attempt = 0; attempt < 3; attempt++) await handlers.addMessageReaction(add, response())
    for (let attempt = 0; attempt < 2; attempt++) await handlers.removeMessageReaction(remove, response())

    expect(await reactionRecords(grantedMessageId, ":heart:")).toEqual({
      events: ["reaction_added", "reaction_removed"],
      outbox: ["reaction:added", "reaction:removed"],
    })
  })

  test.each(["white_check_mark", "thumbsup", "+1"])("accepts the bare shortcode %s", async (emoji) => {
    const shortcode = `:${emoji}:`
    await handlers.addMessageReaction(request({ messageId: grantedMessageId, emoji }), response())
    expect(await reactors(grantedMessageId, shortcode)).toEqual([bot])

    await handlers.removeMessageReaction(request({ messageId: grantedMessageId, emoji }), response())
    expect(await reactors(grantedMessageId, shortcode)).toEqual([])
  })

  test("records the reaction event with actor type bot", async () => {
    await handlers.addMessageReaction(request({ messageId: grantedMessageId, emoji: ":+1:" }), response())
    const { rows } = await pool.query(
      `SELECT actor_id, actor_type FROM stream_events WHERE event_type = 'reaction_added' AND workspace_id = $1`,
      [testWorkspaceId]
    )
    expect(rows).toContainEqual({ actor_id: bot, actor_type: "bot" })
  })

  test("hides a message in a stream the bot has no access to", async () => {
    await expect(
      handlers.addMessageReaction(request({ messageId: hiddenMessageId, emoji: "👍" }), response())
    ).rejects.toMatchObject({ status: 404 })
    expect(await reactors(hiddenMessageId)).toEqual([])
  })

  test("404s a deleted message with the same code as the other message routes", async () => {
    const deletedMessageId = await postInGrantedChannel()
    await pool.query("UPDATE messages SET deleted_at = NOW() WHERE workspace_id = $1 AND id = $2", [
      testWorkspaceId,
      deletedMessageId,
    ])

    await expect(
      handlers.addMessageReaction(request({ messageId: deletedMessageId, emoji: "👍" }), response())
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" })
  })

  test("404s a message that does not exist", async () => {
    await expect(
      handlers.addMessageReaction(request({ messageId: "msg_missing", emoji: "👍" }), response())
    ).rejects.toMatchObject({ status: 404 })
  })

  test("400s an unknown emoji", async () => {
    await expect(
      handlers.addMessageReaction(request({ messageId: grantedMessageId, emoji: "not-an-emoji-xyz" }), response())
    ).rejects.toMatchObject({ status: 400, code: "INVALID_EMOJI" })
  })
})
