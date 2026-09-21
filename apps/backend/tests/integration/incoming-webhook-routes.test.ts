import { beforeAll, describe, expect, test } from "bun:test"
import type { NextFunction, Request, Response } from "express"
import type { Pool } from "pg"
import { HttpError } from "@threahq/backend-common"
import { StreamTypes, Visibilities } from "@threahq/types"
import { addTestMember, setupTestDatabase, withTransaction } from "./setup"
import { WorkspaceRepository, type User } from "../../src/features/workspaces"
import { StreamMemberRepository, StreamRepository, StreamService } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { BotRepository } from "../../src/features/public-api"
import { createIncomingWebhookHandlers, IncomingWebhookService } from "../../src/features/incoming-webhooks"
import { createRequireBotManagement } from "../../src/middleware/bot-management"
import { botId, streamId, userId, workspaceId } from "../../src/lib/id"

interface Outcome {
  status: number
  code?: string
  body?: unknown
}

describe("bot webhook management routes", () => {
  let pool: Pool
  let handlers: ReturnType<typeof createIncomingWebhookHandlers>
  let requireBotManagement: ReturnType<ReturnType<typeof createRequireBotManagement>>
  const ws = workspaceId()
  const bot = botId()
  const channel = streamId()
  const privateChannel = streamId()
  const secondChannel = streamId()
  let admin: User
  let member: User

  /** Runs the same middleware/handler chain the route registers. */
  async function call(
    handler: (req: Request, res: Response) => Promise<void>,
    user: User,
    options: { params?: Record<string, string>; body?: unknown } = {}
  ): Promise<Outcome> {
    const req = {
      workspaceId: ws,
      params: { botId: bot, ...options.params },
      body: options.body ?? {},
      user,
    } as unknown as Request

    let status = 200
    let body: unknown
    const res = {
      status(next: number) {
        status = next
        return res
      },
      json(payload: unknown) {
        body = payload
        return res
      },
      send() {
        return res
      },
    } as unknown as Response & { status(n: number): Response }

    const gate = await new Promise<HttpError | null>((resolve, reject) => {
      const next: NextFunction = (err?: unknown) => {
        if (!err) return resolve(null)
        if (err instanceof HttpError) return resolve(err)
        reject(err)
      }
      void requireBotManagement(req, res, next)
    })
    if (gate) return { status: gate.status, code: gate.code }

    try {
      await handler(req, res)
      return { status, body }
    } catch (err) {
      if (!(err instanceof HttpError)) throw err
      return { status: err.status, code: err.code }
    }
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    handlers = createIncomingWebhookHandlers({
      incomingWebhookService: new IncomingWebhookService({
        pool,
        streamService: new StreamService(pool),
        eventService: new EventService(pool),
      }),
    })
    requireBotManagement = createRequireBotManagement(pool)()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: ws,
        name: "Hook Routes",
        slug: `hook-routes-${ws}`,
        createdBy: userId(),
      })
      admin = await addTestMember(client, ws, userId(), "admin")
      member = await addTestMember(client, ws, userId())

      for (const [id, visibility] of [
        [channel, Visibilities.PUBLIC],
        [secondChannel, Visibilities.PUBLIC],
        [privateChannel, Visibilities.PRIVATE],
      ] as const) {
        await StreamRepository.insert(client, {
          id,
          workspaceId: ws,
          type: StreamTypes.CHANNEL,
          visibility,
          slug: `s-${id.slice(-10)}`,
          createdBy: admin.id,
        })
      }
      await StreamMemberRepository.insert(client, privateChannel, member.id)

      await BotRepository.create(client, {
        id: bot,
        workspaceId: ws,
        type: "shared",
        ownerUserId: null,
        slug: "route-bot",
        name: "Route Bot",
      })
    })
  })

  test("should create, list and revoke a webhook, handing back the secret exactly once", async () => {
    const created = await call(handlers.create, admin, { body: { name: "  Alerts  ", streamId: channel } })
    expect(created.status).toBe(201)

    const payload = created.body as { webhook: Record<string, unknown>; secret: string }
    expect(Object.keys(payload).sort()).toEqual(["secret", "webhook"])
    expect(Object.keys(payload.webhook).sort()).toEqual([
      "botId",
      "createdAt",
      "id",
      "lastUsedAt",
      "name",
      "revokedAt",
      "streamId",
    ])
    expect(payload.webhook).toMatchObject({
      botId: bot,
      streamId: channel,
      name: "Alerts",
      lastUsedAt: null,
      revokedAt: null,
    })
    expect(typeof payload.secret).toBe("string")
    expect(JSON.stringify(created.body)).not.toContain("secretHash")

    const hookId = payload.webhook.id as string
    const listed = await call(handlers.list, admin)
    expect(listed.status).toBe(200)
    const rows = (listed.body as { data: Array<Record<string, unknown>> }).data
    expect(rows.find((row) => row.id === hookId)).toMatchObject({ name: "Alerts", revokedAt: null })
    expect(JSON.stringify(listed.body)).not.toContain(payload.secret)

    const revoked = await call(handlers.revoke, admin, { params: { hookId } })
    expect(revoked.status).toBe(204)

    const afterRevoke = await call(handlers.list, admin)
    const row = (afterRevoke.body as { data: Array<Record<string, unknown>> }).data.find((r) => r.id === hookId)
    expect(typeof row?.revokedAt).toBe("string")

    expect(await call(handlers.revoke, admin, { params: { hookId } })).toEqual({
      status: 400,
      code: "ALREADY_REVOKED",
    })
  })

  test("should rename a webhook and move it to another stream over PATCH", async () => {
    const created = await call(handlers.create, admin, { body: { name: "Editable", streamId: channel } })
    const hookId = (created.body as { webhook: { id: string } }).webhook.id

    const updated = await call(handlers.update, admin, {
      params: { hookId },
      body: { name: "  Renamed  ", streamId: secondChannel },
    })
    expect(updated.status).toBe(200)
    expect(updated.body).toMatchObject({
      webhook: { id: hookId, name: "Renamed", streamId: secondChannel, revokedAt: null },
    })
    expect(JSON.stringify(updated.body)).not.toContain("secret")

    expect(await call(handlers.update, admin, { params: { hookId }, body: {} })).toEqual({
      status: 400,
      code: "VALIDATION_ERROR",
    })
    expect(await call(handlers.update, admin, { params: { hookId }, body: { name: "   " } })).toEqual({
      status: 400,
      code: "VALIDATION_ERROR",
    })
    expect(await call(handlers.update, member, { params: { hookId }, body: { name: "Nope" } })).toEqual({
      status: 403,
      code: "FORBIDDEN",
    })
  })

  test("should deny a workspace member without bot management rights", async () => {
    expect(await call(handlers.list, member)).toEqual({ status: 403, code: "FORBIDDEN" })
    expect(await call(handlers.create, member, { body: { name: "Nope", streamId: privateChannel } })).toEqual({
      status: 403,
      code: "FORBIDDEN",
    })
  })

  test("should refuse creation against a stream the caller cannot access", async () => {
    expect(await call(handlers.create, admin, { body: { name: "Hidden", streamId: privateChannel } })).toEqual({
      status: 404,
      code: "NOT_FOUND",
    })
  })

  test("should refuse a personal bot's webhook on a public channel its owner has not joined", async () => {
    const personalBot = botId()
    await withTransaction(pool, (client) =>
      BotRepository.create(client, {
        id: personalBot,
        workspaceId: ws,
        type: "personal",
        ownerUserId: member.id,
        slug: "personal-route-bot",
        name: "Personal Route Bot",
      })
    )

    expect(
      await call(handlers.create, member, {
        params: { botId: personalBot },
        body: { name: "Personal", streamId: channel },
      })
    ).toEqual({ status: 403, code: "FORBIDDEN" })
  })

  test("should reject a create body with a blank name or a missing streamId", async () => {
    expect(await call(handlers.create, admin, { body: { name: "   ", streamId: channel } })).toEqual({
      status: 400,
      code: "VALIDATION_ERROR",
    })
    expect(await call(handlers.create, admin, { body: { name: "Alerts" } })).toEqual({
      status: 400,
      code: "VALIDATION_ERROR",
    })
  })
})
