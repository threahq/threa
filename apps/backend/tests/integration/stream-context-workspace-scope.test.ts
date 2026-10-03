/**
 * Workspace scope (INV-8) of the stream-context backfill and read model.
 *
 * Each decoy is a workspace-B row aimed at workspace-A data: B messages, memos,
 * delegations and events filed under A stream ids, B rows pointing at A ids, and
 * A rows pointing at B ids. A statement that drops its `workspace_id` pin
 * resolves one of them.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import { setupTestDatabase, testMessageContent } from "./setup"
import { plan, processChunk, type StreamContextChunk } from "../../src/features/stream-context/backfill"
import { StreamContextReadRepository } from "../../src/features/stream-context/read-repository"
import { StreamContextRepository } from "../../src/features/stream-context/repository"
import type { NewStreamContextItem } from "../../src/features/stream-context"
import { normalizeUrl } from "../../src/features/link-previews"
import {
  agentFollowUpId,
  attachmentId,
  attachmentReferenceId,
  delegationId,
  eventId,
  linkPreviewId,
  memoId,
  messageId,
  personaId,
  sessionId,
  streamContextItemId,
  streamId,
  userId,
  workspaceId,
} from "../../src/lib/id"

const T1 = new Date("2026-01-01T00:00:00.000Z")
const T2 = new Date("2026-01-02T00:00:00.000Z")
const T3 = new Date("2026-02-01T00:00:00.000Z")

describe("stream-context workspace scope (INV-8)", () => {
  let pool: Pool
  let ctx: { pool: Pool }

  const wsA = workspaceId()
  const wsB = workspaceId()
  const authorA = userId()
  const authorB = userId()
  let nextSequence = 1

  const authorOf = (ws: string) => (ws === wsA ? authorA : authorB)

  async function addStream(ws: string, params: { parent?: string; anchor?: string } = {}) {
    const id = streamId()
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, created_by, parent_stream_id, root_stream_id, parent_anchor_id)
       VALUES ($1, $2, $3, 'public', $4, $5, $6, $7)`,
      [
        id,
        ws,
        params.parent ? "thread" : "channel",
        authorOf(ws),
        params.parent ?? null,
        params.parent ?? null,
        params.anchor ?? null,
      ]
    )
    return id
  }

  async function addMessage(ws: string, stream: string, markdown: string, createdAt: Date) {
    const id = messageId()
    const content = testMessageContent(markdown)
    await pool.query(
      `INSERT INTO messages (id, workspace_id, stream_id, sequence, author_id, author_type, content_markdown, content_json, created_at)
       VALUES ($1, $2, $3, $4, $5, 'user', $6, $7, $8)`,
      [id, ws, stream, nextSequence++, authorOf(ws), content.contentMarkdown, content.contentJson, createdAt]
    )
    return id
  }

  async function addMemo(ws: string, title: string, sources: string[]) {
    const id = memoId()
    await pool.query(
      `INSERT INTO memos (id, workspace_id, memo_type, source_message_id, title, abstract, source_message_ids, participant_ids, knowledge_type)
       VALUES ($1, $2, 'message', $3, $4, $4, $5, $6, 'decision')`,
      [id, ws, sources[0], title, sources, [authorOf(ws)]]
    )
    return id
  }

  async function addDelegation(ws: string, stream: string, title: string) {
    const id = delegationId()
    await pool.query(
      `INSERT INTO delegated_tasks (id, workspace_id, stream_id, created_by_kind, created_by_id, title, brief, created_at)
       VALUES ($1, $2, $3, 'user', $4, $5, 'brief', $6)`,
      [id, ws, stream, authorOf(ws), title, T1]
    )
    return id
  }

  async function addFollowUp(ws: string, stream: string, note: string) {
    const id = agentFollowUpId()
    await pool.query(
      `INSERT INTO agent_follow_ups (id, workspace_id, stream_id, persona_id, session_id, note, scheduled_for, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [id, ws, stream, personaId(), sessionId(), note, T1]
    )
    return id
  }

  async function addAttachment(ws: string, messageIdOrNull: string | null, mimeType: string) {
    const id = attachmentId()
    await pool.query(
      `INSERT INTO attachments (id, workspace_id, message_id, filename, mime_type, size_bytes, storage_path)
       VALUES ($1, $2, $3, $4, $5, 10, $6)`,
      [id, ws, messageIdOrNull, `${id}.bin`, mimeType, `path/${id}`]
    )
    return id
  }

  async function addReference(ws: string, attachment: string, message: string, stream: string) {
    await pool.query(
      `INSERT INTO attachment_references (id, workspace_id, attachment_id, message_id, stream_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [attachmentReferenceId(), ws, attachment, message, stream]
    )
  }

  async function addEvent(
    ws: string,
    stream: string,
    eventType: string,
    payload: Record<string, unknown>,
    createdAt: Date = T1
  ) {
    const id = eventId()
    await pool.query(
      `INSERT INTO stream_events (id, workspace_id, stream_id, sequence, event_type, payload, actor_id, actor_type, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'user', $8)`,
      [id, ws, stream, nextSequence++, eventType, payload, authorOf(ws), createdAt]
    )
    return id
  }

  async function addLinkPreview(ws: string, url: string, title: string) {
    await pool.query(
      `INSERT INTO link_previews (id, workspace_id, url, normalized_url, title, status)
       VALUES ($1, $2, $3, $4, $5, 'completed')`,
      [linkPreviewId(), ws, url, normalizeUrl(url), title]
    )
  }

  async function contextRows(ws: string) {
    const result = await pool.query<{
      stream_id: string
      category: string
      ref_id: string
      source_message_id: string | null
      author_id: string | null
      occurred_at: Date
      detail: Record<string, unknown>
    }>(
      `SELECT stream_id, category, ref_id, source_message_id, author_id, occurred_at, detail
       FROM stream_context_items WHERE workspace_id = $1
       ORDER BY category, ref_id`,
      [ws]
    )
    return result.rows.map((row) => ({ ...row, occurred_at: row.occurred_at.toISOString() }))
  }

  const channel = (id: string, messages: string[] = []): StreamContextChunk => ({
    kind: "messages",
    streamId: id,
    rootStreamId: id,
    ids: [...messages].sort(),
  })
  const sortedChunks = (chunks: StreamContextChunk[]) =>
    [...chunks].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const readItem = (
    ws: string,
    ref: Pick<NewStreamContextItem, "category" | "refKind" | "refId" | "groupKey">,
    detail: Record<string, unknown> = {}
  ): NewStreamContextItem => ({
    id: streamContextItemId(),
    workspaceId: ws,
    streamId: chRead,
    rootStreamId: chRead,
    sourceMessageId: null,
    authorId: authorA,
    occurredAt: T1,
    sequence: null,
    snippet: "",
    detail,
    ...ref,
  })
  const readFeed = () =>
    StreamContextReadRepository.listFeed(pool, {
      workspaceId: wsA,
      rootStreamId: chRead,
      streamId: chRead,
      scope: "stream",
      limit: 10,
    })

  let chMain: string
  let m1: string
  let m2: string
  let bMsg: string
  let att1: string
  let attPdf: string
  let attB: string
  let urlM1: string

  let chSealedByB: string
  let mSealedByB: string

  let chMemo: string
  let mMemo: string
  let memoA: string

  let chNone: string
  let mNone: string
  let bNoneMemo: string
  let bNoneDelegation: string
  let bNoneFollowUp: string
  let bNoneThread: string
  let chNoneMemo: string
  let chHome: string
  let mHome: string
  let bStream: string

  let chArt: string
  let delegationA: string
  let followUpA: string

  let chThreads: string
  let mAnchor: string
  let mAnchorUnthreaded: string
  let threadOnMessage: string
  let threadOnEvent: string
  let anchorEvent: string

  let chRead: string
  let readDelegation: string
  let readFollowUp: string
  let readDelegationEvent: string
  let readFollowUpEvent: string
  const readUrl = "https://example.com/read-scope-preview"

  beforeAll(async () => {
    pool = await setupTestDatabase()
    ctx = { pool }

    chMain = await addStream(wsA)
    urlM1 = `https://example.com/${chMain}/a`
    m1 = await addMessage(wsA, chMain, `see ${urlM1}`, T1)
    m2 = await addMessage(wsA, chMain, "contract attached", T2)
    bMsg = await addMessage(wsB, chMain, `see https://example.com/${chMain}/b`, T3)
    att1 = await addAttachment(wsA, m1, "image/png")
    attPdf = await addAttachment(wsA, null, "application/pdf")
    await addReference(wsA, attPdf, m2, chMain)
    attB = await addAttachment(wsB, m1, "image/gif")
    await addReference(wsA, attB, m1, chMain)
    const attLoose = await addAttachment(wsA, null, "text/plain")
    await addReference(wsB, attLoose, m2, chMain)

    chSealedByB = await addStream(wsA)
    mSealedByB = await addMessage(wsA, chSealedByB, "B seals this id", T1)
    await pool.query(
      `INSERT INTO e2e_streams (stream_id, workspace_id, owner_user_id, owner_user_key_id) VALUES ($1, $2, $3, $4)`,
      [chSealedByB, wsB, authorB, "key_scope_decoy"]
    )

    chMemo = await addStream(wsA)
    mMemo = await addMessage(wsA, chMemo, "decided in A", T1)
    const bLater = await addMessage(wsB, chMemo, "later, in B", T3)
    memoA = await addMemo(wsA, "A decision", [mMemo, bLater])
    await addMemo(wsB, "B decision", [mMemo])

    chNone = await addStream(wsA)
    mNone = await addMessage(wsA, chNone, "nothing is indexed here", T1)
    bNoneMemo = await addMemo(wsB, "B memo on an A message", [mNone])
    bNoneDelegation = await addDelegation(wsB, chNone, "B task under an A stream")
    bNoneFollowUp = await addFollowUp(wsB, chNone, "B note under an A stream")
    bNoneThread = await addStream(wsB, { parent: chNone, anchor: mNone })
    await pool.query(`UPDATE streams SET display_name = $2 WHERE id = $1`, [bNoneThread, "B thread under an A stream"])

    chNoneMemo = await addStream(wsA)
    const bUnderNoneMemo = await addMessage(wsB, chNoneMemo, "B message under an A stream", T1)
    chHome = await addStream(wsA)
    mHome = await addMessage(wsA, chHome, "A message that homes the memo", T1)
    await addMemo(wsA, "A memo sourced from a B message and an A message", [bUnderNoneMemo, mHome])

    chArt = await addStream(wsA)
    delegationA = await addDelegation(wsA, chArt, "A task")
    await addDelegation(wsB, chArt, "B task")
    followUpA = await addFollowUp(wsA, chArt, "A note")
    await addFollowUp(wsB, chArt, "B note")

    chThreads = await addStream(wsA)
    mAnchor = await addMessage(wsA, chThreads, "thread anchor", T1)
    mAnchorUnthreaded = await addMessage(wsA, chThreads, "no thread of A's on this one", T2)
    const bAnchor = await addMessage(wsB, chThreads, "B anchor", T2)
    anchorEvent = await addEvent(wsA, chThreads, "delegation:created", {}, T2)
    const bEvent = await addEvent(wsB, chThreads, "delegation:created", {}, T3)
    threadOnMessage = await addStream(wsA, { parent: chThreads, anchor: mAnchor })
    threadOnEvent = await addStream(wsA, { parent: chThreads, anchor: anchorEvent })
    await addStream(wsA, { parent: chThreads, anchor: bAnchor })
    await addStream(wsA, { parent: chThreads, anchor: bEvent })
    await addStream(wsB, { parent: chThreads, anchor: mAnchorUnthreaded })

    bStream = await addStream(wsB)
    const underBStream = await addMessage(wsA, bStream, "A message under a B stream", T1)
    await addMemo(wsA, "A memo on a message under a B stream", [underBStream])

    chRead = await addStream(wsA)
    readDelegation = await addDelegation(wsA, chRead, "Read task")
    readFollowUp = await addFollowUp(wsA, chRead, "Read note")
    readDelegationEvent = await addEvent(wsA, chRead, "delegation:created", { delegationId: readDelegation })
    await addEvent(wsB, chRead, "delegation:created", { delegationId: readDelegation })
    readFollowUpEvent = await addEvent(wsA, chRead, "agent:follow_up_scheduled", { followUpId: readFollowUp })
    await addEvent(wsB, chRead, "agent:follow_up_scheduled", { followUpId: readFollowUp })
    await addLinkPreview(wsA, readUrl, "A preview")
    await addLinkPreview(wsB, readUrl, "B preview")
  })

  beforeEach(async () => {
    await pool.query(`DELETE FROM stream_context_items WHERE workspace_id = ANY($1)`, [[wsA, wsB]])
  })

  afterEach(() => {
    mock.restore()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should emit only workspace A's chunks when B filed rows under A's stream ids", async () => {
    const chunks = await plan(ctx as never, wsA)

    expect(sortedChunks(chunks)).toEqual(
      sortedChunks([
        channel(chMain, [m1, m2]),
        channel(chSealedByB, [mSealedByB]),
        channel(chMemo, [mMemo]),
        channel(chNone, [mNone]),
        channel(chHome, [mHome]),
        channel(chThreads, [mAnchor, mAnchorUnthreaded]),
        { kind: "memos", streamId: chMemo, rootStreamId: chMemo },
        { kind: "memos", streamId: chHome, rootStreamId: chHome },
        { kind: "delegations", streamId: chArt, rootStreamId: chArt },
        { kind: "follow_ups", streamId: chArt, rootStreamId: chArt },
        { kind: "delegations", streamId: chRead, rootStreamId: chRead },
        { kind: "follow_ups", streamId: chRead, rootStreamId: chRead },
        { kind: "threads", streamId: chThreads, rootStreamId: chThreads },
      ])
    )
  })

  test("should read A's messages and attachments only when processing a messages chunk", async () => {
    const insertMany = spyOn(StreamContextRepository, "insertMany")

    const processed = await processChunk(ctx as never, wsA, channel(chMain, [m1, m2, bMsg]))

    expect({
      processed,
      inserted: insertMany.mock.calls.flatMap(([, rows]) => rows.map((row) => row.sourceMessageId)).sort(),
      rows: await contextRows(wsA),
      leaked: await contextRows(wsB),
    }).toEqual({
      processed: { processed: 3 },
      inserted: [m1, m1, m2].sort(),
      rows: [
        {
          stream_id: chMain,
          category: "file",
          ref_id: attPdf,
          source_message_id: m2,
          author_id: authorA,
          occurred_at: T2.toISOString(),
          detail: {},
        },
        {
          stream_id: chMain,
          category: "link",
          ref_id: urlM1,
          source_message_id: m1,
          author_id: authorA,
          occurred_at: T1.toISOString(),
          detail: { url: urlM1 },
        },
        {
          stream_id: chMain,
          category: "media",
          ref_id: att1,
          source_message_id: m1,
          author_id: authorA,
          occurred_at: T1.toISOString(),
          detail: { mediaKind: "image" },
        },
      ],
      leaked: [],
    })
  })

  test("should drop the edited message's rows and keep the others when a message is edited between the read and the insert", async () => {
    const insertMany = StreamContextRepository.insertMany.bind(StreamContextRepository)
    spyOn(StreamContextRepository, "insertMany").mockImplementation(async (db, rows) => {
      const inserted = await insertMany(db, rows)
      await pool.query("UPDATE messages SET edited_at = now() WHERE id = $1", [m1])
      return inserted
    })

    try {
      const processed = await processChunk(ctx as never, wsA, channel(chMain, [m1, m2, bMsg]))

      expect({ processed, rows: (await contextRows(wsA)).map((row) => row.source_message_id) }).toEqual({
        processed: { processed: 1 },
        rows: [m2],
      })
    } finally {
      await pool.query("UPDATE messages SET edited_at = NULL WHERE id = $1", [m1])
    }
  })

  test("should index A's memo at A's latest source when B holds a memo and a later source message", async () => {
    await processChunk(ctx as never, wsA, { kind: "memos", streamId: chMemo, rootStreamId: chMemo })

    expect(await contextRows(wsA)).toEqual([
      {
        stream_id: chMemo,
        category: "memo",
        ref_id: memoA,
        source_message_id: mMemo,
        author_id: authorA,
        occurred_at: T1.toISOString(),
        detail: { title: "A decision", knowledgeType: "decision" },
      },
    ])
  })

  test("should index no memo when its only source in the stream belongs to workspace B or the stream does", async () => {
    for (const id of [chNone, chNoneMemo, bStream]) {
      await processChunk(ctx as never, wsA, { kind: "memos", streamId: id, rootStreamId: id })
    }

    expect(await contextRows(wsA)).toEqual([])
  })

  test("should read A's rows only when processing delegations and follow-ups chunks", async () => {
    await processChunk(ctx as never, wsA, { kind: "delegations", streamId: chArt, rootStreamId: chArt })
    await processChunk(ctx as never, wsA, { kind: "follow_ups", streamId: chArt, rootStreamId: chArt })

    expect((await contextRows(wsA)).map((row) => ({ category: row.category, ref_id: row.ref_id }))).toEqual([
      { category: "delegation", ref_id: delegationA },
      { category: "follow_up", ref_id: followUpA },
    ])
  })

  test("should resolve anchors inside A only when processing a threads chunk", async () => {
    await processChunk(ctx as never, wsA, { kind: "threads", streamId: chThreads, rootStreamId: chThreads })

    expect(
      (await contextRows(wsA))
        .map((row) => ({ ref_id: row.ref_id, source_message_id: row.source_message_id, detail: row.detail }))
        .sort((a, b) => a.ref_id.localeCompare(b.ref_id))
    ).toEqual(
      [
        { ref_id: threadOnMessage, source_message_id: mAnchor, detail: {} },
        { ref_id: threadOnEvent, source_message_id: null, detail: { anchorEventId: anchorEvent } },
      ].sort((a, b) => a.ref_id.localeCompare(b.ref_id))
    )
  })

  test("should leave the joined detail empty when A's rows point at artifacts of workspace B", async () => {
    const refs: Array<Pick<NewStreamContextItem, "category" | "refKind" | "refId">> = [
      { category: "media", refKind: "attachment", refId: attB },
      { category: "memo", refKind: "memo", refId: bNoneMemo },
      { category: "delegation", refKind: "delegation", refId: bNoneDelegation },
      { category: "follow_up", refKind: "follow_up", refId: bNoneFollowUp },
      { category: "thread", refKind: "thread", refId: bNoneThread },
    ]
    await StreamContextRepository.insertMany(
      pool,
      refs.map((ref) => readItem(wsA, { ...ref, groupKey: ref.refId }))
    )

    const feed = await readFeed()

    expect(
      feed
        .map((row) => ({ category: row.category, anchorEventId: row.anchorEventId, detail: row.detail }))
        .sort((a, b) => a.category.localeCompare(b.category))
    ).toEqual([
      {
        category: "delegation",
        anchorEventId: null,
        detail: { title: null, status: null, claimedByLabel: null, statusNote: null, resultMessageId: null },
      },
      { category: "follow_up", anchorEventId: null, detail: { note: "", status: "pending", scheduledFor: null } },
      {
        category: "media",
        anchorEventId: null,
        detail: {
          attachmentId: null,
          filename: null,
          mimeType: null,
          sizeBytes: null,
          width: null,
          height: null,
          mediaKind: null,
          giphyUrl: null,
          giphyTitle: null,
        },
      },
      { category: "memo", anchorEventId: null, detail: { title: null, knowledgeType: null } },
      {
        category: "thread",
        anchorEventId: null,
        detail: { name: null, replyCount: 0, lastReplyAt: null, anchorEventId: null },
      },
    ])
  })

  test("should join A's delegation event, follow-up event and link preview when B holds look-alikes", async () => {
    const refs: Array<Pick<NewStreamContextItem, "category" | "refKind" | "refId" | "groupKey">> = [
      { category: "delegation", refKind: "delegation", refId: readDelegation, groupKey: readDelegation },
      { category: "follow_up", refKind: "follow_up", refId: readFollowUp, groupKey: readFollowUp },
      { category: "link", refKind: "url", refId: readUrl, groupKey: normalizeUrl(readUrl) },
    ]
    const decoyRef = delegationId()
    await StreamContextRepository.insertMany(pool, [
      ...refs.map((ref) => readItem(wsA, ref, { url: readUrl })),
      readItem(wsB, { ...refs[0]!, refId: decoyRef, groupKey: decoyRef }, { url: readUrl }),
    ])

    const feed = await readFeed()

    expect(
      feed
        .map((row) => ({
          category: row.category,
          anchorEventId: row.anchorEventId,
          occurrenceCount: row.occurrenceCount,
          title: "title" in row.detail ? row.detail.title : null,
          note: "note" in row.detail ? row.detail.note : null,
        }))
        .sort((a, b) => a.category.localeCompare(b.category))
    ).toEqual([
      {
        category: "delegation",
        anchorEventId: readDelegationEvent,
        occurrenceCount: 1,
        title: "Read task",
        note: null,
      },
      { category: "follow_up", anchorEventId: readFollowUpEvent, occurrenceCount: 1, title: null, note: "Read note" },
      { category: "link", anchorEventId: null, occurrenceCount: 1, title: "A preview", note: null },
    ])
  })
})
