/**
 * Archiving blocks writes, never reads. Through the real public-API handlers a
 * user key, a bot key and a sandbox session all read an archived channel (and a
 * live thread sealed under it); listings still hide it unless
 * `includeArchived=true`; a user key and a bot key writing to it are refused
 * with 403 STREAM_READ_ONLY.
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test"
import type { Request, Response } from "express"
import { Pool } from "pg"
import { AuthorTypes, StreamTypes, Visibilities } from "@threahq/types"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamMemberRepository, StreamRepository, StreamService } from "../../src/features/streams"
import { SandboxSessionTokenService, StreamSandboxRepository, type SandboxSession } from "../../src/features/sandboxes"
import { EventService, MessageRepository } from "../../src/features/messaging"
import { ConversationRepository } from "../../src/features/conversations"
import { BotChannelAccessRepository, BotChannelService } from "../../src/features/api-keys"
import { BotRepository, createPublicApiHandlers, type PublicApiDeps } from "../../src/features/public-api"
import {
  userId,
  workspaceId,
  streamId,
  messageId,
  botId,
  botChannelAccessId,
  conversationId,
  personaId,
  sessionId,
} from "../../src/lib/id"

describe("public API reads on archived streams", () => {
  let pool: Pool
  let ws: string
  let keyOwnerId: string
  let readerBotId: string
  let channelId: string
  let threadId: string
  let activeChannelId: string
  let channelConversationId: string
  let channelAnchorMessageId: string
  let threadConversationId: string
  let activeConversationId: string
  let sandboxSession: SandboxSession
  const search = mock(async (_params: { permissions: { accessibleStreamIds: string[] } }) => ({ results: [] }))
  let message: Awaited<ReturnType<EventService["createMessage"]>>
  let handlers: ReturnType<typeof createPublicApiHandlers>

  function recorder() {
    const payloads: unknown[] = []
    const res = { locals: {} } as unknown as Response
    res.status = (() => res) as Response["status"]
    res.json = ((payload: unknown) => {
      payloads.push(payload)
      return res
    }) as Response["json"]
    return { res, last: <T>() => payloads[payloads.length - 1] as { data: T } }
  }

  const userReq = (extra: Record<string, unknown>) =>
    ({ workspaceId: ws, userApiKey: { id: "key_1" }, user: { id: keyOwnerId }, ...extra }) as unknown as Request
  const botReq = (extra: Record<string, unknown>) =>
    ({ workspaceId: ws, botApiKey: { botId: readerBotId }, ...extra }) as unknown as Request

  const sandboxReq = (extra: Record<string, unknown>) =>
    ({ workspaceId: ws, sandboxSession, ...extra }) as unknown as Request

  const apiKeys = [
    ["user key", userReq],
    ["bot key", botReq],
  ] as const
  const readers = [...apiKeys, ["sandbox session", sandboxReq]] as const

  // The test server's workers file their own conversations for messages sent through EventService, so
  // assertions look only at the seeded ones.
  const isSeeded = (id: string) => [channelConversationId, threadConversationId, activeConversationId].includes(id)

  const seen = (ids: string[]) => ({ channel: ids.includes(channelId), thread: ids.includes(threadId) })

  function buildHandlers(eventService: EventService) {
    return createPublicApiHandlers({
      pool,
      io: { to: () => ({ emit: () => undefined }) } as unknown as PublicApiDeps["io"],
      eventService,
      streamService: new StreamService(pool),
      botChannelService: new BotChannelService({ pool }),
      searchService: { search } as unknown as PublicApiDeps["searchService"],
      featureFlagService: { getWorkspaceFlag: async () => false } as unknown as PublicApiDeps["featureFlagService"],
      botRuntimeService: {} as PublicApiDeps["botRuntimeService"],
      memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
      preparedRecall: {} as PublicApiDeps["preparedRecall"],
      attachmentService: {} as PublicApiDeps["attachmentService"],
      labelService: {} as PublicApiDeps["labelService"],
      labelAssignmentService: {} as PublicApiDeps["labelAssignmentService"],
    })
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    ws = workspaceId()
    channelId = streamId()
    threadId = streamId()
    activeChannelId = streamId()
    readerBotId = botId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: ws,
        name: "Archived reads",
        slug: `archived-reads-${ws}`,
        createdBy: userId(),
      })
      keyOwnerId = (await addTestMember(client, ws, userId())).id

      await StreamRepository.insert(client, {
        id: channelId,
        workspaceId: ws,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PRIVATE,
        slug: `s-${channelId.slice(-10)}`,
        createdBy: keyOwnerId,
      })
      await StreamRepository.insert(client, {
        id: threadId,
        workspaceId: ws,
        type: StreamTypes.THREAD,
        visibility: Visibilities.PRIVATE,
        parentStreamId: channelId,
        parentAnchorId: messageId(),
        rootStreamId: channelId,
        createdBy: keyOwnerId,
      })
      await StreamRepository.insert(client, {
        id: activeChannelId,
        workspaceId: ws,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PRIVATE,
        slug: `s-${activeChannelId.slice(-10)}`,
        createdBy: keyOwnerId,
      })
      await StreamMemberRepository.insert(client, ws, channelId, keyOwnerId)
      await StreamMemberRepository.insert(client, ws, activeChannelId, keyOwnerId)

      await BotRepository.create(client, {
        id: readerBotId,
        workspaceId: ws,
        type: "shared",
        ownerUserId: null,
        slug: "archived-reader",
        name: "Archived reader",
      })
      await BotChannelAccessRepository.grantAccess(client, {
        id: botChannelAccessId(),
        workspaceId: ws,
        botId: readerBotId,
        streamId: channelId,
        grantedBy: keyOwnerId,
      })
      await BotChannelAccessRepository.grantAccess(client, {
        id: botChannelAccessId(),
        workspaceId: ws,
        botId: readerBotId,
        streamId: activeChannelId,
        grantedBy: keyOwnerId,
      })
    })

    const eventService = new EventService(pool)
    message = await eventService.createMessage({
      workspaceId: ws,
      streamId: channelId,
      authorId: keyOwnerId,
      authorType: AuthorTypes.USER,
      ...testMessageContent("a message from before the archive"),
    })
    const seedConversation = async (anchorStreamId: string) => {
      const id = conversationId()
      const anchorMessageId = messageId()
      await MessageRepository.insert(pool, {
        workspaceId: ws,
        id: anchorMessageId,
        streamId: anchorStreamId,
        sequence: BigInt(2),
        authorId: keyOwnerId,
        authorType: AuthorTypes.USER,
        ...testMessageContent("seeded for a conversation"),
      })
      await ConversationRepository.insert(pool, { id, streamId: anchorStreamId, workspaceId: ws })
      await ConversationRepository.addPrimaryMessage(pool, ws, id, anchorMessageId, keyOwnerId)
      return { id, anchorMessageId }
    }
    const channelSeed = await seedConversation(channelId)
    channelConversationId = channelSeed.id
    channelAnchorMessageId = channelSeed.anchorMessageId
    threadConversationId = (await seedConversation(threadId)).id
    activeConversationId = (await seedConversation(activeChannelId)).id
    await pool.query(`UPDATE streams SET archived_at = NOW() WHERE id = $1`, [channelId])

    await StreamSandboxRepository.insertIfAbsent(pool, {
      workspaceId: ws,
      streamId: channelId,
      sandboxId: "box-archived-reads",
      runner: "fake",
      internet: false,
    })
    sandboxSession = (
      await new SandboxSessionTokenService({ pool }).mint({
        workspaceId: ws,
        invokingUserId: keyOwnerId,
        personaId: personaId(),
        sessionId: sessionId(),
        streamId: channelId,
        capturedStreamIds: [channelId, threadId],
        ttlSec: 60,
      })
    ).session

    handlers = buildHandlers(eventService)
  })

  afterAll(async () => {
    await pool.end()
  })

  for (const [label, makeReq] of readers) {
    test(`should hide an archived channel and its sealed thread from listStreams unless includeArchived is set when using a ${label}`, async () => {
      const hidden = recorder()
      await handlers.listStreams(makeReq({ query: {} }), hidden.res)
      const shown = recorder()
      await handlers.listStreams(makeReq({ query: { includeArchived: "true" } }), shown.res)

      expect({
        hidden: seen(hidden.last<Array<{ id: string }>>().data.map((s) => s.id)),
        shown: seen(shown.last<Array<{ id: string }>>().data.map((s) => s.id)),
      }).toEqual({ hidden: { channel: false, thread: false }, shown: { channel: true, thread: true } })
    })

    test(`should return the messages of an archived channel from listMessages when using a ${label}`, async () => {
      const out = recorder()
      await handlers.listMessages(makeReq({ params: { streamId: channelId }, query: {} }), out.res)
      const ids = out.last<Array<{ id: string }>>().data.map((m) => m.id)
      expect(ids.sort()).toEqual([message.id, channelAnchorMessageId].sort())
    })

    test(`should return a sealed thread of an archived channel from getStream when using a ${label}`, async () => {
      const out = recorder()
      await handlers.getStream(makeReq({ params: { streamId: threadId } }), out.res)
      expect(out.last<{ id: string }>().data.id).toBe(threadId)
    })

    test(`should hand search a readable scope containing an archived channel and its sealed thread when using a ${label}`, async () => {
      search.mockClear()
      await handlers.searchMessages(makeReq({ body: { query: "before the archive" } }), recorder().res)
      expect(seen(search.mock.calls[0][0].permissions.accessibleStreamIds)).toEqual({ channel: true, thread: true })
    })
  }

  for (const [label, makeReq] of apiKeys) {
    test(`should list conversations in an archived channel and its sealed thread only when includeArchived is set when using a ${label}`, async () => {
      const seededIds = async (query: Record<string, string>) => {
        const out = recorder()
        await handlers.listConversations(makeReq({ query }), out.res)
        return out
          .last<Array<{ id: string }>>()
          .data.map((c) => c.id)
          .filter(isSeeded)
          .sort()
      }
      const hidden = await seededIds({})
      const hiddenInChannel = await seededIds({ streamId: channelId })
      const shown = await seededIds({ includeArchived: "true" })
      const shownInChannel = await seededIds({ streamId: channelId, includeArchived: "true" })

      expect({ hidden, hiddenInChannel, shown, shownInChannel }).toEqual({
        hidden: [activeConversationId],
        hiddenInChannel: [],
        shown: [activeConversationId, channelConversationId, threadConversationId].sort(),
        shownInChannel: [channelConversationId, threadConversationId].sort(),
      })
    })

    test(`should mark archived conversations and streams with archived true when using a ${label}`, async () => {
      const conversations = recorder()
      await handlers.listConversations(makeReq({ query: { includeArchived: "true" } }), conversations.res)
      const single = recorder()
      await handlers.getConversation(makeReq({ params: { conversationId: threadConversationId } }), single.res)
      const streams = recorder()
      await handlers.listStreams(makeReq({ query: { includeArchived: "true" } }), streams.res)
      const channel = recorder()
      await handlers.getStream(makeReq({ params: { streamId: channelId } }), channel.res)
      const thread = recorder()
      await handlers.getStream(makeReq({ params: { streamId: threadId } }), thread.res)
      const active = recorder()
      await handlers.getStream(makeReq({ params: { streamId: activeChannelId } }), active.res)

      const flags = (rows: Array<{ id: string; archived?: true }>) =>
        Object.fromEntries(rows.map((r) => [r.id, r.archived === true]))
      const stream = (out: ReturnType<typeof recorder>) => {
        const { archived, archivedAt } = out.last<{ archived?: true; archivedAt?: string }>().data
        return { archived: archived === true, hasArchivedAt: archivedAt !== undefined }
      }
      expect({
        conversationRows: flags(
          conversations.last<Array<{ id: string; archived?: true }>>().data.filter((c) => isSeeded(c.id))
        ),
        conversation: single.last<{ archived?: true }>().data.archived,
        streamRows: flags(streams.last<Array<{ id: string; archived?: true }>>().data),
        channel: stream(channel),
        thread: stream(thread),
        active: stream(active),
      }).toEqual({
        conversationRows: {
          [activeConversationId]: false,
          [channelConversationId]: true,
          [threadConversationId]: true,
        },
        conversation: true,
        streamRows: { [activeChannelId]: false, [channelId]: true, [threadId]: true },
        channel: { archived: true, hasArchivedAt: true },
        thread: { archived: true, hasArchivedAt: false },
        active: { archived: false, hasArchivedAt: false },
      })
    })

    test(`should refuse sendMessage into an archived channel with 403 STREAM_READ_ONLY when using a ${label}`, async () => {
      await expect(
        handlers.sendMessage(
          makeReq({ params: { streamId: channelId }, body: { content: "too late" } }),
          recorder().res
        )
      ).rejects.toMatchObject({ status: 403, code: "STREAM_READ_ONLY" })
    })
  }
})
