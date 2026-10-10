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
import { EventService } from "../../src/features/messaging"
import { BotChannelAccessRepository, BotChannelService } from "../../src/features/api-keys"
import { BotRepository, createPublicApiHandlers, type PublicApiDeps } from "../../src/features/public-api"
import {
  userId,
  workspaceId,
  streamId,
  messageId,
  botId,
  botChannelAccessId,
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

  const writers = [
    ["user key", userReq],
    ["bot key", botReq],
  ] as const
  const readers = [...writers, ["sandbox session", sandboxReq]] as const

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
      await StreamMemberRepository.insert(client, ws, channelId, keyOwnerId)

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
    })

    const eventService = new EventService(pool)
    message = await eventService.createMessage({
      workspaceId: ws,
      streamId: channelId,
      authorId: keyOwnerId,
      authorType: AuthorTypes.USER,
      ...testMessageContent("a message from before the archive"),
    })
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
      expect(out.last<Array<{ id: string }>>().data.map((m) => m.id)).toEqual([message.id])
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

  for (const [label, makeReq] of writers) {
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
