import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import type { Pool } from "pg"
import { ActivityTypes, AuthorTypes, SavedStatuses, StreamTypes, Visibilities, type Visibility } from "@threahq/types"
import { setupTestDatabase, addTestMember, testMessageContent } from "./setup"
import { ActivityRepository, ActivityService } from "../../src/features/activity"
import { SavedMessagesService } from "../../src/features/saved-messages"
import {
  ReadStateRepository,
  StreamEventRepository,
  StreamMemberRepository,
  StreamRepository,
} from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { streamId, workspaceId } from "../../src/lib/id"

const IN_AN_HOUR = () => new Date(Date.now() + 60 * 60 * 1000)

describe("push source revalidation", () => {
  let pool: Pool
  let activityService: ActivityService
  let savedService: SavedMessagesService
  let eventService: EventService

  beforeAll(async () => {
    pool = await setupTestDatabase()
    activityService = new ActivityService({ pool })
    savedService = new SavedMessagesService({ pool })
    eventService = new EventService(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  async function workspaceWithUsers() {
    const ws = workspaceId()
    const author = await addTestMember(pool, ws, `author_${ws}`)
    const recipient = await addTestMember(pool, ws, `recipient_${ws}`)
    await WorkspaceRepository.insert(pool, { id: ws, name: "Push WS", slug: `push-${ws}`, createdBy: author.id })
    return { ws, author, recipient }
  }

  async function channel(ws: string, createdBy: string, visibility: Visibility, slug = `c-${streamId().slice(-8)}`) {
    return StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: ws,
      type: StreamTypes.CHANNEL,
      slug,
      visibility,
      createdBy,
    })
  }

  async function thread(ws: string, root: { id: string }, createdBy: string) {
    return StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: ws,
      type: StreamTypes.THREAD,
      displayName: "A thread",
      parentStreamId: root.id,
      rootStreamId: root.id,
      createdBy,
    })
  }

  async function post(ws: string, sid: string, authorId: string, text: string) {
    return eventService.createMessage({
      workspaceId: ws,
      streamId: sid,
      authorId,
      authorType: AuthorTypes.USER,
      ...testMessageContent(text),
    })
  }

  async function activity(params: {
    ws: string
    userId: string
    type: string
    streamId: string | null
    messageId: string | null
    actorId: string
    isSelf?: boolean
    emoji?: string
    context?: Record<string, unknown>
  }) {
    const row = await ActivityRepository.insert(pool, {
      workspaceId: params.ws,
      userId: params.userId,
      activityType: params.type,
      streamId: params.streamId,
      messageId: params.messageId,
      actorId: params.actorId,
      actorType: AuthorTypes.USER,
      isSelf: params.isSelf,
      emoji: params.emoji ?? null,
      context: params.context ?? { contentPreview: "stale snapshot preview", streamName: "stale" },
    })
    return row!
  }

  /** `plannedStreamId` defaults to the row's current stream, i.e. nothing moved since planning. */
  async function resolve(ws: string, userId: string, activityId: string, plannedStreamId?: string | null) {
    const planned =
      plannedStreamId !== undefined
        ? plannedStreamId
        : ((
            await pool.query<{ stream_id: string | null }>("SELECT stream_id FROM user_activity WHERE id = $1", [
              activityId,
            ])
          ).rows[0]?.stream_id ?? null)
    return activityService.resolvePushSource({ workspaceId: ws, userId, activityId, plannedStreamId: planned })
  }

  describe("activity", () => {
    test("should grant a non-member of a thread inside a private root they belong to, with current content", async () => {
      const { ws, author, recipient } = await workspaceWithUsers()
      const root = await channel(ws, author.id, Visibilities.PRIVATE, "secret")
      await StreamMemberRepository.insertMany(pool, ws, root.id, [author.id, recipient.id])
      const child = await thread(ws, root, author.id)
      const message = await post(ws, child.id, author.id, "original text")
      const row = await activity({
        ws,
        userId: recipient.id,
        type: ActivityTypes.MENTION,
        streamId: child.id,
        messageId: message.id,
        actorId: author.id,
      })
      await eventService.editMessageInternal({
        workspaceId: ws,
        messageId: message.id,
        streamId: child.id,
        actorId: author.id,
        ...testMessageContent("edited text"),
      })

      expect(await resolve(ws, recipient.id, row.id)).toEqual({
        valid: true,
        source: {
          activityId: row.id,
          activityType: ActivityTypes.MENTION,
          streamId: child.id,
          messageId: message.id,
          contentMarkdown: "edited text",
          encrypted: false,
          e2eRooted: false,
          streamName: "A thread",
          authorName: author.name,
          authorAvatarUrl: undefined,
          emoji: null,
          mode: null,
        },
      })
    })

    test("should deny the same thread once the user is removed from the private root", async () => {
      const { ws, author, recipient } = await workspaceWithUsers()
      const root = await channel(ws, author.id, Visibilities.PRIVATE)
      await StreamMemberRepository.insertMany(pool, ws, root.id, [author.id, recipient.id])
      const child = await thread(ws, root, author.id)
      // A direct thread row must not keep access alive without the root (INV-62).
      await StreamMemberRepository.insert(pool, ws, child.id, recipient.id)
      const message = await post(ws, child.id, author.id, "hi")
      const row = await activity({
        ws,
        userId: recipient.id,
        type: ActivityTypes.MESSAGE,
        streamId: child.id,
        messageId: message.id,
        actorId: author.id,
      })
      await StreamMemberRepository.delete(pool, root.id, recipient.id)

      expect(await resolve(ws, recipient.id, row.id)).toEqual({ valid: false, reason: "access_lost" })
    })

    test("should grant a thread of a public root without any membership row", async () => {
      const { ws, author, recipient } = await workspaceWithUsers()
      const root = await channel(ws, author.id, Visibilities.PUBLIC, "general")
      const child = await thread(ws, root, author.id)
      const message = await post(ws, child.id, author.id, "public thread")
      const row = await activity({
        ws,
        userId: recipient.id,
        type: ActivityTypes.MESSAGE,
        streamId: child.id,
        messageId: message.id,
        actorId: author.id,
      })

      expect(await resolve(ws, recipient.id, row.id)).toMatchObject({
        valid: true,
        source: { contentMarkdown: "public thread" },
      })
    })

    test("should invalidate on activity read, deleted message, moved message, sealed stream and missing or foreign row", async () => {
      const { ws, author, recipient } = await workspaceWithUsers()
      const root = await channel(ws, author.id, Visibilities.PUBLIC)
      const other = await channel(ws, author.id, Visibilities.PUBLIC)
      const [readMsg, deletedMsg, movedMsg, sealedMsg] = [
        await post(ws, root.id, author.id, "one"),
        await post(ws, root.id, author.id, "two"),
        await post(ws, root.id, author.id, "three"),
        await post(ws, root.id, author.id, "four"),
      ]
      const make = (messageId: string) =>
        activity({
          ws,
          userId: recipient.id,
          type: ActivityTypes.REACTION,
          streamId: root.id,
          messageId,
          actorId: author.id,
          emoji: ":+1:",
        })
      const readRow = await make(readMsg.id)
      const deletedRow = await make(deletedMsg.id)
      const movedRow = await make(movedMsg.id)

      await activityService.markAsRead(recipient.id, ws, readRow.id)
      await eventService.deleteMessageInternal({
        workspaceId: ws,
        messageId: deletedMsg.id,
        streamId: root.id,
        actorId: author.id,
      })
      // The end state of a message move: the message now lives in another stream.
      await pool.query("UPDATE messages SET stream_id = $1 WHERE id = $2", [other.id, movedMsg.id])

      const before = await Promise.all([readRow, deletedRow, movedRow].map((r) => resolve(ws, recipient.id, r.id)))
      await pool.query("UPDATE streams SET archived_at = NOW() WHERE id = $1", [root.id])
      const sealedRow = await make(sealedMsg.id)
      const sealed = await resolve(ws, recipient.id, sealedRow.id)
      const missing = await resolve(ws, recipient.id, "activity_missing")
      const wrongUser = await resolve(ws, author.id, movedRow.id)
      const wrongWorkspace = await resolve(workspaceId(), recipient.id, sealedRow.id)

      expect([...before, sealed, missing, wrongUser, wrongWorkspace]).toEqual([
        { valid: false, reason: "read" },
        // Deleting a message clears its unread activity in the same transaction.
        { valid: false, reason: "read" },
        { valid: false, reason: "moved" },
        { valid: false, reason: "sealed" },
        { valid: false, reason: "gone" },
        { valid: false, reason: "gone" },
        { valid: false, reason: "gone" },
      ])
    })

    test("should report a mention moved into a thread as moved, even though its activity row followed the message", async () => {
      const { ws, author, recipient } = await workspaceWithUsers()
      const root = await channel(ws, author.id, Visibilities.PUBLIC)
      await StreamMemberRepository.insertMany(pool, ws, root.id, [author.id, recipient.id])
      const anchor = await post(ws, root.id, author.id, "anchor")
      const mentioned = await post(ws, root.id, author.id, "ping")
      const row = await activity({
        ws,
        userId: recipient.id,
        type: ActivityTypes.MENTION,
        streamId: root.id,
        messageId: mentioned.id,
        actorId: author.id,
      })
      const before = await resolve(ws, recipient.id, row.id, root.id)

      const validation = await eventService.validateMoveMessagesToThread({
        workspaceId: ws,
        sourceStreamId: root.id,
        targetMessageId: anchor.id,
        messageIds: [mentioned.id],
        actorId: author.id,
      })
      const moved = await eventService.moveMessagesToThreadInternal({
        workspaceId: ws,
        sourceStreamId: root.id,
        targetMessageId: anchor.id,
        messageIds: [mentioned.id],
        actorId: author.id,
        leaseKey: validation.leaseKey,
      })
      const rowAfterMove = await ActivityRepository.findForUser(pool, ws, recipient.id, row.id)

      expect({
        before: before.valid,
        rowStreamAfterMove: rowAfterMove?.activity.streamId,
        after: await resolve(ws, recipient.id, row.id, root.id),
      }).toEqual({
        before: true,
        rowStreamAfterMove: moved.thread.id,
        after: { valid: false, reason: "moved" },
      })
    })

    test("should treat the read watermark as read for messages and mentions but not reactions", async () => {
      const { ws, author, recipient } = await workspaceWithUsers()
      const root = await channel(ws, author.id, Visibilities.PUBLIC)
      const message = await post(ws, root.id, author.id, "watermarked")
      const rows = await Promise.all(
        [ActivityTypes.MESSAGE, ActivityTypes.MENTION, ActivityTypes.REACTION].map((type) =>
          activity({
            ws,
            userId: recipient.id,
            type,
            streamId: root.id,
            messageId: message.id,
            actorId: author.id,
            emoji: type === ActivityTypes.REACTION ? ":tada:" : undefined,
          })
        )
      )
      const event = await StreamEventRepository.findByMessageId(pool, root.id, message.id)
      await ReadStateRepository.advance(pool, root.id, recipient.id, event!.id, { holdInInbox: false })

      const results = await Promise.all(rows.map((r) => resolve(ws, recipient.id, r.id)))
      expect(results.map((r) => (r.valid ? "valid" : r.reason))).toEqual(["read", "read", "valid"])
    })

    test("should report a removed reaction as gone", async () => {
      const { ws, author, recipient } = await workspaceWithUsers()
      const root = await channel(ws, author.id, Visibilities.PUBLIC)
      const message = await post(ws, root.id, recipient.id, "my message")
      const row = await activity({
        ws,
        userId: recipient.id,
        type: ActivityTypes.REACTION,
        streamId: root.id,
        messageId: message.id,
        actorId: author.id,
        emoji: ":heart:",
      })
      await activityService.processReactionRemoved({
        workspaceId: ws,
        messageId: message.id,
        actorId: author.id,
        emoji: ":heart:",
      })

      expect(await resolve(ws, recipient.id, row.id)).toEqual({ valid: false, reason: "gone" })
    })

    test("should never return plaintext for a thread under an end-to-end encrypted root", async () => {
      const { ws, author, recipient } = await workspaceWithUsers()
      const root = await channel(ws, author.id, Visibilities.PUBLIC)
      const child = await thread(ws, root, author.id)
      const message = await post(ws, child.id, author.id, "plaintext that must not leak")
      const row = await activity({
        ws,
        userId: recipient.id,
        type: ActivityTypes.MESSAGE,
        streamId: child.id,
        messageId: message.id,
        actorId: author.id,
      })
      // The thread has no e2e_streams row of its own; only the root is marked.
      await E2eStreamsRepository.markStreamE2e(pool, {
        streamId: root.id,
        workspaceId: ws,
        ownerUserId: author.id,
        ownerUserKeyId: "e2ek_owner",
      })

      expect(await resolve(ws, recipient.id, row.id)).toMatchObject({
        valid: true,
        source: { contentMarkdown: null, encrypted: true, e2eRooted: true },
      })
    })

    test("should keep a missed call valid with its mode until stream access is lost", async () => {
      const { ws, author, recipient } = await workspaceWithUsers()
      const dm = await channel(ws, author.id, Visibilities.PRIVATE)
      await StreamMemberRepository.insertMany(pool, ws, dm.id, [author.id, recipient.id])
      const row = await activity({
        ws,
        userId: recipient.id,
        type: ActivityTypes.MISSED_CALL,
        streamId: dm.id,
        messageId: null,
        actorId: author.id,
        context: { authorName: "stale", mode: "video", callId: "call_x" },
      })

      const before = await resolve(ws, recipient.id, row.id)
      await StreamMemberRepository.delete(pool, dm.id, recipient.id)
      const after = await resolve(ws, recipient.id, row.id)

      expect({ before, after }).toEqual({
        before: {
          valid: true,
          source: {
            activityId: row.id,
            activityType: ActivityTypes.MISSED_CALL,
            streamId: dm.id,
            messageId: null,
            contentMarkdown: null,
            encrypted: false,
            e2eRooted: false,
            // The calls feature labels a missed call with the display name, else the bare slug.
            streamName: dm.slug,
            authorName: author.name,
            authorAvatarUrl: undefined,
            emoji: null,
            mode: "video",
          },
        },
        after: { valid: false, reason: "access_lost" },
      })
    })

    test("should not push self rows, member-added rows or saved-reminder rows", async () => {
      const { ws, author, recipient } = await workspaceWithUsers()
      const root = await channel(ws, author.id, Visibilities.PUBLIC)
      const message = await post(ws, root.id, author.id, "x")
      const self = await activity({
        ws,
        userId: recipient.id,
        type: ActivityTypes.REACTION,
        streamId: root.id,
        messageId: message.id,
        actorId: recipient.id,
        isSelf: true,
        emoji: ":ok:",
      })
      const added = await activity({
        ws,
        userId: recipient.id,
        type: ActivityTypes.MEMBER_ADDED,
        streamId: root.id,
        messageId: null,
        actorId: author.id,
      })
      const reminder = await activity({
        ws,
        userId: recipient.id,
        type: ActivityTypes.SAVED_REMINDER,
        streamId: null,
        messageId: null,
        actorId: AuthorTypes.SYSTEM,
      })

      const results = await Promise.all([self, added, reminder].map((r) => resolve(ws, recipient.id, r.id)))
      expect(results).toEqual([
        { valid: false, reason: "not_pushable" },
        { valid: false, reason: "not_pushable" },
        { valid: false, reason: "not_pushable" },
      ])
    })
  })

  describe("saved reminder", () => {
    async function firedGeneration(savedId: string): Promise<number | undefined> {
      const result = await pool.query(
        `SELECT payload FROM outbox WHERE event_type = 'saved_reminder:fired' AND payload->>'savedId' = $1
         ORDER BY id DESC LIMIT 1`,
        [savedId]
      )
      return result.rows[0]?.payload.reminderGeneration
    }

    async function fire(savedId: string): Promise<number> {
      expect(await savedService.markReminderFired({ savedId })).toEqual({ fired: true })
      return (await firedGeneration(savedId))!
    }

    async function savedMessage() {
      const { ws, author, recipient } = await workspaceWithUsers()
      const root = await channel(ws, author.id, Visibilities.PUBLIC, "ops")
      const message = await post(ws, root.id, author.id, "remember this")
      const saved = await savedService.save({
        workspaceId: ws,
        userId: recipient.id,
        messageId: message.id,
        remindAt: IN_AN_HOUR(),
      })
      return { ws, author, recipient, root, message, saved }
    }

    function resolveReminder(ws: string, userId: string, savedId: string, reminderGeneration: number) {
      return savedService.resolveFiredReminder({ workspaceId: ws, userId, savedId, reminderGeneration })
    }

    test("should stay valid for the fired generation and re-read edited content", async () => {
      const { ws, author, recipient, root, message, saved } = await savedMessage()
      const generation = await fire(saved.id)
      await eventService.editMessageInternal({
        workspaceId: ws,
        messageId: message.id,
        streamId: root.id,
        actorId: author.id,
        ...testMessageContent("remember this, edited"),
      })

      expect(await resolveReminder(ws, recipient.id, saved.id, generation)).toEqual({
        savedId: saved.id,
        messageId: message.id,
        streamId: root.id,
        conversationId: null,
        title: null,
        streamName: null,
        contentMarkdown: "remember this, edited",
        unavailableReason: null,
        e2eRooted: false,
      })
      expect(await resolveReminder(ws, recipient.id, saved.id, generation - 1)).toBeNull()
      expect(await resolveReminder(ws, author.id, saved.id, generation)).toBeNull()
      expect(await resolveReminder(workspaceId(), recipient.id, saved.id, generation)).toBeNull()
    })

    test("should mark an old plaintext reminder end-to-end rooted once its root, or its thread's root, is sealed", async () => {
      const { ws, author, recipient, root, message, saved } = await savedMessage()
      const child = await thread(ws, root, author.id)
      const threadMessage = await post(ws, child.id, author.id, "remember this thread reply")
      const threadSaved = await savedService.save({
        workspaceId: ws,
        userId: recipient.id,
        messageId: threadMessage.id,
        remindAt: IN_AN_HOUR(),
      })
      const generation = await fire(saved.id)
      const threadGeneration = await fire(threadSaved.id)
      await E2eStreamsRepository.markStreamE2e(pool, {
        streamId: root.id,
        workspaceId: ws,
        ownerUserId: author.id,
        ownerUserKeyId: "e2ek_owner",
      })

      const resolved = await Promise.all([
        resolveReminder(ws, recipient.id, saved.id, generation),
        resolveReminder(ws, recipient.id, threadSaved.id, threadGeneration),
      ])
      expect(
        resolved.map((r) => ({ streamId: r?.streamId, messageId: r?.messageId, e2eRooted: r?.e2eRooted }))
      ).toEqual([
        { streamId: root.id, messageId: message.id, e2eRooted: true },
        { streamId: child.id, messageId: threadMessage.id, e2eRooted: true },
      ])
    })

    test("should invalidate the fired generation on reschedule, cancel, re-save, status round trip and delete", async () => {
      const outcomes: Record<string, unknown> = {}
      const cases: Record<string, (ctx: Awaited<ReturnType<typeof savedMessage>>) => Promise<unknown>> = {
        reschedule: ({ ws, recipient, saved }) =>
          savedService.updateReminder({
            workspaceId: ws,
            userId: recipient.id,
            savedId: saved.id,
            remindAt: IN_AN_HOUR(),
          }),
        cancel: ({ ws, recipient, saved }) =>
          savedService.updateReminder({ workspaceId: ws, userId: recipient.id, savedId: saved.id, remindAt: null }),
        resave: ({ ws, recipient, message }) =>
          savedService.save({ workspaceId: ws, userId: recipient.id, messageId: message.id, remindAt: null }),
        statusRoundTrip: async ({ ws, recipient, saved }) => {
          await savedService.updateStatus({ workspaceId: ws, userId: recipient.id, savedId: saved.id, status: "done" })
          await savedService.updateStatus({
            workspaceId: ws,
            userId: recipient.id,
            savedId: saved.id,
            status: SavedStatuses.SAVED,
          })
        },
        remove: ({ ws, recipient, saved }) =>
          savedService.delete({ workspaceId: ws, userId: recipient.id, savedId: saved.id }),
      }
      for (const [name, mutate] of Object.entries(cases)) {
        const ctx = await savedMessage()
        const generation = await fire(ctx.saved.id)
        await mutate(ctx)
        outcomes[name] = await resolveReminder(ctx.ws, ctx.recipient.id, ctx.saved.id, generation)
      }

      expect(outcomes).toEqual({ reschedule: null, cancel: null, resave: null, statusRoundTrip: null, remove: null })
    })

    test("should pin a new generation when a rescheduled reminder fires again", async () => {
      const { ws, recipient, saved } = await savedMessage()
      const first = await fire(saved.id)
      await savedService.updateReminder({
        workspaceId: ws,
        userId: recipient.id,
        savedId: saved.id,
        remindAt: IN_AN_HOUR(),
      })
      const second = await fire(saved.id)

      expect(second).toBeGreaterThan(first)
      expect(await resolveReminder(ws, recipient.id, saved.id, first)).toBeNull()
      expect(await resolveReminder(ws, recipient.id, saved.id, second)).toMatchObject({ savedId: saved.id })
    })

    test("should keep the generation across a no-op re-save", async () => {
      const { ws, recipient, message, saved } = await savedMessage()
      await savedService.updateReminder({ workspaceId: ws, userId: recipient.id, savedId: saved.id, remindAt: null })
      const before = await pool.query("SELECT reminder_generation FROM saved_messages WHERE id = $1", [saved.id])
      await savedService.save({ workspaceId: ws, userId: recipient.id, messageId: message.id, remindAt: null })
      const after = await pool.query("SELECT reminder_generation FROM saved_messages WHERE id = $1", [saved.id])

      expect(after.rows[0].reminder_generation).toBe(before.rows[0].reminder_generation)
    })

    test("should report a deleted message or lost access without content and stay valid", async () => {
      const deleted = await savedMessage()
      const deletedGen = await fire(deleted.saved.id)
      await eventService.deleteMessageInternal({
        workspaceId: deleted.ws,
        messageId: deleted.message.id,
        streamId: deleted.root.id,
        actorId: deleted.author.id,
      })

      const { ws, author, recipient } = await workspaceWithUsers()
      const priv = await channel(ws, author.id, Visibilities.PRIVATE)
      await StreamMemberRepository.insertMany(pool, ws, priv.id, [author.id, recipient.id])
      const message = await post(ws, priv.id, author.id, "private note")
      const saved = await savedService.save({
        workspaceId: ws,
        userId: recipient.id,
        messageId: message.id,
        remindAt: IN_AN_HOUR(),
      })
      const lostGen = await fire(saved.id)
      await StreamMemberRepository.delete(pool, priv.id, recipient.id)

      const results = [
        await resolveReminder(deleted.ws, deleted.recipient.id, deleted.saved.id, deletedGen),
        await resolveReminder(ws, recipient.id, saved.id, lostGen),
      ]
      expect(results).toEqual([
        {
          savedId: deleted.saved.id,
          messageId: deleted.message.id,
          streamId: deleted.root.id,
          conversationId: null,
          title: null,
          streamName: null,
          contentMarkdown: null,
          unavailableReason: "deleted",
          e2eRooted: false,
        },
        {
          savedId: saved.id,
          messageId: message.id,
          streamId: priv.id,
          conversationId: null,
          title: null,
          streamName: null,
          contentMarkdown: null,
          unavailableReason: "access_lost",
          e2eRooted: false,
        },
      ])
    })

    test("should resolve a standalone reminder with its current title after a title edit", async () => {
      const { ws, recipient } = await workspaceWithUsers()
      const saved = await savedService.createStandalone({
        workspaceId: ws,
        userId: recipient.id,
        title: "Call the bank",
        note: null,
        remindAt: IN_AN_HOUR(),
      })
      const generation = await fire(saved.id)
      await savedService.updateContent({
        workspaceId: ws,
        userId: recipient.id,
        savedId: saved.id,
        title: "Call the bank today",
      })

      expect(await resolveReminder(ws, recipient.id, saved.id, generation)).toEqual({
        savedId: saved.id,
        messageId: null,
        streamId: null,
        conversationId: null,
        title: "Call the bank today",
        streamName: null,
        contentMarkdown: null,
        unavailableReason: null,
        e2eRooted: false,
      })
    })

    test("should bump the generation for old-build writes to lifecycle columns but not for title edits", async () => {
      const { saved } = await savedMessage()
      const read = async () =>
        (await pool.query("SELECT reminder_generation FROM saved_messages WHERE id = $1", [saved.id])).rows[0]
          .reminder_generation as number
      const start = await read()
      await pool.query("UPDATE saved_messages SET title = 'renamed', note = 'n', updated_at = NOW() WHERE id = $1", [
        saved.id,
      ])
      const afterTitle = await read()
      await pool.query("UPDATE saved_messages SET status = 'done', updated_at = NOW() WHERE id = $1", [saved.id])
      const afterStatus = await read()
      await pool.query("UPDATE saved_messages SET reminder_sent_at = NOW() WHERE id = $1", [saved.id])
      const afterSent = await read()
      await pool.query("UPDATE saved_messages SET reminder_generation = 0 WHERE id = $1", [saved.id])
      const afterForge = await read()

      expect([afterTitle, afterStatus, afterSent, afterForge].map((g) => g - start)).toEqual([0, 1, 2, 2])
    })
  })
})
