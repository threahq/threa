import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { Visibilities } from "@threahq/types"
import { addTestMember, setupTestDatabase, testMessageContent, withTransaction } from "./setup"
import { EventService } from "../../src/features/messaging"
import { StreamService } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { userId, workspaceId } from "../../src/lib/id"

describe("EventService.listEventsAroundDate anchor", () => {
  let pool: Pool
  let eventService: EventService
  let wsId: string
  let streamId: string
  const messageIds: string[] = []

  const dayMs = 24 * 60 * 60 * 1000
  const base = new Date("2026-03-01T12:00:00.000Z").getTime()

  beforeAll(async () => {
    pool = await setupTestDatabase()
    eventService = new EventService(pool)
    const streamService = new StreamService(pool)
    wsId = workspaceId()
    const user = await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Date jump",
        slug: `date-jump-${wsId}`,
        createdBy: userId(),
      })
      return addTestMember(client, wsId, userId())
    })
    const channel = await streamService.createChannel({
      workspaceId: wsId,
      slug: `date-jump-${Math.random().toString(36).slice(2, 8)}`,
      createdBy: user.id,
      visibility: Visibilities.PUBLIC,
    })
    streamId = channel.id

    // Messages on Mar 1, Mar 3 and Mar 5.
    for (const day of [0, 2, 4]) {
      const message = await eventService.createMessage({
        workspaceId: wsId,
        streamId,
        authorId: user.id,
        authorType: "user",
        ...testMessageContent(`day ${day}`),
      })
      await pool.query(
        `UPDATE stream_events SET created_at = $1
         WHERE workspace_id = $2 AND stream_id = $3 AND payload->>'messageId' = $4`,
        [new Date(base + day * dayMs), wsId, streamId, message.id]
      )
      messageIds.push(message.id)
    }
  })

  afterAll(async () => {
    await pool.end()
  })

  const anchorFor = async (date: Date) =>
    (await eventService.listEventsAroundDate(wsId, streamId, date)).anchorMessageId

  test("lands on the first message on or after the date", async () => {
    expect(await anchorFor(new Date(base + 1 * dayMs))).toBe(messageIds[1])
    expect(await anchorFor(new Date(base + 2 * dayMs))).toBe(messageIds[1])
  })

  test("lands on the first message when the date is before the stream's history", async () => {
    expect(await anchorFor(new Date(base - 30 * dayMs))).toBe(messageIds[0])
  })

  test("lands on the latest message when the date is past the stream's last message", async () => {
    const result = await eventService.listEventsAroundDate(wsId, streamId, new Date(base + 30 * dayMs))
    expect(result.anchorMessageId).toBe(messageIds[2])
    expect(result.hasNewer).toBe(false)
  })
})
