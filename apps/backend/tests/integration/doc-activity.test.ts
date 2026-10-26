import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import * as Y from "yjs"
import { AuthorTypes, type DocActivityEventPayload, type JSONContent, type Stream } from "@threahq/types"
import {
  DOC_ACTIVITY_QUIET_MS,
  DocActivityService,
  DocAgentService,
  DocRepository,
  DocService,
  decodeUpdateBase64,
  encodeUpdateBase64,
  writeContentJson,
  ydocToContentJson,
} from "../../src/features/docs"
import { docActivityRollupJobId } from "../../src/features/docs/activity-service"
import { StreamEventRepository, StreamService } from "../../src/features/streams"
import { BotChannelService } from "../../src/features/api-keys"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { JobQueues } from "../../src/lib/queue"
import { blockId, eventId, personaId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupIsolatedTestDatabase, withTransaction } from "./setup"

let pool: Pool
let cleanup: () => Promise<void>
let streamService: StreamService
let docService: DocService
let wsId: string
let owner: string

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("doc-activity")
  pool = db.pool
  cleanup = db.cleanup
  streamService = new StreamService(pool)
  docService = new DocService({ pool })
  wsId = workspaceId()
  await withTransaction(pool, async (client) => {
    owner = (await addTestMember(client, wsId, userId())).id
    await WorkspaceRepository.insert(client, {
      id: wsId,
      name: "Doc Activity Workspace",
      slug: `doc-activity-${wsId.toLowerCase()}`,
      createdBy: owner,
    })
  })
})

afterAll(async () => {
  await cleanup()
})

function paragraph(...lines: string[]): JSONContent {
  return {
    type: "paragraph",
    attrs: { blockId: blockId() },
    content: lines.flatMap((text, index) => [...(index > 0 ? [{ type: "hardBreak" }] : []), { type: "text", text }]),
  }
}

async function flush(docId: string, blocks: JSONContent[]): Promise<void> {
  const { state } = await docService.get({ workspaceId: wsId, userId: owner, docId })
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, decodeUpdateBase64(state))
  const update = encodeUpdateBase64(writeContentJson(ydoc, { ...ydocToContentJson(ydoc), content: blocks }))
  await docService.postUpdate({ workspaceId: wsId, userId: owner, docId, update })
}

let slugCounter = 0
async function createDocWithBody(blocks: JSONContent[]): Promise<Stream & { parentStreamId: string }> {
  const host = await streamService.createChannel({
    workspaceId: wsId,
    slug: `doc-activity-${++slugCounter}`,
    visibility: "public",
    createdBy: owner,
  })
  const doc = await streamService.create({ workspaceId: wsId, type: "doc", parentStreamId: host.id, createdBy: owner })
  await flush(doc.id, blocks)
  return { ...doc, parentStreamId: host.id }
}

function buildService(now: () => Date = () => new Date(Date.now() + DOC_ACTIVITY_QUIET_MS * 2)) {
  const sent: unknown[][] = []
  const send = async (...args: unknown[]) => {
    sent.push(args)
    return "queued"
  }
  return { service: new DocActivityService({ pool, jobQueue: { send } as never, now }), sent }
}

async function hostActivity(hostId: string) {
  return StreamEventRepository.list(pool, wsId, hostId, { types: ["doc:activity"] })
}

async function foldedSequence(docId: string): Promise<string | undefined> {
  const result = await pool.query<{ folded_sequence: string }>(
    "SELECT folded_sequence FROM doc_activity_state WHERE workspace_id = $1 AND doc_id = $2",
    [wsId, docId]
  )
  return result.rows[0]?.folded_sequence
}

async function lastEditSequence(docId: string): Promise<string> {
  const edits = await StreamEventRepository.list(pool, wsId, docId, { types: ["doc:edited"] })
  return edits.at(-1)!.sequence.toString()
}

