import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { addTestMember, setupTestDatabase } from "./setup"
import { LinkPreviewRepository } from "../../src/features/link-previews"
import { SavedMessagesRepository, SavedMessagesService } from "../../src/features/saved-messages"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { linkPreviewId, messageId, savedMessageId, userId, workspaceId } from "../../src/lib/id"

describe("Saved reminder and link preview lookups workspace scope (INV-8)", () => {
  let pool: Pool
  let service: SavedMessagesService

  let wsA: string
  let wsB: string
  let memberA: string
  let memberB: string

  async function seedWorkspace(label: string) {
    const id = workspaceId()
    await WorkspaceRepository.insert(pool, {
      id,
      name: `Saved scope ${label}`,
      slug: `saved-scope-${label}-${id}`,
      createdBy: userId(),
    })
    return id
  }

  async function seedMember(wid: string) {
    return (await addTestMember(pool, wid, userId())).id
  }

  async function seedSaved(wid: string, user: string) {
    const id = savedMessageId()
    await pool.query(
      `INSERT INTO saved_messages (id, workspace_id, user_id, title, status, remind_at)
       VALUES ($1, $2, $3, 'scope fixture', 'saved', NOW())`,
      [id, wid, user]
    )
    return id
  }

  async function storedSaved(id: string) {
    const result = await pool.query(
      `SELECT workspace_id, user_id, status, reminder_sent_at, updated_at FROM saved_messages WHERE id = $1`,
      [id]
    )
    return result.rows[0]
  }

  async function seedPreview(wid: string, url: string) {
    const id = linkPreviewId()
    await LinkPreviewRepository.insert(pool, {
      id,
      workspaceId: wid,
      url,
      normalizedUrl: url,
      contentType: "website",
    })
    return id
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    service = new SavedMessagesService({ pool })

    wsA = await seedWorkspace("a")
    wsB = await seedWorkspace("b")
    memberA = await seedMember(wsA)
    memberB = await seedMember(wsB)
  }, 60_000)

  afterAll(async () => {
    await pool.end()
  })

  describe("saved reminders", () => {
    test("should leave another workspace's saved row untouched when marking its id as sent", async () => {
      const foreign = await seedSaved(wsB, memberB)
      const before = await storedSaved(foreign)

      const marked = await SavedMessagesRepository.markReminderSent(pool, wsA, foreign, new Date())

      expect({ marked, stored: await storedSaved(foreign) }).toEqual({ marked: null, stored: before })
    })

    test("should not find another workspace's saved row when it carries the caller's user id", async () => {
      const foreign = await seedSaved(wsB, memberA)

      const found = await SavedMessagesRepository.findById(pool, wsA, memberA, foreign)

      expect(found).toBeNull()
    })

    test("should mark the workspace's own saved row as sent", async () => {
      const own = await seedSaved(wsA, memberA)
      const sentAt = new Date("2026-02-03T04:05:06.000Z")

      const marked = await SavedMessagesRepository.markReminderSent(pool, wsA, own, sentAt)

      expect({
        id: marked?.id,
        reminderSentAt: marked?.reminderSentAt,
        stored: (await storedSaved(own)).reminder_sent_at,
      }).toEqual({
        id: own,
        reminderSentAt: sentAt,
        stored: sentAt,
      })
    })

    test("should not fire another workspace's reminder when its id arrives through the worker's service call", async () => {
      const foreign = await seedSaved(wsB, memberA)
      const before = await storedSaved(foreign)

      const result = await service.markReminderFired({ workspaceId: wsA, userId: memberA, savedId: foreign })

      expect({ result, stored: await storedSaved(foreign) }).toEqual({ result: { fired: false }, stored: before })
    })

    test("should not fire another user's reminder in the same workspace when the worker's service call names a different user", async () => {
      const otherUsers = await seedSaved(wsA, await seedMember(wsA))
      const before = await storedSaved(otherUsers)

      const result = await service.markReminderFired({ workspaceId: wsA, userId: memberA, savedId: otherUsers })

      expect({ result, stored: await storedSaved(otherUsers) }).toEqual({ result: { fired: false }, stored: before })
    })

    test("should fire the workspace's own reminder when the worker's service call names its workspace and user", async () => {
      const own = await seedSaved(wsA, memberA)

      const result = await service.markReminderFired({ workspaceId: wsA, userId: memberA, savedId: own })

      expect({ result, sent: (await storedSaved(own)).reminder_sent_at !== null }).toEqual({
        result: { fired: true },
        sent: true,
      })
    })
  })

  describe("link previews", () => {
    let messageA: string
    let previewA: string
    let previewB: string

    beforeAll(async () => {
      messageA = messageId()
      previewA = await seedPreview(wsA, `https://example.test/${messageA}/own`)
      previewB = await seedPreview(wsB, `https://example.test/${messageA}/foreign`)
      await LinkPreviewRepository.linkToMessage(pool, wsA, messageA, previewA, 0)
      await LinkPreviewRepository.linkToMessage(pool, wsA, messageA, previewB, 1)
      await LinkPreviewRepository.linkToMessage(pool, wsB, messageA, previewB, 2)
    })

    test("should return only the workspace's previews when another workspace's preview or link row names the message", async () => {
      const previews = await LinkPreviewRepository.findByMessageId(pool, wsA, messageA)

      expect(previews.map((preview) => ({ id: preview.id, workspaceId: preview.workspaceId }))).toEqual([
        { id: previewA, workspaceId: wsA },
      ])
    })

    test("should return only the workspace's previews per message when another workspace's preview or link row names the message", async () => {
      const previews = await LinkPreviewRepository.findByMessageIds(pool, wsA, [messageA])

      expect(
        Object.fromEntries(
          [...previews].map(([message, rows]) => [
            message,
            rows.map((row) => ({ id: row.id, workspaceId: row.workspaceId })),
          ])
        )
      ).toEqual({ [messageA]: [{ id: previewA, workspaceId: wsA }] })
    })
  })
})
