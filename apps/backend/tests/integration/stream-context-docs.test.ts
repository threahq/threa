/**
 * "In this stream" doc rows against the real schema (INV-68): the row a doc's
 * creation writes on its host, chip rows rebuilt with their message body, the
 * live title join, archive and access filtering on read, and the backfill that
 * rebuilds both kinds from stored state.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import type { JSONContent, ListStreamContextResponse, Stream, StreamContextDocDetail } from "@threahq/types"
import { StreamService } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging/event-service"
import { createStreamContextService } from "../../src/features/stream-context"
import { plan, processChunk } from "../../src/features/stream-context/backfill"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupIsolatedTestDatabase, withTransaction } from "./setup"

let pool: Pool
let cleanup: () => Promise<void>
let streamService: StreamService
let eventService: EventService
let contextService: ReturnType<typeof createStreamContextService>
let wsId: string
let owner: string
let peer: string
let outsider: string

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("stream-context-docs")
  pool = db.pool
  cleanup = db.cleanup
  streamService = new StreamService(pool)
  eventService = new EventService(pool)
  contextService = createStreamContextService({ pool })
  wsId = workspaceId()
  await withTransaction(pool, async (client) => {
    owner = (await addTestMember(client, wsId, userId())).id
    peer = (await addTestMember(client, wsId, userId())).id
    outsider = (await addTestMember(client, wsId, userId())).id
    await WorkspaceRepository.insert(client, {
      id: wsId,
      name: "Stream Context Docs Workspace",
      slug: `stream-context-docs-${wsId.toLowerCase()}`,
      createdBy: owner,
    })
  })
})

afterAll(async () => {
  await cleanup()
})

let slugCounter = 0
function createChannel(visibility: "public" | "private", memberIds: string[] = []): Promise<Stream> {
  return streamService.createChannel({
    workspaceId: wsId,
    slug: `context-docs-${visibility}-${++slugCounter}`,
    visibility,
    createdBy: owner,
    memberIds,
  })
}

function createDoc(hostId: string, displayName?: string): Promise<Stream> {
  return streamService.createDoc({
    workspaceId: wsId,
    parentStreamId: hostId,
    principal: { kind: "user", userId: owner },
    displayName,
  })
}

const chip = (docId: string): JSONContent => ({ type: "docEmbed", attrs: { docId, title: "Plan" } })
const body = (...content: JSONContent[]): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content }],
})
const text = (value: string): JSONContent => ({ type: "text", text: value })

function post(
  streamIdToPost: string,
  contentJson: JSONContent,
  extras: { authorId?: string; confirmedPrivacyWarning?: boolean; consentedShareSourceIds?: ReadonlySet<string> } = {}
) {
  return eventService.createMessage({
    workspaceId: wsId,
    streamId: streamIdToPost,
    authorId: extras.authorId ?? owner,
    authorType: "user",
    contentJson,
    contentMarkdown: "see the doc",
    confirmedPrivacyWarning: extras.confirmedPrivacyWarning,
    consentedShareSourceIds: extras.consentedShareSourceIds,
  })
}

async function docCreatedEventId(hostId: string, docId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM stream_events
     WHERE workspace_id = $1 AND stream_id = $2 AND event_type = 'doc:created' AND payload->>'docId' = $3`,
    [wsId, hostId, docId]
  )
  return result.rows[0]!.id
}

function list(
  viewer: string,
  streamId: string,
  q?: string,
  scope: "tree" | "stream" = "tree"
): Promise<ListStreamContextResponse> {
  return contextService.list({ workspaceId: wsId, userId: viewer, streamId, scope, queryText: q, limit: 40 })
}

function docRows(response: ListStreamContextResponse) {
  return response.items
    .filter((item) => item.category === "doc")
    .map((item) => ({
      refId: item.refId,
      streamId: item.streamId,
      sourceMessageId: item.sourceMessageId,
      anchorEventId: item.anchorEventId,
      occurrenceCount: item.occurrenceCount,
      title: (item.detail as StreamContextDocDetail).title,
    }))
}

describe("stream context doc rows", () => {
  test("should list a doc on its host, anchored on the doc:created event, under its current title", async () => {
    const channel = await createChannel("public")
    const doc = await createDoc(channel.id, "Plan")
    await streamService.updateStream(
      doc.id,
      { displayName: "Launch plan" },
      { workspaceId: wsId, principal: { kind: "user", userId: owner } }
    )

    const response = await list(outsider, channel.id)

    expect({ rows: docRows(response), count: response.counts?.doc }).toEqual({
      rows: [
        {
          refId: doc.id,
          streamId: channel.id,
          sourceMessageId: null,
          anchorEventId: await docCreatedEventId(channel.id, doc.id),
          occurrenceCount: 1,
          title: "Launch plan",
        },
      ],
      count: 1,
    })
  })

  test("should collapse a chip of a hosted doc into one row and keep the hosted row when an edit drops the chip", async () => {
    const channel = await createChannel("public")
    const doc = await createDoc(channel.id, "Roadmap")
    const anchorEventId = await docCreatedEventId(channel.id, doc.id)
    const message = await post(channel.id, body(text("see "), chip(doc.id)))

    const withChip = docRows(await list(owner, channel.id))

    await eventService.editMessageInternal({
      workspaceId: wsId,
      messageId: message.id,
      streamId: channel.id,
      contentJson: body(text("never mind")),
      contentMarkdown: "never mind",
      actorId: owner,
    })
    const afterEdit = docRows(await list(owner, channel.id))

    const hosted = {
      refId: doc.id,
      streamId: channel.id,
      sourceMessageId: null,
      anchorEventId,
      occurrenceCount: 1,
      title: "Roadmap",
    }
    expect({ withChip, afterEdit }).toEqual({
      withChip: [{ ...hosted, sourceMessageId: message.id, anchorEventId: null, occurrenceCount: 2 }],
      afterEdit: [hosted],
    })
  })

  test("should list a private doc's chip to a reader who holds its grant", async () => {
    const host = await createChannel("private")
    const doc = await createDoc(host.id, "Private plan")
    const open = await createChannel("public")
    const message = await post(open.id, body(chip(doc.id)), { confirmedPrivacyWarning: true })
    const grants = await pool.query(
      `SELECT 1 FROM shared_docs WHERE workspace_id = $1 AND share_message_id = $2 AND doc_id = $3`,
      [wsId, message.id, doc.id]
    )

    expect({ granted: grants.rowCount, rows: docRows(await list(outsider, open.id)) }).toEqual({
      granted: 1,
      rows: [
        {
          refId: doc.id,
          streamId: open.id,
          sourceMessageId: message.id,
          anchorEventId: null,
          occurrenceCount: 1,
          title: "Private plan",
        },
      ],
    })
  })

  test("should list a chip in a thread to a channel member who never joined the thread (INV-62)", async () => {
    const channel = await createChannel("private", [peer])
    const doc = await createDoc(channel.id, "Thread plan")
    const anchor = await post(channel.id, body(text("kickoff")))
    const thread = await streamService.createThreadInternal({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchor.id,
      createdBy: owner,
    })
    const message = await post(thread.id, body(chip(doc.id)))
    const threadMembers = await pool.query<{ member_id: string }>(
      `SELECT member_id FROM stream_members WHERE workspace_id = $1 AND stream_id = $2`,
      [wsId, thread.id]
    )

    expect({
      threadMembers: threadMembers.rows.map((row) => row.member_id),
      rows: docRows(await list(peer, thread.id, undefined, "stream")),
    }).toEqual({
      threadMembers: [owner],
      rows: [
        {
          refId: doc.id,
          streamId: thread.id,
          sourceMessageId: message.id,
          anchorEventId: null,
          occurrenceCount: 1,
          title: "Thread plan",
        },
      ],
    })
  })

  test("should drop a chip's occurrence when its message is deleted, keeping the hosted row", async () => {
    const channel = await createChannel("public")
    const doc = await createDoc(channel.id, "Kept")
    const message = await post(channel.id, body(chip(doc.id)))

    await eventService.deleteMessageInternal({
      workspaceId: wsId,
      streamId: channel.id,
      messageId: message.id,
      actorId: owner,
    })

    expect(docRows(await list(owner, channel.id))).toEqual([
      {
        refId: doc.id,
        streamId: channel.id,
        sourceMessageId: null,
        anchorEventId: await docCreatedEventId(channel.id, doc.id),
        occurrenceCount: 1,
        title: "Kept",
      },
    ])
  })

  test("should hide a chip's doc from a viewer who cannot read it, in the rows, counts and search", async () => {
    const host = await createChannel("private")
    const doc = await createDoc(host.id, "Secret plan")
    const open = await createChannel("public", [peer])
    // The peer cannot read the doc, so a consented send carries the chip without granting it.
    await post(open.id, body(chip(doc.id)), { authorId: peer, consentedShareSourceIds: new Set([doc.id]) })

    const outsiderView = await list(outsider, open.id)
    const outsiderSearch = await list(outsider, open.id, "Secret")
    const ownerView = await list(owner, open.id)

    expect({
      outsiderRows: docRows(outsiderView),
      outsiderCount: outsiderView.counts?.doc,
      outsiderSearch: outsiderSearch.items.length,
      ownerTitles: docRows(ownerView).map((row) => row.title),
    }).toEqual({ outsiderRows: [], outsiderCount: 0, outsiderSearch: 0, ownerTitles: ["Secret plan"] })
  })

  test("should drop an archived doc's rows and bring them back on unarchive", async () => {
    const channel = await createChannel("public")
    const doc = await createDoc(channel.id, "Old notes")
    await post(channel.id, body(chip(doc.id)))
    const summary = (response: ListStreamContextResponse) => ({
      rows: docRows(response).map((row) => row.occurrenceCount),
      count: response.counts?.doc,
    })

    await streamService.archiveStream(doc.id, wsId, owner)
    const archived = summary(await list(owner, channel.id))
    await streamService.unarchiveStream(doc.id, wsId, owner)
    const unarchived = summary(await list(owner, channel.id))

    expect({ archived, unarchived }).toEqual({
      archived: { rows: [], count: 0 },
      unarchived: { rows: [2], count: 1 },
    })
  })

  test("should rebuild hosted and chip rows from stored state when backfilled", async () => {
    const channel = await createChannel("public")
    const doc = await createDoc(channel.id, "Backfilled")
    const message = await post(channel.id, body(chip(doc.id)))

    const snapshot = async () =>
      (
        await pool.query<{ stream_id: string; ref_id: string; source_message_id: string | null; detail: unknown }>(
          `SELECT stream_id, ref_id, source_message_id, detail FROM stream_context_items
           WHERE workspace_id = $1 AND category = 'doc' AND ref_id = $2
           ORDER BY source_message_id NULLS FIRST`,
          [wsId, doc.id]
        )
      ).rows
    const written = await snapshot()
    await pool.query(`DELETE FROM stream_context_items WHERE workspace_id = $1 AND category = 'doc'`, [wsId])

    const ctx = { pool }
    for (const chunk of await plan(ctx as never, wsId)) await processChunk(ctx as never, wsId, chunk)
    const rebuilt = await snapshot()
    let reinserted = 0
    for (const chunk of await plan(ctx as never, wsId)) {
      reinserted += (await processChunk(ctx as never, wsId, chunk)).processed
    }

    expect({ written, rebuilt, reinserted }).toEqual({
      written: [
        {
          stream_id: channel.id,
          ref_id: doc.id,
          source_message_id: null,
          detail: { anchorEventId: await docCreatedEventId(channel.id, doc.id) },
        },
        { stream_id: channel.id, ref_id: doc.id, source_message_id: message.id, detail: {} },
      ],
      rebuilt: written,
      reinserted: 0,
    })
  })
})