describe("doc activity roll-up", () => {
  test("should fold user edits into one host row and skip system rows when the doc has gone quiet", async () => {
    const first = paragraph("AWS row", "with a second line")
    const second = {
      type: "heading",
      attrs: { level: 2, blockId: blockId() },
      content: [{ type: "text", text: "Checklist" }],
    }
    const doc = await createDocWithBody([first, second])
    // An id-less block makes the server stamp it in its own system update.
    await flush(doc.id, [first, second, { type: "paragraph", content: [{ type: "text", text: "Rotation notes" }] }])
    await StreamEventRepository.insert(pool, {
      id: eventId(),
      workspaceId: wsId,
      streamId: doc.id,
      eventType: "doc:edited",
      payload: { seq: 99, touchedBlockIds: [first.attrs!.blockId as string] },
      actorId: AuthorTypes.SYSTEM,
      actorType: AuthorTypes.SYSTEM,
    })
    const userEdits = (await StreamEventRepository.list(pool, wsId, doc.id, { types: ["doc:edited"] })).filter(
      (edit) => edit.actorType === AuthorTypes.USER
    )
    const sections = await DocRepository.listSections(pool, wsId, doc.id)
    const { service } = buildService()

    const result = await service.rollUp({ workspaceId: wsId, docId: doc.id })
    const again = await service.rollUp({ workspaceId: wsId, docId: doc.id })
    const rows = await hostActivity(doc.parentStreamId)
    const outbox = await pool.query(
      "SELECT payload->>'streamId' AS stream_id, payload->'event'->>'id' AS event_id FROM outbox WHERE event_type = 'stream:doc_activity' AND payload->'event'->'payload'->>'docId' = $1",
      [doc.id]
    )

    expect({
      result,
      again,
      rows: rows.map((row) => ({
        id: row.id,
        payload: row.payload,
        actorId: row.actorId,
        hasSlot: row.broadcastSequence !== null,
      })),
      outbox: outbox.rows,
      folded: await foldedSequence(doc.id),
    }).toEqual({
      result: { status: "appended", eventId: rows[0]!.id },
      again: { status: "nothing" },
      rows: [
        {
          id: rows[0]!.id,
          payload: {
            docId: doc.id,
            actors: [{ actorId: owner, actorType: AuthorTypes.USER }],
            sections: [
              { blockId: first.attrs!.blockId, kind: "paragraph", markdown: "AWS row" },
              { blockId: second.attrs.blockId, kind: "heading", markdown: "## Checklist" },
              { blockId: sections[2]!.blockId, kind: "paragraph", markdown: "Rotation notes" },
            ],
            removedBlockIds: [],
            editCount: 2,
            reasons: [],
            fromSequence: userEdits[0]!.sequence.toString(),
            toSequence: userEdits[1]!.sequence.toString(),
          },
          actorId: owner,
          hasSlot: true,
        },
      ],
      outbox: [{ stream_id: doc.parentStreamId, event_id: rows[0]!.id }],
      folded: await lastEditSequence(doc.id),
    })
  })

  test("should requeue at the quiet deadline when the doc was edited within the window", async () => {
    const doc = await createDocWithBody([paragraph("Draft")])
    const head = await DocRepository.findHead(pool, wsId, doc.id)
    const { service, sent } = buildService(() => new Date())

    const result = await service.rollUp({ workspaceId: wsId, docId: doc.id })
    const processAfter = new Date(head!.updatedAt.getTime() + DOC_ACTIVITY_QUIET_MS)

    expect({ result, sent, rows: await hostActivity(doc.parentStreamId) }).toEqual({
      result: { status: "requeued", processAfter },
      sent: [
        [
          JobQueues.DOC_ACTIVITY_ROLLUP,
          { workspaceId: wsId, docId: doc.id, hop: 1 },
          { processAfter, messageId: docActivityRollupJobId(doc.id, processAfter, 1) },
        ],
      ],
      rows: [],
    })
  })

  test("should name a block the doc held at the last roll-up and no longer does as removed", async () => {
    const kept = paragraph("On-call rota")
    const dropped = paragraph("Old pager number")
    const doc = await createDocWithBody([kept, dropped])
    const { service } = buildService()
    await service.rollUp({ workspaceId: wsId, docId: doc.id })
    await flush(doc.id, [{ ...kept, content: [{ type: "text", text: "On-call rota, updated" }] }])

    await service.rollUp({ workspaceId: wsId, docId: doc.id })
    const [, row] = await hostActivity(doc.parentStreamId)

    const last = (await StreamEventRepository.list(pool, wsId, doc.id, { types: ["doc:edited"] })).at(-1)!
    expect(row!.payload).toEqual({
      docId: doc.id,
      actors: [{ actorId: owner, actorType: AuthorTypes.USER }],
      sections: [{ blockId: kept.attrs!.blockId, kind: "paragraph", markdown: "On-call rota, updated" }],
      removedBlockIds: [dropped.attrs!.blockId],
      editCount: 1,
      reasons: [],
      fromSequence: last.sequence.toString(),
      toSequence: last.sequence.toString(),
    })
  })

  test("should not count a block born and replaced inside one window as removed", async () => {
    const intro = paragraph("Intro")
    const doc = await createDocWithBody([intro])
    const { service } = buildService()
    await service.rollUp({ workspaceId: wsId, docId: doc.id })
    const draft = paragraph("## On-call owners")
    const heading = {
      type: "heading",
      attrs: { level: 2, blockId: blockId() },
      content: [{ type: "text", text: "On-call owners" }],
    }
    await flush(doc.id, [intro, draft])
    await flush(doc.id, [intro, heading])

    await service.rollUp({ workspaceId: wsId, docId: doc.id })
    const [, row] = await hostActivity(doc.parentStreamId)

    expect({
      sections: (row!.payload as { sections: unknown }).sections,
      removed: (row!.payload as { removedBlockIds: unknown }).removedBlockIds,
    }).toEqual({
      sections: [{ blockId: heading.attrs.blockId, kind: "heading", markdown: "## On-call owners" }],
      removed: [],
    })
  })

  test("should carry an agent's distinct reasons with the most recent last", async () => {
    const row = paragraph("AWS key: active")
    const doc = await createDocWithBody([row])
    const { service } = buildService()
    await service.rollUp({ workspaceId: wsId, docId: doc.id })
    const agent = new DocAgentService({
      pool,
      docService,
      streamService,
      botChannelService: new BotChannelService({ pool }),
    })
    const ctx = {
      workspaceId: wsId,
      hostStreamId: doc.parentStreamId,
      principal: { kind: "user" as const, userId: owner },
      actor: { actorId: personaId(), actorType: AuthorTypes.PERSONA },
    }
    const edit = (reason: string, from: string, to: string) =>
      agent.editDoc(ctx, { docId: doc.id, reason, edits: [{ old: from, new: to }] })
    const outcomes = [
      await edit("marked the AWS key revoked", "active", "revoked"),
      await edit("noted the rotation date", "revoked", "revoked 2026-10-01"),
      await edit("marked the AWS key revoked", "revoked 2026-10-01", "revoked"),
    ]

    await service.rollUp({ workspaceId: wsId, docId: doc.id })
    const [, activity] = await hostActivity(doc.parentStreamId)
    const payload = activity!.payload as DocActivityEventPayload

    expect({
      statuses: outcomes.map((outcome) => outcome.status),
      actors: payload.actors,
      reasons: payload.reasons,
    }).toEqual({
      statuses: ["applied", "applied", "applied"],
      actors: [{ actorId: ctx.actor.actorId, actorType: AuthorTypes.PERSONA }],
      reasons: ["noted the rotation date", "marked the AWS key revoked"],
    })
  })

  test("should advance the cursor without a row when the host is archived", async () => {
    const doc = await createDocWithBody([paragraph("Archived plan")])
    await streamService.archiveStream(doc.parentStreamId, wsId, owner)
    const { service } = buildService()

    const result = await service.rollUp({ workspaceId: wsId, docId: doc.id })

    expect({
      result,
      folded: await foldedSequence(doc.id),
      rows: await hostActivity(doc.parentStreamId),
    }).toEqual({ result: { status: "skipped" }, folded: await lastEditSequence(doc.id), rows: [] })
  })
})
