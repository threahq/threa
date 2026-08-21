/**
 * `messages.revision` — the number a pinned reference resolves against.
 *
 * It used to be derived as `MAX(message_versions.version_number) + 1`. The
 * column has to agree with that derivation for rows written before it existed
 * and for every row written after, so both the live edit path and the
 * migration's backfill are exercised against the real schema (INV-68).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { resolve } from "node:path"
import { setupTestDatabase, withTransaction, withTestTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { EventService, MessageRepository, MessageVersionRepository } from "../../src/features/messaging"
import type { MessageCreatedPayload, MessageEditedPayload } from "../../src/features/messaging"
import { userId, workspaceId, streamId } from "../../src/lib/id"

const MIGRATION_PATH = resolve(import.meta.dir, "../../src/db/migrations/20260821120000_messages_revision.sql")

describe("message revision", () => {
  let pool: Pool
  let eventService: EventService
  let testWorkspaceId: string
  let testUserId: string
  let channel: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    eventService = new EventService(pool)
    testWorkspaceId = workspaceId()
    testUserId = userId()
    channel = streamId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Message Revision",
        slug: `message-revision-${testWorkspaceId}`,
        createdBy: testUserId,
      })
      testUserId = (await addTestMember(client, testWorkspaceId, testUserId)).id
      await StreamRepository.insert(client, {
        id: channel,
        workspaceId: testWorkspaceId,
        type: "channel",
        visibility: "private",
        slug: `s-${channel.slice(-8)}`,
        createdBy: testUserId,
      })
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("a created message is revision 1 and says so on its payload", async () => {
    const message = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: channel,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("first"),
    })

    expect(message.revision).toBe(1)
    expect(await MessageVersionRepository.getCurrentRevision(pool, message.id)).toBe(1)

    const events = await eventService.listEvents(channel, { limit: 200 })
    const created = events.find(
      (e) => e.eventType === "message_created" && (e.payload as MessageCreatedPayload).messageId === message.id
    )?.payload as MessageCreatedPayload
    expect(created.revision).toBe(1)
  })

  test("two edits leave the message at revision 3, snapshotting 1 and 2", async () => {
    const message = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: channel,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("v1 body"),
    })

    for (const body of ["v2 body", "v3 body"]) {
      await eventService.editMessageInternal({
        workspaceId: testWorkspaceId,
        messageId: message.id,
        streamId: channel,
        actorId: testUserId,
        ...testMessageContent(body),
      })
    }

    const stored = await MessageRepository.findById(pool, message.id)
    expect(stored?.revision).toBe(3)
    expect(await MessageVersionRepository.getCurrentRevision(pool, message.id)).toBe(3)

    const versions = await MessageVersionRepository.listByMessageId(pool, message.id)
    expect(versions.map((v) => ({ versionNumber: v.versionNumber, contentMarkdown: v.contentMarkdown }))).toEqual([
      { versionNumber: 1, contentMarkdown: "v1 body" },
      { versionNumber: 2, contentMarkdown: "v2 body" },
    ])

    const events = await eventService.listEvents(channel, { limit: 200 })
    const edits = events
      .filter((e) => e.eventType === "message_edited" && (e.payload as MessageEditedPayload).messageId === message.id)
      .map((e) => (e.payload as MessageEditedPayload).revision)
    expect(edits).toEqual([2, 3])

    // `message_edited` is filtered out of a bootstrap window, so the pin a
    // client can read comes from the overlaid `message_created` payload.
    const enriched = await eventService.enrichBootstrapEvents(events, new Map(), new Map(), {
      workspaceId: testWorkspaceId,
      streamId: channel,
    })
    const created = enriched.find(
      (e) => e.eventType === "message_created" && (e.payload as MessageCreatedPayload).messageId === message.id
    )?.payload as MessageCreatedPayload
    expect(created.revision).toBe(3)
    expect(created.contentMarkdown).toBe("v3 body")
  })

  test("getCurrentRevision is null for a message that does not exist", async () => {
    expect(await MessageVersionRepository.getCurrentRevision(pool, "msg_missing")).toBeNull()
  })

  describe("migration backfill", () => {
    test("historical rows land on MAX(version_number) + 1, unedited rows stay at 1", async () => {
      const migrationSql = await Bun.file(MIGRATION_PATH).text()

      await withTestTransaction(pool, async (client) => {
        const edited = "msg_backfill_edited"
        const untouched = "msg_backfill_untouched"
        for (const id of [edited, untouched]) {
          await MessageRepository.insert(client, {
            id,
            streamId: channel,
            sequence: BigInt(id === edited ? 900001 : 900002),
            authorId: testUserId,
            authorType: "user",
            ...testMessageContent("body"),
          })
        }
        // Pre-migration state: the derived number lived only in message_versions.
        await client.query(`UPDATE messages SET revision = 1 WHERE id = ANY($1)`, [[edited, untouched]])
        await client.query(
          `INSERT INTO message_versions (id, message_id, version_number, content_json, content_markdown, edited_by)
           VALUES ('mver_bf1', $1, 1, '{"type":"doc","content":[]}', 'v1', $2),
                  ('mver_bf2', $1, 2, '{"type":"doc","content":[]}', 'v2', $2)`,
          [edited, testUserId]
        )

        await client.query(migrationSql)

        const rows = await client.query<{ id: string; revision: number }>(
          `SELECT id, revision FROM messages WHERE id = ANY($1) ORDER BY id`,
          [[edited, untouched]]
        )
        expect(rows.rows).toEqual([
          { id: edited, revision: 3 },
          { id: untouched, revision: 1 },
        ])
      })
    })
  })
})
