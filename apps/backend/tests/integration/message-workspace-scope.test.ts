import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { setupTestDatabase, withTransaction } from "./setup"
import { MessageRepository, type Message } from "../../src/features/messaging"
import { WorkspaceRepository } from "../../src/features/workspaces"
import {
  activityId,
  attachmentId,
  linkPreviewId,
  messageId,
  messageVersionId,
  pendingItemId,
  personaId,
  researcherCacheId,
  savedMessageId,
  sessionId,
  sharedMessageId,
  streamId,
  userId,
  workspaceId,
} from "../../src/lib/id"

const EMBEDDING_DIM = 1536

function unitVector(index: number): number[] {
  const vector = new Array(EMBEDDING_DIM).fill(0)
  vector[index] = 1
  return vector
}

function shape(message: Message) {
  return {
    id: message.id,
    streamId: message.streamId,
    replyCount: message.replyCount,
    reactions: message.reactions,
  }
}

function sorted(values: Iterable<string>) {
  return [...values].sort()
}

describe("MessageRepository workspace scope (INV-8)", () => {
  let pool: Pool

  let wsA: string
  let wsB: string
  let author: string
  let bAuthor: string

  let streamA: string
  let streamB: string
  let threadA: string

  let a1: string
  let a2: string
  let a3: string
  let threadReply: string
  let bs1: string
  let bs2: string
  let bs3: string

  async function seedWorkspace(label: string) {
    const id = workspaceId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id,
        name: `Message scope ${label}`,
        slug: `message-scope-${label}-${id}`,
        createdBy: userId(),
      })
    })
    return id
  }

  async function insertRow(table: string, row: Record<string, unknown>) {
    const columns = Object.keys(row)
    await pool.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(row)
    )
  }

  async function addStream(
    wid: string,
    options: { type?: string; parent?: string; anchor?: string; replyCount?: number } = {}
  ) {
    const id = streamId()
    await insertRow("streams", {
      id,
      workspace_id: wid,
      type: options.type ?? "channel",
      slug: options.type === "thread" ? null : `message-scope-${id}`,
      parent_stream_id: options.parent ?? null,
      root_stream_id: options.parent ?? null,
      parent_anchor_id: options.anchor ?? null,
      reply_count: options.replyCount ?? 0,
      created_by: author,
    })
    return id
  }

  async function addMessage(
    wid: string,
    stream: string,
    sequence: number,
    options: {
      clientMessageId?: string
      metadata?: Record<string, string>
      searchConfig?: string
      sourceHash?: string
    } = {}
  ) {
    const id = messageId()
    await insertRow("messages", {
      id,
      workspace_id: wid,
      stream_id: stream,
      sequence,
      author_id: wid === wsB ? bAuthor : author,
      author_type: "user",
      content_markdown: `text ${id}`,
      content_json: {},
      client_message_id: options.clientMessageId ?? null,
      metadata: options.metadata ?? {},
      search_config: options.searchConfig ?? null,
      embedding_source_hash: options.sourceHash ?? null,
    })
    return id
  }

  async function addReaction(wid: string, message: string, user: string, emoji: string) {
    await insertRow("reactions", { workspace_id: wid, message_id: message, user_id: user, emoji })
  }

  async function storedMessage(id: string) {
    const result = await pool.query(
      `SELECT workspace_id, stream_id, sequence::text AS sequence, content_markdown, revision, edited_at, deleted_at,
              embedding_source_hash, search_config, embedding IS NOT NULL AS has_embedding
       FROM messages WHERE id = $1`,
      [id]
    )
    return result.rows[0]
  }

  async function storedReactions(message: string) {
    const result = await pool.query(`SELECT workspace_id, user_id, emoji FROM reactions WHERE message_id = $1`, [
      message,
    ])
    return Object.fromEntries(result.rows.map((row) => [`${row.user_id} ${row.emoji}`, row.workspace_id]))
  }

  interface MoveRow {
    label: string
    table: string
    column: string
    id: string
    side: "a" | "b"
  }

  async function seedMoveFixture() {
    const source = await addStream(wsA)
    const destination = await addStream(wsA)
    const moved = await addMessage(wsA, source, 1)
    const foreign = await addMessage(wsB, source, 2)
    const rows: MoveRow[] = []

    async function addMoveRow(
      side: "a" | "b",
      table: string,
      column: string,
      label: string,
      id: string,
      row: Record<string, unknown>
    ) {
      await insertRow(table, { id, workspace_id: side === "a" ? wsA : wsB, ...row })
      rows.push({ label: `${side}:${label}`, table, column, id, side })
    }

    for (const side of ["a", "b"] as const) {
      const user = side === "a" ? author : bAuthor
      await addMoveRow(side, "attachments", "stream_id", "attachments", attachmentId(), {
        stream_id: source,
        message_id: moved,
        filename: "f.txt",
        mime_type: "text/plain",
        size_bytes: 1,
        storage_path: `message-scope/${side}`,
      })
      await addMoveRow(side, "saved_messages", "stream_id", "saved_messages", savedMessageId(), {
        user_id: user,
        message_id: moved,
        stream_id: source,
      })
      await addMoveRow(side, "user_activity", "stream_id", "user_activity", activityId(), {
        user_id: user,
        activity_type: "mention",
        stream_id: source,
        message_id: moved,
        actor_id: user,
        actor_type: "user",
      })
      await addMoveRow(side, "researcher_cache", "stream_id", "researcher_cache", researcherCacheId(), {
        message_id: side === "a" ? moved : foreign,
        stream_id: source,
        access_spec: {},
        result: {},
        expires_at: new Date(Date.now() + 3_600_000),
      })
      await addMoveRow(side, "memo_pending_items", "stream_id", "memo_pending_items", pendingItemId(), {
        stream_id: source,
        item_type: "message",
        item_id: moved,
      })
      const previewId = linkPreviewId()
      await addMoveRow(side, "link_previews", "target_stream_id", "link_previews", previewId, {
        url: `https://example.test/${previewId}`,
        normalized_url: `https://example.test/${previewId}`,
        target_stream_id: source,
        target_message_id: moved,
      })
      await addMoveRow(side, "shared_messages", "source_stream_id", "shared_messages.source", sharedMessageId(), {
        share_message_id: messageId(),
        source_message_id: moved,
        source_stream_id: source,
        target_stream_id: streamId(),
        flavor: "quote",
        created_by: user,
      })
      await addMoveRow(side, "shared_messages", "target_stream_id", "shared_messages.target", sharedMessageId(), {
        share_message_id: moved,
        source_message_id: messageId(),
        source_stream_id: streamId(),
        target_stream_id: source,
        flavor: "quote",
        created_by: user,
      })
      await addMoveRow(side, "agent_sessions", "stream_id", "agent_sessions.response", sessionId(), {
        stream_id: source,
        persona_id: personaId(),
        trigger_message_id: messageId(),
        status: "completed",
        response_message_id: moved,
      })
      await addMoveRow(side, "agent_sessions", "stream_id", "agent_sessions.sent", sessionId(), {
        stream_id: source,
        persona_id: personaId(),
        trigger_message_id: messageId(),
        status: "completed",
        sent_message_ids: [moved],
      })
    }

    return { source, destination, moved, foreign, rows }
  }

  async function readMoveColumns(rows: MoveRow[]) {
    const out: Array<{ label: string; value: string }> = []
    for (const row of rows) {
      const result = await pool.query(`SELECT ${row.column} AS value FROM ${row.table} WHERE id = $1`, [row.id])
      out.push({ label: row.label, value: result.rows[0].value })
    }
    return out
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()

    wsA = await seedWorkspace("a")
    wsB = await seedWorkspace("b")
    author = userId()
    bAuthor = userId()

    streamA = await addStream(wsA)
    streamB = await addStream(wsB)

    a1 = await addMessage(wsA, streamA, 10, {
      clientMessageId: "cmid-a1",
      metadata: { ref: "ticket-1" },
      sourceHash: "hash-a1",
    })
    a2 = await addMessage(wsA, streamA, 20, { metadata: { ref: "ticket-1" } })
    a3 = await addMessage(wsA, streamA, 30, { metadata: { ref: "ticket-2" } })

    threadA = await addStream(wsA, { type: "thread", parent: streamA, anchor: a2, replyCount: 3 })
    threadReply = await addMessage(wsA, threadA, 5)

    // Decoys, all under A parent ids: B messages in A's streams, a B thread anchored on A's message, and an A
    // message living in a B thread that is anchored on an A message id.
    bs1 = await addMessage(wsB, streamA, 15, {
      clientMessageId: "cmid-b",
      metadata: { ref: "ticket-1" },
      sourceHash: "hash-b",
    })
    bs2 = await addMessage(wsB, streamA, 25)
    bs3 = await addMessage(wsB, streamA, 35)
    await addMessage(wsB, threadA, 6)
    const decoyThread = await addStream(wsB, { type: "thread", parent: streamB, anchor: a2, replyCount: 9 })
    await addMessage(wsA, decoyThread, 7)
    await addStream(wsB, { type: "thread", parent: streamA, anchor: a3, replyCount: 7 })
    await addStream(wsB, { type: "thread", parent: threadA, anchor: threadReply, replyCount: 5 })

    await addReaction(wsA, a1, author, "👍")
    await addReaction(wsB, a1, bAuthor, "👎")
    await addReaction(wsA, threadReply, author, "👍")
    await addReaction(wsB, threadReply, bAuthor, "👎")
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should return the source state only for its own workspace when reading an invocation source for share", async () => {
    const read = async (wid: string, id: string) =>
      (await MessageRepository.findInvocationSourceStateForShare(pool, { workspaceId: wid, messageId: id }))
        ?.messageId ?? null
    expect({
      own: await read(wsA, a1),
      foreignId: await read(wsA, bs1),
      foreignWorkspace: await read(wsB, a1),
    }).toEqual({ own: a1, foreignId: null, foreignWorkspace: null })
  })

  test("should not return another workspace's row when finding by client message id", async () => {
    const own = await MessageRepository.findByClientMessageId(pool, wsA, streamA, "cmid-a1")
    expect({
      own: own && shape(own),
      foreign: await MessageRepository.findByClientMessageId(pool, wsA, streamA, "cmid-b"),
    }).toEqual({
      own: { id: a1, streamId: streamA, replyCount: 0, reactions: { "👍": [author] } },
      foreign: null,
    })
  })

  test("should hydrate only its own reactions when finding by id", async () => {
    const own = await MessageRepository.findById(pool, wsA, a1)
    expect({
      own: own && shape(own),
      foreignId: await MessageRepository.findById(pool, wsA, bs1),
      foreignWorkspace: await MessageRepository.findById(pool, wsB, a1),
    }).toEqual({
      own: { id: a1, streamId: streamA, replyCount: 0, reactions: { "👍": [author] } },
      foreignId: null,
      foreignWorkspace: null,
    })
  })

  test("should not lock another workspace's row when finding by id for update", async () => {
    const own = await MessageRepository.findByIdForUpdate(pool, wsA, a1)
    expect({
      own: own?.id,
      foreignId: await MessageRepository.findByIdForUpdate(pool, wsA, bs1),
      foreignWorkspace: await MessageRepository.findByIdForUpdate(pool, wsB, a1),
    }).toEqual({ own: a1, foreignId: null, foreignWorkspace: null })
  })

  test("should return only its own messages and reactions when finding by ids", async () => {
    const found = await MessageRepository.findByIds(pool, wsA, [a1, a3, bs1])
    expect(Object.fromEntries([...found].map(([id, message]) => [id, shape(message)]))).toEqual({
      [a1]: { id: a1, streamId: streamA, replyCount: 0, reactions: { "👍": [author] } },
      [a3]: { id: a3, streamId: streamA, replyCount: 0, reactions: {} },
    })
  })

  test("should return only its own stream ids when resolving streams by message ids", async () => {
    expect(await MessageRepository.findStreamIdsByIds(pool, wsA, [a1, bs1])).toEqual(new Map([[a1, streamA]]))
  })

  test("should lock only its own messages and reactions when finding by ids for update", async () => {
    const found = await MessageRepository.findByIdsForUpdate(pool, wsA, [a1, bs1])
    expect(found.map(shape)).toEqual([{ id: a1, streamId: streamA, replyCount: 0, reactions: { "👍": [author] } }])
  })

  test("should exclude another workspace's rows in an accessible stream when finding by ids in streams", async () => {
    const found = await MessageRepository.findByIdsInStreams(pool, wsA, [a1, bs1], [streamA])
    expect(Object.fromEntries([...found].map(([id, message]) => [id, shape(message)]))).toEqual({
      [a1]: { id: a1, streamId: streamA, replyCount: 0, reactions: { "👍": [author] } },
    })
  })

  test("should resolve only its own thread root when finding a thread root by parent anchor", async () => {
    expect({
      own: (await MessageRepository.findThreadRoot(pool, wsA, { parentAnchorId: a2 }))?.id,
      foreignId: await MessageRepository.findThreadRoot(pool, wsA, { parentAnchorId: bs1 }),
      foreignWorkspace: await MessageRepository.findThreadRoot(pool, wsB, { parentAnchorId: a2 }),
    }).toEqual({ own: a2, foreignId: null, foreignWorkspace: null })
  })

  test("should list only its own messages and reactions in every pagination branch when listing a stream", async () => {
    expect({
      latest: (await MessageRepository.list(pool, wsA, streamA)).map(shape),
      after: (await MessageRepository.list(pool, wsA, streamA, { afterSequence: 5n })).map((m) => m.id),
      before: (await MessageRepository.list(pool, wsA, streamA, { beforeSequence: 100n })).map((m) => m.id),
      other: (await MessageRepository.list(pool, wsB, streamA)).map((m) => m.id),
    }).toEqual({
      latest: [
        { id: a1, streamId: streamA, replyCount: 0, reactions: { "👍": [author] } },
        { id: a2, streamId: streamA, replyCount: 3, reactions: {} },
        { id: a3, streamId: streamA, replyCount: 0, reactions: {} },
      ],
      after: [a1, a2, a3],
      before: [a1, a2, a3],
      other: [bs1, bs2, bs3],
    })
  })

  test("should return only its own messages when finding by metadata", async () => {
    const found = await MessageRepository.findByMetadata(pool, {
      workspaceId: wsA,
      streamIds: [streamA],
      filter: { ref: "ticket-1" },
    })
    expect(Object.fromEntries(found.map((message) => [message.id, shape(message)]))).toEqual({
      [a1]: { id: a1, streamId: streamA, replyCount: 0, reactions: { "👍": [author] } },
      [a2]: { id: a2, streamId: streamA, replyCount: 3, reactions: {} },
    })
  })

  test("should count only its own messages when reading naming stats", async () => {
    const latest = await MessageRepository.findById(pool, wsA, a3)
    expect(await MessageRepository.getNamingStats(pool, wsA, streamA)).toEqual({
      count: 3,
      latestMessageAt: latest!.createdAt,
    })
  })

  test("should count only its own messages per stream when counting by streams", async () => {
    expect({
      a: Object.fromEntries(await MessageRepository.countByStreams(pool, wsA, [streamA, threadA])),
      b: Object.fromEntries(await MessageRepository.countByStreams(pool, wsB, [streamA, threadA])),
    }).toEqual({
      a: { [streamA]: 3, [threadA]: 1 },
      b: { [streamA]: 3, [threadA]: 1 },
    })
  })

  test("should compute the floor from its own messages only when finding the window floor sequence", async () => {
    expect({
      a: await MessageRepository.findWindowFloorSequence(pool, wsA, streamA, 2),
      b: await MessageRepository.findWindowFloorSequence(pool, wsB, streamA, 2),
    }).toEqual({ a: 20n, b: 25n })
  })

  test("should return only its own source hashes when finding embedding source hashes", async () => {
    expect({
      a: await MessageRepository.findEmbeddingSourceHashes(pool, wsA, [a1, bs1]),
      b: await MessageRepository.findEmbeddingSourceHashes(pool, wsB, [a1, bs1]),
    }).toEqual({ a: new Map([[a1, "hash-a1"]]), b: new Map([[bs1, "hash-b"]]) })
  })

  test("should return only its own thread members when another workspace's rows hang off the same anchor", async () => {
    const found = await MessageRepository.findThreadMessages(pool, wsA, [a2, a3])
    expect([...found].map(([anchor, messages]) => ({ anchor, messages: messages.map(shape) }))).toEqual([
      {
        anchor: a2,
        messages: [{ id: threadReply, streamId: threadA, replyCount: 0, reactions: { "👍": [author] } }],
      },
    ])
  })

  test("should window only its own messages when finding surrounding messages", async () => {
    const window = await MessageRepository.findSurrounding(pool, wsA, a2, streamA, 5, 5)
    expect({
      window: window.map(shape),
      foreignTarget: await MessageRepository.findSurrounding(pool, wsA, bs1, streamA, 5, 5),
    }).toEqual({
      window: [
        { id: a1, streamId: streamA, replyCount: 0, reactions: { "👍": [author] } },
        { id: a2, streamId: streamA, replyCount: 3, reactions: {} },
        { id: a3, streamId: streamA, replyCount: 0, reactions: {} },
      ],
      foreignTarget: [],
    })
  })

  test("should return only its own messages when listing a sequence range", async () => {
    const found = await MessageRepository.listBySequenceRange(pool, wsA, streamA, 1n, 100n)
    expect(found.map(shape)).toEqual([
      { id: a1, streamId: streamA, replyCount: 0, reactions: { "👍": [author] } },
      { id: a2, streamId: streamA, replyCount: 3, reactions: {} },
      { id: a3, streamId: streamA, replyCount: 0, reactions: {} },
    ])
  })

  test("should return only its own agent sessions when finding sessions for messages", async () => {
    const fixture = await seedMoveFixture()
    const own = fixture.rows.filter((row) => row.side === "a" && row.table === "agent_sessions").map((row) => row.id)
    expect(
      sorted(
        await MessageRepository.findAgentSessionIdsForMessages(pool, {
          workspaceId: wsA,
          sourceStreamId: fixture.source,
          messageIds: [fixture.moved, fixture.foreign],
        })
      )
    ).toEqual(sorted(own))
  })

  test("should move only its own rows and hydrate only its own reactions when moving to a stream", async () => {
    const source = await addStream(wsA)
    const destination = await addStream(wsA)
    const mine = await addMessage(wsA, source, 1)
    const theirs = await addMessage(wsB, source, 2)
    await addReaction(wsA, mine, author, "👍")
    await addReaction(wsB, mine, bAuthor, "👎")
    await addStream(wsB, { type: "thread", parent: destination, anchor: mine, replyCount: 6 })
    const theirsBefore = await storedMessage(theirs)

    const moved = await MessageRepository.moveToStream(pool, wsA, destination, [
      { messageId: mine, sequence: 100n, broadcastSequence: 1n },
      { messageId: theirs, sequence: 200n, broadcastSequence: 2n },
    ])

    expect({
      moved: moved.map(shape),
      mine: await storedMessage(mine).then((row) => ({ stream: row.stream_id, sequence: row.sequence })),
      theirs: await storedMessage(theirs),
    }).toEqual({
      moved: [{ id: mine, streamId: destination, replyCount: 0, reactions: { "👍": [author] } }],
      mine: { stream: destination, sequence: "100" },
      theirs: theirsBefore,
    })
  })

  test("should re-point only its own rows when updating stream scoped references", async () => {
    const fixture = await seedMoveFixture()

    await MessageRepository.updateStreamScopedReferences(pool, {
      workspaceId: wsA,
      sourceStreamId: fixture.source,
      destinationStreamId: fixture.destination,
      messageIds: [fixture.moved, fixture.foreign],
    })

    const columns = await readMoveColumns(fixture.rows)
    expect(columns).toEqual(
      fixture.rows.map((row) => ({
        label: row.label,
        value: row.side === "a" ? fixture.destination : fixture.source,
      }))
    )
  })

  test("should bump the revision from its own versions only when updating content", async () => {
    const stream = await addStream(wsA)
    const mine = await addMessage(wsA, stream, 1)
    const theirs = await addMessage(wsB, stream, 2)
    await addReaction(wsA, mine, author, "👍")
    await addReaction(wsB, mine, bAuthor, "👎")
    await insertRow("message_versions", {
      id: messageVersionId(),
      workspace_id: wsA,
      message_id: mine,
      version_number: 1,
      content_json: {},
      content_markdown: "v1",
      edited_by: author,
    })
    await insertRow("message_versions", {
      id: messageVersionId(),
      workspace_id: wsB,
      message_id: mine,
      version_number: 99,
      content_json: {},
      content_markdown: "decoy",
      edited_by: bAuthor,
    })
    const theirsBefore = await storedMessage(theirs)

    const updated = await MessageRepository.updateContent(pool, wsA, mine, { type: "doc", content: [] }, "edited")
    const foreign = await MessageRepository.updateContent(pool, wsA, theirs, { type: "doc", content: [] }, "hijacked")

    expect({
      updated: updated && { ...shape(updated), revision: updated.revision, contentMarkdown: updated.contentMarkdown },
      foreign,
      theirs: await storedMessage(theirs),
    }).toEqual({
      updated: {
        id: mine,
        streamId: stream,
        replyCount: 0,
        reactions: { "👍": [author] },
        revision: 2,
        contentMarkdown: "edited",
      },
      foreign: null,
      theirs: theirsBefore,
    })
  })

  test("should soft delete only its own message when deleting", async () => {
    const stream = await addStream(wsA)
    const mine = await addMessage(wsA, stream, 1)
    const theirs = await addMessage(wsB, stream, 2)
    await addReaction(wsA, mine, author, "👍")
    await addReaction(wsB, mine, bAuthor, "👎")
    const theirsBefore = await storedMessage(theirs)

    const foreign = await MessageRepository.softDelete(pool, wsA, theirs)
    const deleted = await MessageRepository.softDelete(pool, wsA, mine)

    expect({
      foreign,
      theirs: await storedMessage(theirs),
      deleted: deleted && { ...shape(deleted), revision: deleted.revision, deleted: deleted.deletedAt !== null },
    }).toEqual({
      foreign: null,
      theirs: theirsBefore,
      deleted: {
        id: mine,
        streamId: stream,
        replyCount: 0,
        reactions: { "👍": [author] },
        revision: 2,
        deleted: true,
      },
    })
  })

  test("should stamp its own workspace and hydrate only its own reactions when adding a reaction", async () => {
    const stream = await addStream(wsA)
    const mine = await addMessage(wsA, stream, 1)
    await addReaction(wsB, mine, bAuthor, "👎")

    const added = await MessageRepository.addReaction(pool, wsA, mine, "🎉", author)

    expect({ added: added && shape(added), stored: await storedReactions(mine) }).toEqual({
      added: { id: mine, streamId: stream, replyCount: 0, reactions: { "🎉": [author] } },
      stored: { [`${author} 🎉`]: wsA, [`${bAuthor} 👎`]: wsB },
    })
  })

  test("should remove only its own reactions when removing a reaction", async () => {
    const stream = await addStream(wsA)
    const mine = await addMessage(wsA, stream, 1)
    await addReaction(wsA, mine, author, "👍")
    await addReaction(wsB, mine, bAuthor, "👎")

    await MessageRepository.removeReaction(pool, wsA, mine, "👎", bAuthor)
    const afterForeign = await storedReactions(mine)
    const removed = await MessageRepository.removeReaction(pool, wsA, mine, "👍", author)

    expect({
      afterForeign,
      removed: removed && shape(removed),
      stored: await storedReactions(mine),
    }).toEqual({
      afterForeign: { [`${author} 👍`]: wsA, [`${bAuthor} 👎`]: wsB },
      removed: { id: mine, streamId: stream, replyCount: 0, reactions: {} },
      stored: { [`${bAuthor} 👎`]: wsB },
    })
  })

  test("should write embeddings only to its own rows when updating embeddings", async () => {
    const stream = await addStream(wsA)
    const mine = await addMessage(wsA, stream, 1)
    const theirs = await addMessage(wsB, stream, 2)
    const theirsBefore = await storedMessage(theirs)

    const written = await MessageRepository.updateEmbeddings(pool, wsA, [
      { id: mine, embedding: unitVector(0), sourceHash: "new", expectedSourceHash: null },
      { id: theirs, embedding: unitVector(1), sourceHash: "new", expectedSourceHash: null },
    ])

    expect({
      written,
      mine: await storedMessage(mine).then((row) => ({ hash: row.embedding_source_hash, embedded: row.has_embedding })),
      theirs: await storedMessage(theirs),
    }).toEqual({
      written: 1,
      mine: { hash: "new", embedded: true },
      theirs: theirsBefore,
    })
  })

  test("should fill search configs only on its own rows when filling missing search configs", async () => {
    const stream = await addStream(wsA)
    const mine = await addMessage(wsA, stream, 1)
    const theirs = await addMessage(wsB, stream, 2)
    const theirsBefore = await storedMessage(theirs)

    const filled = await MessageRepository.fillMissingSearchConfigs(pool, wsA, [
      { id: mine, searchConfig: "english" },
      { id: theirs, searchConfig: "swedish" },
    ])

    expect({
      filled,
      mine: await storedMessage(mine).then((row) => row.search_config),
      theirs: await storedMessage(theirs),
    }).toEqual({ filled: 1, mine: "english", theirs: theirsBefore })
  })
})
