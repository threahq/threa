import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Request, Response } from "express"
import { HttpError } from "@threahq/backend-common"
import type { Pool } from "pg"
import { StreamTypes, Visibilities, type BotProfile } from "@threahq/types"
import { addTestMember, setupTestDatabase, withTransaction } from "./setup"
import { WorkspaceRepository, type User } from "../../src/features/workspaces"
import { StreamMemberRepository, StreamRepository, type StreamService } from "../../src/features/streams"
import { BotChannelAccessRepository } from "../../src/features/api-keys"
import { BotRepository, createBotHandlers, type BotApiKeyService } from "../../src/features/public-api"
import { BotRuntimeInstanceRepository, BotRuntimeService } from "../../src/features/bot-runtimes"
import type { AvatarService } from "../../src/features/workspaces"
import { botChannelAccessId, botId, botRuntimeInstanceId, streamId, userId, workspaceId } from "../../src/lib/id"

describe("GET bots/:botId/profile", () => {
  let pool: Pool
  let handlers: ReturnType<typeof createBotHandlers>
  const ws = workspaceId()
  let owner: User
  let member: User
  let admin: User
  const sharedBot = botId()
  const personalBot = botId()
  const hiddenPersonalBot = botId()
  const publicChannel = streamId()
  const privateChannel = streamId()
  const archivedChannel = streamId()

  async function callProfile(viewer: User, id: string): Promise<{ status: number; body: unknown }> {
    const req = { workspaceId: ws, params: { botId: id }, user: viewer } as unknown as Request
    let body: unknown
    const res = { json: (payload: unknown) => (body = payload) } as unknown as Response
    try {
      await handlers.profile(req, res)
      return { status: 200, body }
    } catch (err) {
      if (!(err instanceof HttpError)) throw err
      return { status: err.status, body: null }
    }
  }

  function channel(id: string) {
    return { id, type: StreamTypes.CHANNEL, slug: `s-${id.slice(-10)}`, displayName: null, parentStreamId: null }
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    handlers = createBotHandlers({
      pool,
      botApiKeyService: {} as BotApiKeyService,
      avatarService: {} as AvatarService,
      streamService: {} as StreamService,
      botRuntimeService: new BotRuntimeService({ pool }),
    })

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: ws,
        name: "Bot Profile",
        slug: `bot-profile-${ws}`,
        createdBy: userId(),
      })
      owner = await addTestMember(client, ws, userId())
      member = await addTestMember(client, ws, userId())
      admin = await addTestMember(client, ws, userId(), "admin")

      for (const [id, visibility] of [
        [publicChannel, Visibilities.PUBLIC],
        [privateChannel, Visibilities.PRIVATE],
        [archivedChannel, Visibilities.PUBLIC],
      ] as const) {
        await StreamRepository.insert(client, {
          id,
          workspaceId: ws,
          type: StreamTypes.CHANNEL,
          visibility,
          slug: `s-${id.slice(-10)}`,
          createdBy: owner.id,
        })
      }
      await StreamMemberRepository.insert(client, privateChannel, owner.id)

      await BotRepository.create(client, {
        id: sharedBot,
        workspaceId: ws,
        type: "shared",
        ownerUserId: null,
        slug: "profile-shared",
        name: "Shared",
      })
      await BotRepository.create(client, {
        id: personalBot,
        workspaceId: ws,
        type: "personal",
        ownerUserId: owner.id,
        slug: "profile-personal",
        name: "Personal",
      })
      await BotRepository.create(client, {
        id: hiddenPersonalBot,
        workspaceId: ws,
        type: "personal",
        ownerUserId: owner.id,
        slug: "profile-hidden",
        name: "Hidden",
      })

      for (const [bot, stream] of [
        [sharedBot, publicChannel],
        [sharedBot, privateChannel],
        [sharedBot, archivedChannel],
        [personalBot, publicChannel],
        [hiddenPersonalBot, privateChannel],
      ] as const) {
        await BotChannelAccessRepository.grantAccess(client, {
          id: botChannelAccessId(),
          workspaceId: ws,
          botId: bot,
          streamId: stream,
          grantedBy: owner.id,
        })
      }
    })
    await pool.query(`UPDATE streams SET archived_at = NOW() WHERE id = $1`, [archivedChannel])
  })

  afterAll(async () => {
    await pool.end()
  })

  test("member sees a shared bot with only the granted streams they can read and cannot manage it", async () => {
    const result = await callProfile(member, sharedBot)
    const body = result.body as { data: BotProfile }
    expect({
      status: result.status,
      botId: body.data.bot.id,
      streams: body.data.streams,
      runtime: body.data.runtime,
      canManage: body.data.canManage,
    }).toEqual({
      status: 200,
      botId: sharedBot,
      streams: [channel(publicChannel)],
      runtime: null,
      canManage: false,
    })
  })

  test("admin can manage a shared bot", async () => {
    const result = await callProfile(admin, sharedBot)
    expect((result.body as { data: BotProfile }).data.canManage).toBe(true)
  })

  test("owner sees the private channel grant and can manage the personal bot", async () => {
    const shared = await callProfile(owner, sharedBot)
    const personal = await callProfile(owner, hiddenPersonalBot)
    expect({
      sharedStreams: new Set((shared.body as { data: BotProfile }).data.streams.map((s) => s.id)),
      personalCanManage: (personal.body as { data: BotProfile }).data.canManage,
    }).toEqual({ sharedStreams: new Set([publicChannel, privateChannel]), personalCanManage: true })
  })

  test("another user's personal bot is 404 unless granted to a stream the viewer can read", async () => {
    const hidden = await callProfile(member, hiddenPersonalBot)
    const visible = await callProfile(member, personalBot)
    const visibleData = (visible.body as { data: BotProfile } | null)?.data
    expect({
      hiddenStatus: hidden.status,
      visibleStatus: visible.status,
      visibleStreams: visibleData?.streams,
      visibleCanManage: visibleData?.canManage,
      adminPersonalCanManage: ((await callProfile(admin, personalBot)).body as { data: BotProfile }).data.canManage,
    }).toEqual({
      hiddenStatus: 404,
      visibleStatus: 200,
      visibleStreams: [channel(publicChannel)],
      visibleCanManage: false,
      adminPersonalCanManage: false,
    })
  })

  test("runtime reflects the latest presence row", async () => {
    await BotRuntimeInstanceRepository.upsertPresence(pool, {
      id: botRuntimeInstanceId(),
      workspaceId: ws,
      botId: sharedBot,
      runtimeKind: "hermes",
      instanceId: "profile-instance",
      displayName: "Laptop",
      status: "available",
      acceptingInvocations: true,
      capabilities: {},
    })
    const runtime = ((await callProfile(member, sharedBot)).body as { data: BotProfile }).data.runtime
    expect({ ...runtime, lastSeenAt: typeof runtime?.lastSeenAt }).toEqual({
      botId: sharedBot,
      runtimeKind: "hermes",
      instanceId: "profile-instance",
      displayName: "Laptop",
      status: "available",
      acceptingInvocations: true,
      statusText: null,
      lastSeenAt: "string",
    })
  })
})
