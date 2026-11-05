import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import type { NotificationLevel } from "@threahq/types"
import { setupTestDatabase } from "./setup"
import { StreamService, StreamMemberRepository } from "../../src/features/streams"
import { streamId, userId, workspaceId } from "../../src/lib/id"

/**
 * The bootstrap's muted set gates Inbox membership and unread badges, so it must
 * follow the same inheritance as push: a thread with no level of its own is
 * muted when the viewer muted its parent.
 */
describe("StreamService.listMutedStreamIds", () => {
  let pool: Pool
  let streamService: StreamService

  beforeAll(async () => {
    pool = await setupTestDatabase()
    streamService = new StreamService(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  async function seedStream(
    wid: string,
    sid: string,
    type: "channel" | "thread" | "aside",
    createdBy: string,
    parentId: string | null = null,
    archived = false
  ): Promise<void> {
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, created_by, parent_stream_id, root_stream_id, archived_at)
       VALUES ($1, $2, $3, 'public', $4, $5, $5, CASE WHEN $6 THEN NOW() END)`,
      [sid, wid, type, createdBy, parentId, archived]
    )
  }

  async function join(wid: string, sid: string, memberId: string, level: NotificationLevel | null = null) {
    await StreamMemberRepository.insert(pool, wid, sid, memberId)
    if (level) await StreamMemberRepository.update(pool, wid, sid, memberId, { notificationLevel: level })
  }

  test("threads inherit a parent's mute unless they carry a level of their own", async () => {
    const wid = workspaceId()
    const viewer = userId()
    const ids = {
      mutedChannel: streamId(),
      threadInMuted: streamId(),
      nestedInMuted: streamId(),
      ownLevelInMuted: streamId(),
      archivedMutedChannel: streamId(),
      threadInArchived: streamId(),
      everythingChannel: streamId(),
      threadInEverything: streamId(),
      unjoinedChannel: streamId(),
      threadInUnjoined: streamId(),
      aside: streamId(),
    }

    await seedStream(wid, ids.mutedChannel, "channel", viewer)
    await seedStream(wid, ids.threadInMuted, "thread", viewer, ids.mutedChannel)
    await seedStream(wid, ids.nestedInMuted, "thread", viewer, ids.threadInMuted)
    await seedStream(wid, ids.ownLevelInMuted, "thread", viewer, ids.mutedChannel)
    await seedStream(wid, ids.archivedMutedChannel, "channel", viewer, null, true)
    await seedStream(wid, ids.threadInArchived, "thread", viewer, ids.archivedMutedChannel)
    await seedStream(wid, ids.everythingChannel, "channel", viewer)
    await seedStream(wid, ids.threadInEverything, "thread", viewer, ids.everythingChannel)
    await seedStream(wid, ids.unjoinedChannel, "channel", viewer)
    await seedStream(wid, ids.threadInUnjoined, "thread", viewer, ids.unjoinedChannel)
    await seedStream(wid, ids.aside, "aside", viewer, ids.everythingChannel)

    await join(wid, ids.mutedChannel, viewer, "muted")
    await join(wid, ids.threadInMuted, viewer)
    await join(wid, ids.nestedInMuted, viewer)
    await join(wid, ids.ownLevelInMuted, viewer, "activity")
    await join(wid, ids.archivedMutedChannel, viewer, "muted")
    await join(wid, ids.threadInArchived, viewer)
    await join(wid, ids.everythingChannel, viewer, "everything")
    await join(wid, ids.threadInEverything, viewer)
    await join(wid, ids.threadInUnjoined, viewer)
    await join(wid, ids.aside, viewer)

    // Another member's mute on the parent is theirs alone.
    const other = userId()
    await join(wid, ids.everythingChannel, other, "muted")

    const muted = await streamService.listMutedStreamIds(
      wid,
      Object.values(ids).filter((id) => id !== ids.unjoinedChannel),
      viewer
    )

    expect(new Set(muted)).toEqual(
      new Set([
        ids.mutedChannel,
        ids.threadInMuted,
        ids.nestedInMuted,
        ids.archivedMutedChannel,
        ids.threadInArchived,
        ids.aside,
      ])
    )
  })

  test("ignores a mute in another workspace", async () => {
    const viewer = userId()
    const wid = workspaceId()
    const channel = streamId()
    const thread = streamId()
    await seedStream(wid, channel, "channel", viewer)
    await seedStream(wid, thread, "thread", viewer, channel)
    await join(wid, thread, viewer)
    await pool.query(
      `INSERT INTO stream_members (workspace_id, stream_id, member_id, notification_level) VALUES ($1, $2, $3, 'muted')`,
      [workspaceId(), channel, viewer]
    )

    expect(await streamService.listMutedStreamIds(wid, [thread], viewer)).toEqual([])
  })
})
