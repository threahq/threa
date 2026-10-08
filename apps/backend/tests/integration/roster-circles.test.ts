import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { PeoplePurposes, UserRepository } from "../../src/features/workspaces"
import { messageId, streamId, userId, workspaceId } from "../../src/lib/id"
import { setupTestDatabase } from "./setup"

const LABELS = ["stranger", "sharedMate", "threadAuthor", "roomMember", "asker"] as const
type Label = (typeof LABELS)[number]

describe("UserRepository.listByCircle", () => {
  let pool: Pool
  const ws = workspaceId()
  const otherWs = workspaceId()
  const ids = Object.fromEntries(LABELS.map((label) => [label, userId()])) as Record<Label, string>
  const foreign = userId()
  const room = streamId()
  const roomThread = streamId()
  const elsewhere = streamId()

  async function insertStream(id: string, rootStreamId: string | null, members: Label[]) {
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, parent_stream_id, root_stream_id, created_by)
       VALUES ($1, $2, $3, 'private', $4, $4, $5)`,
      [id, ws, rootStreamId ? "thread" : "channel", rootStreamId, ids.asker]
    )
    for (const member of members) {
      await pool.query(`INSERT INTO stream_members (workspace_id, stream_id, member_id) VALUES ($1, $2, $3)`, [
        ws,
        id,
        ids[member],
      ])
    }
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    // Joined oldest-first in LABELS order, so the stranger would lead a roster ordered by join date alone.
    for (const [index, label] of LABELS.entries()) {
      await pool.query(
        `INSERT INTO users (id, workspace_id, workos_user_id, email, role, slug, name, joined_at)
         VALUES ($1, $2, NULL, NULL, 'member', $3, $3, $4)`,
        [ids[label], ws, `${label}-${ids[label]}`, new Date(Date.UTC(2026, 0, 1 + index))]
      )
    }
    await pool.query(
      `INSERT INTO users (id, workspace_id, workos_user_id, email, role, slug, name) VALUES ($1, $2, NULL, NULL, 'member', 'foreign', 'foreign')`,
      [foreign, otherWs]
    )
    await insertStream(room, null, ["asker", "roomMember"])
    await insertStream(roomThread, room, [])
    await insertStream(elsewhere, null, ["asker", "sharedMate"])
    await pool.query(
      `INSERT INTO messages (id, workspace_id, stream_id, sequence, author_id, author_type, content_markdown, content_json)
       VALUES ($1, $2, $3, 1, $4, 'user', 'hello', '{}')`,
      [messageId(), ws, roomThread, ids.threadAuthor]
    )
  })

  afterAll(async () => {
    await pool.end()
  })

  const list = (limit: number) =>
    UserRepository.listByCircle(pool, ws, {
      askerId: ids.asker,
      roomStreamIds: [room, roomThread],
      scope: { viewer: { kind: "room", roomStreamId: room }, purpose: PeoplePurposes.VISIBLE },
      limit,
    })

  test("should rank the asker and the room's people first, then the asker's other streams, then everyone else", async () => {
    const roster = await list(10)

    expect(roster.map(({ id, circle }) => ({ id, circle }))).toEqual([
      { id: ids.asker, circle: 1 },
      { id: ids.threadAuthor, circle: 1 },
      { id: ids.roomMember, circle: 1 },
      { id: ids.sharedMate, circle: 2 },
      { id: ids.stranger, circle: 3 },
    ])
  })

  test("should cut the farthest circle first when the limit is below the roster size", async () => {
    const roster = await list(4)

    expect(roster.map(({ id }) => id)).toEqual([ids.asker, ids.threadAuthor, ids.roomMember, ids.sharedMate])
  })

  test("should keep the asker when the limit cuts into the nearest circle", async () => {
    const roster = await list(1)

    expect(roster.map(({ id }) => id)).toEqual([ids.asker])
  })

  test("should leave out everyone a guest in the room cannot see, the asker's other stream-mates included", async () => {
    const guest = userId()
    await pool.query(
      `INSERT INTO users (id, workspace_id, workos_user_id, email, role, slug, name) VALUES ($1, $2, NULL, NULL, 'guest', 'guest', 'guest')`,
      [guest, ws]
    )
    await pool.query(`INSERT INTO stream_members (workspace_id, stream_id, member_id) VALUES ($1, $2, $3)`, [
      ws,
      room,
      guest,
    ])

    const roster = await list(10)

    expect(roster.map(({ id, circle }) => ({ id, circle }))).toEqual([
      { id: ids.asker, circle: 1 },
      { id: ids.threadAuthor, circle: 1 },
      { id: ids.roomMember, circle: 1 },
      { id: guest, circle: 1 },
    ])
  })
})
