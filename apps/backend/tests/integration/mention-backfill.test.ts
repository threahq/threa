/**
 * Workspace scope (INV-8) of the mention-actor-refs backfill, against a real schema.
 *
 * Most decoys are workspace-B rows carrying the same bare `@slug` as workspace A's rows: a
 * pass that drops its `workspace_id` pin would rewrite them with A's user id.
 * One `message_versions` decoy is an A version filed under a B message; only the
 * `m.workspace_id = v.workspace_id` join pin keeps it out.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import type { JSONContent } from "@threahq/types"
import { setupTestDatabase, withTransaction } from "./setup"
import { UserRepository } from "../../src/features/workspaces"
import { getBackfill } from "../../src/lib/backfill"
import { MENTION_BACKFILL_NAME, registerMentionBackfill } from "../../src/features/mentions"
import {
  draftId,
  messageId,
  messageVersionId,
  scheduledMessageId,
  streamId,
  userId,
  workspaceId,
} from "../../src/lib/id"

type Table = "messages" | "message_versions" | "scheduled_messages" | "drafts"

describe("mention backfill workspace scope (INV-8)", () => {
  let pool: Pool
  const wsA = workspaceId()
  const wsB = workspaceId()
  const stream = streamId()
  const author = userId()
  let mentioned: { id: string; slug: string }
  let nextSequence = 1

  const doc = (mentionId: string): JSONContent => ({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "mention", attrs: { id: mentionId, slug: mentioned.slug, mentionType: "user" } }],
      },
    ],
  })
  const bare = () => doc(mentioned.slug)
  const resolved = () => doc(mentioned.id)

  const ids: Record<Table, { a: string; decoys: string[] }> = {
    messages: { a: messageId(), decoys: [messageId()] },
    message_versions: { a: messageVersionId(), decoys: [messageVersionId(), messageVersionId()] },
    scheduled_messages: { a: scheduledMessageId(), decoys: [scheduledMessageId()] },
    drafts: { a: draftId(), decoys: [draftId()] },
  }

  async function addMessage(id: string, ws: string, e2eVersion: number | null = null) {
    await pool.query(
      `INSERT INTO messages (id, workspace_id, stream_id, sequence, author_id, author_type, content_markdown, content_json, e2e_version)
       VALUES ($1, $2, $3, $4, $5, 'user', $6, $7, $8)`,
      [id, ws, stream, nextSequence++, author, `@${mentioned.slug}`, bare(), e2eVersion]
    )
  }

  async function addVersion(id: string, ws: string, parent: string, versionNumber = 1) {
    await pool.query(
      `INSERT INTO message_versions (id, workspace_id, message_id, version_number, content_json, content_markdown, edited_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, ws, parent, versionNumber, bare(), `@${mentioned.slug}`, author]
    )
  }

  async function addScheduled(id: string, ws: string) {
    await pool.query(
      `INSERT INTO scheduled_messages (id, workspace_id, user_id, stream_id, content_json, content_markdown, scheduled_for)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '1 day')`,
      [id, ws, author, stream, bare(), `@${mentioned.slug}`]
    )
  }

  async function addDraft(id: string, ws: string) {
    await pool.query(
      `INSERT INTO drafts (id, workspace_id, user_id, scope, content_json, content_markdown, client_updated_at)
       VALUES ($1, $2, $3, 'stream', $4, $5, now())`,
      [id, ws, author, bare(), `@${mentioned.slug}`]
    )
  }

  async function stored(table: Table, rowIds: string[]) {
    const result = await pool.query<{ id: string; content_json: JSONContent; content_markdown: string }>(
      `SELECT id, content_json, content_markdown FROM ${table} WHERE id = ANY($1) ORDER BY id`,
      [rowIds]
    )
    return result.rows
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    registerMentionBackfill()
    const id = userId()
    mentioned = await withTransaction(pool, (client) =>
      UserRepository.insert(client, {
        id,
        workspaceId: wsA,
        workosUserId: null,
        email: null,
        name: "Mentioned",
        role: "member",
        slug: `mentioned-${id.slice(-8).toLowerCase()}`,
      })
    )

    const [msgA, msgB] = [ids.messages.a, ids.messages.decoys[0]!]
    await addMessage(msgA, wsA)
    await addMessage(msgB, wsB)
    await addVersion(ids.message_versions.a, wsA, msgA)
    await addVersion(ids.message_versions.decoys[0]!, wsB, msgB)
    await addVersion(ids.message_versions.decoys[1]!, wsA, msgB, 2)
    const sealed = messageId()
    await addMessage(sealed, wsA, 1)
    await addVersion(messageVersionId(), wsA, sealed)
    await addScheduled(ids.scheduled_messages.a, wsA)
    await addScheduled(ids.scheduled_messages.decoys[0]!, wsB)
    await addDraft(ids.drafts.a, wsA)
    await addDraft(ids.drafts.decoys[0]!, wsB)
  })

  afterAll(async () => {
    await pool.end()
  })

  const backfill = () => getBackfill(MENTION_BACKFILL_NAME)!

  test("should plan only A's plaintext rows when B holds rows with the same mention, and a version only when its message is in A", async () => {
    const chunks = await backfill().plan({ pool }, wsA)

    expect(chunks).toEqual([
      { table: "messages", ids: [ids.messages.a] },
      { table: "message_versions", ids: [ids.message_versions.a] },
      { table: "scheduled_messages", ids: [ids.scheduled_messages.a] },
      { table: "drafts", ids: [ids.drafts.a] },
    ])
  })

  for (const table of ["messages", "message_versions", "scheduled_messages", "drafts"] as const) {
    test(`should rewrite A's row and leave B's rows and cross-workspace pointers alone when processing a ${table} chunk`, async () => {
      const { a, decoys } = ids[table]

      const result = await backfill().processChunk({ pool }, wsA, { table, ids: [a, ...decoys] })

      const untouched = (id: string) => ({ id, content_json: bare(), content_markdown: `@${mentioned.slug}` })
      expect({ result, rows: await stored(table, [a, ...decoys]) }).toEqual({
        result: { processed: 1 },
        rows: [
          { id: a, content_json: resolved(), content_markdown: `[@${mentioned.slug}](user:${mentioned.id})` },
          ...decoys.map(untouched),
        ].sort((x, y) => x.id.localeCompare(y.id)),
      })
    })
  }
})
