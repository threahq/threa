import { beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { HttpError } from "@threahq/backend-common"
import { StreamTypes, Visibilities } from "@threahq/types"
import { addTestMember, setupTestDatabase, withTransaction } from "./setup"
import { sql } from "../../src/db"
import { WorkspaceRepository, type User } from "../../src/features/workspaces"
import { StreamMemberRepository, StreamRepository, StreamService } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { BotChannelAccessRepository } from "../../src/features/api-keys"
import { BotRepository } from "../../src/features/public-api"
import { IncomingWebhookService, IncomingWebhookRepository } from "../../src/features/incoming-webhooks"
import { botId, streamId, userId, workspaceId } from "../../src/lib/id"

async function capture(fn: () => Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await fn()
  } catch (err) {
    if (!(err instanceof HttpError)) throw err
    return { status: err.status, code: err.code }
  }
  throw new Error("expected an HttpError")
}

describe("IncomingWebhookService", () => {
  let pool: Pool
  let service: IncomingWebhookService
  const ws = workspaceId()
  const bot = botId()
  const channel = streamId()
  const e2eChannel = streamId()
  const archivedChannel = streamId()
  const thread = streamId()
  let owner: User

  beforeAll(async () => {
    pool = await setupTestDatabase()
    service = new IncomingWebhookService({
      pool,
      streamService: new StreamService(pool),
      eventService: new EventService(pool),
    })

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: ws,
        name: "Hooks",
        slug: `hooks-${ws}`,
        createdBy: userId(),
      })
      owner = await addTestMember(client, ws, userId())

      for (const id of [channel, e2eChannel, archivedChannel]) {
        await StreamRepository.insert(client, {
          id,
          workspaceId: ws,
          type: StreamTypes.CHANNEL,
          visibility: Visibilities.PRIVATE,
          slug: `s-${id.slice(-10)}`,
          createdBy: owner.id,
        })
        await StreamMemberRepository.insert(client, id, owner.id)
      }

      await StreamRepository.insert(client, {
        id: thread,
        workspaceId: ws,
        type: StreamTypes.THREAD,
        visibility: Visibilities.PRIVATE,
        parentStreamId: channel,
        rootStreamId: channel,
        createdBy: owner.id,
      })

      await client.query(sql`UPDATE streams SET archived_at = NOW() WHERE id = ${archivedChannel}`)

      await client.query(sql`
        INSERT INTO e2e_streams (stream_id, workspace_id, owner_user_id, owner_user_key_id)
        VALUES (${e2eChannel}, ${ws}, ${owner.id}, ${"uek_test"})
      `)

      await BotRepository.create(client, {
        id: bot,
        workspaceId: ws,
        type: "shared",
        ownerUserId: null,
        slug: "hook-bot",
        name: "Hook Bot",
      })
    })
  })

  test("should return the secret once, grant the bot stream access and list the hook when a hook is created", async () => {
    const { row, secret } = await service.create({
      workspaceId: ws,
      botId: bot,
      streamId: channel,
      name: "Alerts",
      createdBy: owner.id,
    })

    expect(row.id.startsWith("hook_")).toBe(true)
    expect(secret.length).toBeGreaterThan(20)
    expect(row.secretHash).not.toContain(secret)

    const granted = await BotChannelAccessRepository.getGrantedStreamIds(pool, ws, bot)
    expect(granted).toContain(channel)

    const listed = await service.listByBot(ws, bot)
    expect(listed.map((hook) => hook.id)).toContain(row.id)

    const memberAdded = await pool.query<{
      payload: { streamId: string; memberId: string; event: { eventType: string } }
    }>(
      sql`
        SELECT payload FROM outbox
        WHERE event_type = ${"stream:member_added"}
          AND payload->>'streamId' = ${channel}
          AND payload->>'memberId' = ${bot}
      `
    )
    expect(
      memberAdded.rows.map((r) => ({
        streamId: r.payload.streamId,
        memberId: r.payload.memberId,
        eventType: r.payload.event.eventType,
      }))
    ).toEqual([{ streamId: channel, memberId: bot, eventType: "member_added" }])
  })

  test("should accept the secret and reject a wrong one, a foreign workspace and a revoked hook when authenticating", async () => {
    const { row, secret } = await service.create({
      workspaceId: ws,
      botId: bot,
      streamId: channel,
      name: "Auth",
      createdBy: owner.id,
    })

    const ok = await service.authenticate(ws, row.id, secret)
    expect(ok?.hook).toMatchObject({ id: row.id, workspaceId: ws, botId: bot, streamId: channel })

    expect(await service.authenticate(ws, row.id, `${secret}x`)).toBeNull()
    expect(await service.authenticate(workspaceId(), row.id, secret)).toBeNull()

    await service.revoke(ws, bot, row.id)
    expect(await service.authenticate(ws, row.id, secret)).toBeNull()
    expect(await capture(() => service.revoke(ws, bot, row.id))).toEqual({ status: 400, code: "ALREADY_REVOKED" })
  })

  test("should leave last_used_at null when a hook only authenticates and set it when it posts", async () => {
    const { row, secret } = await service.create({
      workspaceId: ws,
      botId: bot,
      streamId: channel,
      name: "Touch",
      createdBy: owner.id,
    })
    expect(row.lastUsedAt).toBeNull()

    const authed = await service.authenticate(ws, row.id, secret)
    const lastUsedAt = async () =>
      (await IncomingWebhookRepository.listByBot(pool, ws, bot)).find((h) => h.id === row.id)?.lastUsedAt ?? null

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await lastUsedAt()).toBeNull()

    await service.post(authed!.hook, "used now")

    let touched = false
    for (let attempt = 0; attempt < 50 && !touched; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      touched = (await lastUsedAt()) != null
    }
    expect(touched).toBe(true)
  })

  test("should refuse a personal bot's hook when its owner can see the stream but is not a member", async () => {
    const publicChannel = streamId()
    const personalBot = botId()
    await withTransaction(pool, async (client) => {
      await StreamRepository.insert(client, {
        id: publicChannel,
        workspaceId: ws,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PUBLIC,
        slug: `s-${publicChannel.slice(-10)}`,
        createdBy: owner.id,
      })
      await BotRepository.create(client, {
        id: personalBot,
        workspaceId: ws,
        type: "personal",
        ownerUserId: owner.id,
        slug: `personal-${personalBot.slice(-6)}`,
        name: "Personal",
      })
    })

    const create = () =>
      service.create({
        workspaceId: ws,
        botId: personalBot,
        streamId: publicChannel,
        name: "Personal hook",
        createdBy: owner.id,
        personalOwnerId: owner.id,
      })

    expect(await capture(create)).toEqual({ status: 403, code: "FORBIDDEN" })
    expect((await service.listByBot(ws, personalBot)).map((h) => h.id)).toEqual([])
    expect(await BotChannelAccessRepository.getGrantedStreamIds(pool, ws, personalBot)).not.toContain(publicChannel)

    await withTransaction(pool, (client) => StreamMemberRepository.insert(client, publicChannel, owner.id))

    const { row } = await create()
    expect(row).toMatchObject({ botId: personalBot, streamId: publicChannel, name: "Personal hook" })
    expect(await BotChannelAccessRepository.getGrantedStreamIds(pool, ws, personalBot)).toContain(publicChannel)
  })

  test("should refuse moving a personal bot's hook to a stream its owner is not a member of", async () => {
    const publicChannel = streamId()
    const personalBot = botId()
    await withTransaction(pool, async (client) => {
      await StreamRepository.insert(client, {
        id: publicChannel,
        workspaceId: ws,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PUBLIC,
        slug: `s-${publicChannel.slice(-10)}`,
        createdBy: owner.id,
      })
      await BotRepository.create(client, {
        id: personalBot,
        workspaceId: ws,
        type: "personal",
        ownerUserId: owner.id,
        slug: `personal-${personalBot.slice(-6)}`,
        name: "Personal Mover",
      })
    })

    const { row } = await service.create({
      workspaceId: ws,
      botId: personalBot,
      streamId: channel,
      name: "Mover",
      createdBy: owner.id,
      personalOwnerId: owner.id,
    })

    const move = () =>
      service.update({
        workspaceId: ws,
        botId: personalBot,
        id: row.id,
        actorId: owner.id,
        personalOwnerId: owner.id,
        streamId: publicChannel,
      })

    expect(await capture(move)).toEqual({ status: 403, code: "FORBIDDEN" })
    expect((await service.listByBot(ws, personalBot)).find((h) => h.id === row.id)).toMatchObject({
      name: "Mover",
      streamId: channel,
    })

    await withTransaction(pool, (client) => StreamMemberRepository.insert(client, publicChannel, owner.id))
    expect(await move()).toMatchObject({ id: row.id, streamId: publicChannel })
  })

  test("should rename a hook, move it to another stream and keep its secret working", async () => {
    const otherChannel = streamId()
    await withTransaction(pool, async (client) => {
      await StreamRepository.insert(client, {
        id: otherChannel,
        workspaceId: ws,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PRIVATE,
        slug: `s-${otherChannel.slice(-10)}`,
        createdBy: owner.id,
      })
      await StreamMemberRepository.insert(client, otherChannel, owner.id)
    })

    const { row, secret } = await service.create({
      workspaceId: ws,
      botId: bot,
      streamId: channel,
      name: "Before",
      createdBy: owner.id,
    })

    const renamed = await service.update({
      workspaceId: ws,
      botId: bot,
      id: row.id,
      actorId: owner.id,
      name: "After",
    })
    expect(renamed).toMatchObject({ id: row.id, name: "After", streamId: channel })

    const moved = await service.update({
      workspaceId: ws,
      botId: bot,
      id: row.id,
      actorId: owner.id,
      streamId: otherChannel,
    })
    expect(moved).toMatchObject({ id: row.id, name: "After", streamId: otherChannel })

    const granted = await BotChannelAccessRepository.getGrantedStreamIds(pool, ws, bot)
    expect(granted).toContain(otherChannel)

    const authed = await service.authenticate(ws, row.id, secret)
    expect(authed?.hook).toMatchObject({ id: row.id, streamId: otherChannel })

    const { messageId } = await service.post(authed!.hook, "moved along")
    const posted = await pool.query<{ stream_id: string }>(sql`SELECT stream_id FROM messages WHERE id = ${messageId}`)
    expect(posted.rows[0].stream_id).toBe(otherChannel)
  })

  test("should refuse an edit against a thread, an E2E stream, an inaccessible stream or a revoked hook", async () => {
    const { row } = await service.create({
      workspaceId: ws,
      botId: bot,
      streamId: channel,
      name: "Editable",
      createdBy: owner.id,
    })
    const edit = (patch: { streamId?: string; actorId?: string; id?: string }) =>
      service.update({
        workspaceId: ws,
        botId: bot,
        id: patch.id ?? row.id,
        actorId: patch.actorId ?? owner.id,
        ...(patch.streamId !== undefined && { streamId: patch.streamId }),
        ...(patch.streamId === undefined && { name: "Renamed" }),
      })

    expect(await capture(() => edit({ streamId: thread }))).toEqual({ status: 400, code: "STREAM_TYPE_NOT_SUPPORTED" })
    expect(await capture(() => edit({ streamId: e2eChannel }))).toEqual({
      status: 400,
      code: "E2E_STREAM_NOT_SUPPORTED",
    })
    expect(await capture(() => edit({ streamId: archivedChannel }))).toEqual({ status: 404, code: "STREAM_NOT_FOUND" })

    const stranger = await withTransaction(pool, (client) => addTestMember(client, ws, userId()))
    expect(await capture(() => edit({ streamId: channel, actorId: stranger.id }))).toEqual({
      status: 404,
      code: "NOT_FOUND",
    })

    // The rejected moves rolled back: the hook is untouched.
    expect((await service.listByBot(ws, bot)).find((h) => h.id === row.id)).toMatchObject({
      name: "Editable",
      streamId: channel,
    })

    expect(await capture(() => edit({ id: `${row.id}x` }))).toEqual({ status: 404, code: "NOT_FOUND" })

    await service.revoke(ws, bot, row.id)
    expect(await capture(() => edit({}))).toEqual({ status: 400, code: "ALREADY_REVOKED" })
  })

  test("should refuse creation when the target stream is E2E, a thread, archived or a system stream", async () => {
    expect(
      await capture(() =>
        service.create({ workspaceId: ws, botId: bot, streamId: e2eChannel, name: "E2E", createdBy: owner.id })
      )
    ).toEqual({ status: 400, code: "E2E_STREAM_NOT_SUPPORTED" })

    expect(
      await capture(() =>
        service.create({ workspaceId: ws, botId: bot, streamId: thread, name: "Thread", createdBy: owner.id })
      )
    ).toEqual({ status: 400, code: "STREAM_TYPE_NOT_SUPPORTED" })

    expect(
      await capture(() =>
        service.create({
          workspaceId: ws,
          botId: bot,
          streamId: archivedChannel,
          name: "Archived",
          createdBy: owner.id,
        })
      )
    ).toEqual({ status: 404, code: "STREAM_NOT_FOUND" })

    const systemStream = streamId()
    await withTransaction(pool, async (client) => {
      await StreamRepository.insert(client, {
        id: systemStream,
        workspaceId: ws,
        type: StreamTypes.SYSTEM,
        visibility: Visibilities.PRIVATE,
        createdBy: owner.id,
      })
      await StreamMemberRepository.insert(client, systemStream, owner.id)
    })
    expect(
      await capture(() =>
        service.create({ workspaceId: ws, botId: bot, streamId: systemStream, name: "System", createdBy: owner.id })
      )
    ).toEqual({ status: 400, code: "STREAM_TYPE_NOT_SUPPORTED" })
  })

  test("should return null when the hook's bot is archived", async () => {
    const retiredBot = botId()
    await withTransaction(pool, (client) =>
      BotRepository.create(client, {
        id: retiredBot,
        workspaceId: ws,
        type: "shared",
        ownerUserId: null,
        slug: "retired-bot",
        name: "Retired",
      })
    )

    const { row, secret } = await service.create({
      workspaceId: ws,
      botId: retiredBot,
      streamId: channel,
      name: "Retired",
      createdBy: owner.id,
    })
    expect(await service.authenticate(ws, row.id, secret)).not.toBeNull()

    await pool.query(sql`UPDATE bots SET archived_at = NOW() WHERE id = ${retiredBot}`)
    expect(await service.authenticate(ws, row.id, secret)).toBeNull()
  })

  test("should refuse creation when the creator cannot access the stream", async () => {
    const stranger = await withTransaction(pool, (client) => addTestMember(client, ws, userId()))
    expect(
      await capture(() =>
        service.create({ workspaceId: ws, botId: bot, streamId: channel, name: "Nope", createdBy: stranger.id })
      )
    ).toEqual({ status: 404, code: "NOT_FOUND" })
  })

  test("should refuse the 26th active hook for a bot", async () => {
    const cappedBot = botId()
    await withTransaction(pool, (client) =>
      BotRepository.create(client, {
        id: cappedBot,
        workspaceId: ws,
        type: "shared",
        ownerUserId: null,
        slug: "capped-bot",
        name: "Capped",
      })
    )

    for (let i = 0; i < 25; i++) {
      await service.create({
        workspaceId: ws,
        botId: cappedBot,
        streamId: channel,
        name: `Hook ${i}`,
        createdBy: owner.id,
      })
    }

    expect(
      await capture(() =>
        service.create({ workspaceId: ws, botId: cappedBot, streamId: channel, name: "26", createdBy: owner.id })
      )
    ).toEqual({ status: 400, code: "WEBHOOK_LIMIT_REACHED" })
  })
})
