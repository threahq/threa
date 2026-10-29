import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import * as Y from "yjs"
import { AuthorTypes, type JSONContent, type Stream } from "@threahq/types"
import {
  DOC_MENTION_QUIET_MS,
  DocAgentService,
  DocMentionOutboxHandler,
  DocMentionService,
  DocRepository,
  DocService,
  decodeUpdateBase64,
  encodeUpdateBase64,
  writeContentJson,
  ydocToContentJson,
} from "../../src/features/docs"
import { docMentionSettleJobId } from "../../src/features/docs/mention-service"
import { StreamEventRepository, StreamService } from "../../src/features/streams"
import { BotChannelService } from "../../src/features/api-keys"
import { EventService } from "../../src/features/messaging/event-service"
import { ActivityService } from "../../src/features/activity"
import { WorkspaceRepository } from "../../src/features/workspaces"
import type { OutboxEvent } from "../../src/lib/outbox"
import { JobQueues } from "../../src/lib/queue"
import { blockId, botId, personaId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupIsolatedTestDatabase, withTransaction } from "./setup"

let pool: Pool
let cleanup: () => Promise<void>
let streamService: StreamService
let docService: DocService
let eventService: EventService
let wsId: string
let owner: string
let peer: string
let peerSlug: string

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("doc-mentions")
  pool = db.pool
  cleanup = db.cleanup
  streamService = new StreamService(pool)
  docService = new DocService({ pool })
  eventService = new EventService(pool)
  wsId = workspaceId()
  await withTransaction(pool, async (client) => {
    owner = (await addTestMember(client, wsId, userId())).id
    const peerUser = await addTestMember(client, wsId, userId())
    peer = peerUser.id
    peerSlug = peerUser.slug
    await WorkspaceRepository.insert(client, {
      id: wsId,
      name: "Doc Mentions Workspace",
      slug: `doc-mentions-${wsId.toLowerCase()}`,
      createdBy: owner,
    })
  })
})

afterAll(async () => {
  await cleanup()
})

const text = (value: string): JSONContent => ({ type: "text", text: value })
const mention = (id: string): JSONContent => ({ type: "mention", attrs: { id, slug: `slug-${id}` } })

function block(id: string, ...content: JSONContent[]): JSONContent {
  return { type: "paragraph", attrs: { blockId: id }, content }
}

async function write(docId: string, blocks: JSONContent[], author = owner): Promise<void> {
  const { state } = await docService.get({ workspaceId: wsId, userId: owner, docId })
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, decodeUpdateBase64(state))
  const update = encodeUpdateBase64(writeContentJson(ydoc, { ...ydocToContentJson(ydoc), content: blocks }))
  await docService.postUpdate({ workspaceId: wsId, userId: author, docId, update })
}

let slugCounter = 0
async function createDoc(visibility: "public" | "private" = "public", memberIds: string[] = []): Promise<Stream> {
  const host = await streamService.createChannel({
    workspaceId: wsId,
    slug: `doc-mentions-${visibility}-${++slugCounter}`,
    visibility,
    createdBy: owner,
    memberIds,
  })
  return streamService.create({ workspaceId: wsId, type: "doc", parentStreamId: host.id, createdBy: owner })
}

/** "quiet": the doc's edits so far are moved back past the quiet window first; "typing": they stay fresh. */
type Clock = "quiet" | "typing"

async function ageEdits(docId: string): Promise<void> {
  await pool.query(
    `UPDATE stream_events SET created_at = created_at - make_interval(secs => $3)
     WHERE workspace_id = $1 AND stream_id = $2 AND event_type = 'doc:edited'`,
    [wsId, docId, (DOC_MENTION_QUIET_MS * 2) / 1000]
  )
}

function buildService() {
  const sent: unknown[][] = []
  const send = async (...args: unknown[]) => {
    sent.push(args)
    return "queued"
  }
  return { service: new DocMentionService({ pool, jobQueue: { send } as never }), sent }
}

async function settle(docId: string, clock: Clock, actorId = owner) {
  if (clock === "quiet") await ageEdits(docId)
  return buildService().service.settle({ workspaceId: wsId, docId, actorId })
}

async function docMentions(docId: string) {
  const result = await pool.query<{
    id: string
    user_id: string
    message_id: string
    actor_id: string
    actor_type: string
    context: Record<string, unknown>
  }>(
    `SELECT id, user_id, message_id, actor_id, actor_type, context FROM user_activity
     WHERE workspace_id = $1 AND stream_id = $2 AND activity_type = 'doc_mention' ORDER BY created_at, id`,
    [wsId, docId]
  )
  return result.rows.map((row) => ({
    userId: row.user_id,
    blockId: row.message_id,
    actorId: row.actor_id,
    actorType: row.actor_type,
    context: row.context,
  }))
}

async function firstLine(docId: string, id: string): Promise<string> {
  const section = await DocRepository.findSection(pool, wsId, docId, id)
  return section!.markdown.split("\n")[0]!
}

async function lastEdit(docId: string) {
  return (await StreamEventRepository.list(pool, wsId, docId, { types: ["doc:edited"] })).at(-1)!
}

describe("doc mention settle", () => {
  test("should notify the mentioned user once the author has left the block alone for the quiet window", async () => {
    const doc = await createDoc()
    const id = blockId()
    await write(doc.id, [block(id, text("Ping "), mention(peer), text(" about rotation"))])

    const result = await settle(doc.id, "quiet")
    const rows = await docMentions(doc.id)
    const outbox = await pool.query<{ activity_id: string; target: string }>(
      `SELECT payload->'activity'->>'id' AS activity_id, payload->>'targetUserId' AS target FROM outbox
       WHERE event_type = 'activity:created' AND payload->'activity'->>'streamId' = $1`,
      [doc.id]
    )

    expect({ result, rows, outbox: outbox.rows }).toEqual({
      result: { status: "settled", activityIds: [expect.any(String)] },
      rows: [
        {
          userId: peer,
          blockId: id,
          actorId: owner,
          actorType: AuthorTypes.USER,
          context: { contentPreview: await firstLine(doc.id, id), streamName: null },
        },
      ],
      outbox: [{ activity_id: result.status === "settled" ? result.activityIds[0]! : "", target: peer }],
    })
  })

  test("should push the block's current first line under the doc's name", async () => {
    const doc = await createDoc()
    await pool.query("UPDATE streams SET display_name = 'Rotation plan' WHERE workspace_id = $1 AND id = $2", [
      wsId,
      doc.id,
    ])
    const id = blockId()
    await write(doc.id, [block(id, text("Ping "), mention(peer))])
    const result = await settle(doc.id, "quiet")
    await write(doc.id, [block(id, text("Ping "), mention(peer), text(" today"))])
    const activityId = result.status === "settled" ? result.activityIds[0]! : ""

    const resolution = await new ActivityService({ pool }).resolvePushSource({
      workspaceId: wsId,
      userId: peer,
      activityId,
      plannedStreamId: doc.id,
    })

    expect(resolution).toMatchObject({
      valid: true,
      source: {
        activityType: "doc_mention",
        streamId: doc.id,
        messageId: id,
        contentMarkdown: await firstLine(doc.id, id),
        streamName: "Rotation plan",
      },
    })
  })

  test("should notify nobody and requeue at the quiet deadline while the author is still in the block", async () => {
    const doc = await createDoc()
    await write(doc.id, [block(blockId(), text("Ping "), mention(peer))])
    const edit = await lastEdit(doc.id)
    const { service, sent } = buildService()

    const result = await service.settle({ workspaceId: wsId, docId: doc.id, actorId: owner })
    const processAfter = new Date(edit.createdAt.getTime() + DOC_MENTION_QUIET_MS)

    expect({ result, sent, rows: await docMentions(doc.id) }).toEqual({
      result: { status: "requeued", processAfter, activityIds: [] },
      sent: [
        [
          JobQueues.DOC_MENTION_SETTLE,
          { workspaceId: wsId, docId: doc.id, actorId: owner, hop: 1 },
          { processAfter, messageId: docMentionSettleJobId(doc.id, owner, processAfter, 1) },
        ],
      ],
      rows: [],
    })
  })

  test("should notify for a block as soon as the author edits another one", async () => {
    const doc = await createDoc()
    const first = block(blockId(), text("Ping "), mention(peer))
    await write(doc.id, [first])
    const second = blockId()
    await write(doc.id, [first, block(second, text("Next"), mention(peer))])

    const result = await settle(doc.id, "typing")

    expect({ status: result.status, rows: (await docMentions(doc.id)).map((row) => row.blockId) }).toEqual({
      status: "requeued",
      rows: [first.attrs!.blockId],
    })
  })

  test("should notify nobody for a mention typed and deleted before the block settled", async () => {
    const doc = await createDoc()
    const id = blockId()
    await write(doc.id, [block(id, text("Ping "), mention(peer))])
    await write(doc.id, [block(id, text("Ping nobody"))])

    expect({ result: await settle(doc.id, "quiet"), rows: await docMentions(doc.id) }).toEqual({
      result: { status: "nothing" },
      rows: [],
    })
  })

  test("should not notify the author for mentioning themself, nor anyone for bot or persona mentions", async () => {
    const doc = await createDoc()
    await write(doc.id, [
      block(blockId(), mention(owner), text(" "), mention(botId()), text(" "), mention(personaId())),
    ])

    expect({ result: await settle(doc.id, "quiet"), rows: await docMentions(doc.id) }).toEqual({
      result: { status: "nothing" },
      rows: [],
    })
  })

  test("should not notify a mentioned user who cannot read the doc", async () => {
    const doc = await createDoc("private")
    await write(doc.id, [block(blockId(), text("Ping "), mention(peer))])

    expect({ result: await settle(doc.id, "quiet"), rows: await docMentions(doc.id) }).toEqual({
      result: { status: "nothing" },
      rows: [],
    })
  })

  test("should notify a mentioned user who reads the doc through a share grant", async () => {
    const doc = await createDoc("private")
    const open = await streamService.createChannel({
      workspaceId: wsId,
      slug: `doc-mentions-share-${++slugCounter}`,
      visibility: "public",
      createdBy: owner,
    })
    await eventService.createMessage({
      workspaceId: wsId,
      streamId: open.id,
      authorId: owner,
      authorType: "user",
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "docEmbed", attrs: { docId: doc.id, title: "Plan" } }] }],
      },
      contentMarkdown: "shared",
      confirmedPrivacyWarning: true,
    })
    await write(doc.id, [block(blockId(), text("Ping "), mention(peer))])

    await settle(doc.id, "quiet")

    expect((await docMentions(doc.id)).map((row) => row.userId)).toEqual([peer])
  })

  test("should notify once per block and user when the mention is removed and added again", async () => {
    const doc = await createDoc()
    const id = blockId()
    await write(doc.id, [block(id, text("Ping "), mention(peer))])
    await settle(doc.id, "quiet")
    await write(doc.id, [block(id, text("Ping nobody"))])
    await write(doc.id, [block(id, text("Ping "), mention(peer), text(" again"))])

    const again = await settle(doc.id, "quiet")

    expect({ again, rows: (await docMentions(doc.id)).map((row) => row.userId) }).toEqual({
      again: { status: "nothing" },
      rows: [peer],
    })
  })

  test("should notify at once for an agent rewrite, attributed to the agent", async () => {
    const doc = await createDoc()
    await write(doc.id, [block(blockId(), text("Owner: TBD"))])
    const agent = new DocAgentService({
      pool,
      docService,
      streamService,
      botChannelService: new BotChannelService({ pool }),
    })
    const persona = personaId()
    const written = await agent.editDoc(
      {
        workspaceId: wsId,
        hostStreamId: doc.parentStreamId,
        principal: { kind: "user", userId: owner },
        actor: { actorId: persona, actorType: AuthorTypes.PERSONA },
      },
      { docId: doc.id, reason: "Assign owner", edits: [{ old: "TBD", new: `[@${peerSlug}](user:${peer})` }] }
    )

    const result = await settle(doc.id, "typing", persona)

    expect({
      written: written.status,
      status: result.status,
      rows: (await docMentions(doc.id)).map(({ userId: user, actorId, actorType }) => ({ user, actorId, actorType })),
    }).toEqual({
      written: "applied",
      status: "settled",
      rows: [{ user: peer, actorId: persona, actorType: AuthorTypes.PERSONA }],
    })
  })

  test("should notify nobody for a mention the rollout seed already recorded when its author edits elsewhere", async () => {
    const doc = await createDoc()
    const [mentioned, other] = [blockId(), blockId()]
    await write(doc.id, [block(mentioned, text("Ping "), mention(peer))])
    const migration = await Bun.file(
      new URL("../../src/db/migrations/20261028220854_doc_mention_notifications.sql", import.meta.url)
    ).text()
    await pool.query(migration.slice(migration.indexOf("INSERT INTO doc_mention_notifications")))
    await write(doc.id, [block(mentioned, text("Ping "), mention(peer)), block(other, text("Later"))])

    await settle(doc.id, "quiet")

    expect(await docMentions(doc.id)).toEqual([])
  })

  test("should credit a block's mention to the co-author who touched it last, not the earlier author", async () => {
    const coauthor = (await withTransaction(pool, (client) => addTestMember(client, wsId, userId()))).id
    const doc = await createDoc("public", [coauthor])
    const id = blockId()
    await write(doc.id, [block(id, text("Ping "), mention(peer))])
    await write(doc.id, [block(id, text("Ping "), mention(peer), text(" please"))], coauthor)

    await settle(doc.id, "quiet")
    const afterOwner = await docMentions(doc.id)
    await settle(doc.id, "quiet", coauthor)

    expect({
      afterOwner,
      afterCoauthor: (await docMentions(doc.id)).map(({ userId: user, actorId }) => ({ user, actorId })),
    }).toEqual({ afterOwner: [], afterCoauthor: [{ user: peer, actorId: coauthor }] })
  })
})

describe("StreamEventRepository.list actor filter", () => {
  test("should return only the given actor's doc edits", async () => {
    const coauthor = (await withTransaction(pool, (client) => addTestMember(client, wsId, userId()))).id
    const doc = await createDoc("public", [coauthor])
    await write(doc.id, [block(blockId(), text("Owner"))])
    await write(doc.id, [block(blockId(), text("Co-author"))], coauthor)

    const edits = await StreamEventRepository.list(pool, wsId, doc.id, { types: ["doc:edited"], actorId: coauthor })

    expect(edits.map(({ actorId, eventType }) => ({ actorId, eventType }))).toEqual([
      { actorId: coauthor, eventType: "doc:edited" },
    ])
  })
})

class TestHandler extends DocMentionOutboxHandler {
  processAll(events: OutboxEvent[]) {
    return this.processBatch(events)
  }
}

describe("doc mention scheduling", () => {
  test("should schedule a quiet-window settle per write window and an immediate one when the author leaves a block", async () => {
    const docId = (await createDoc()).id
    const [a, b] = [blockId(), blockId()]
    const at = new Date(Math.floor(Date.now() / DOC_MENTION_QUIET_MS) * DOC_MENTION_QUIET_MS)
    let outboxId = 0n
    const docUpdated = (touchedBlockIds: string[], extra: Record<string, unknown> = {}): OutboxEvent =>
      ({
        id: ++outboxId,
        eventType: "doc:updated",
        payload: {
          workspaceId: wsId,
          streamId: docId,
          seq: Number(outboxId),
          update: "AA==",
          touchedBlockIds,
          actorId: owner,
          actorType: AuthorTypes.USER,
          ...extra,
        },
        createdAt: at,
      }) as unknown as OutboxEvent
    const sent: unknown[][] = []
    const handler = new TestHandler(pool, {
      send: async (...args: unknown[]) => {
        sent.push(args)
        return "queued"
      },
    })
    const data = { workspaceId: wsId, docId, actorId: owner }
    const quiet = {
      processAfter: new Date(at.getTime() + DOC_MENTION_QUIET_MS),
      messageId: docMentionSettleJobId(docId, owner, at),
    }

    await handler.processAll([docUpdated([a]), docUpdated([a])])
    const typing = sent.splice(0)
    await handler.processAll([
      docUpdated([b]),
      docUpdated([], { actorId: AuthorTypes.SYSTEM, actorType: AuthorTypes.SYSTEM }),
    ])
    const leaving = sent.splice(0)
    await handler.processAll([docUpdated([b], { reason: "Tidy" })])
    const rewrite = sent.splice(0)

    expect({ typing, leaving, rewrite }).toEqual({
      typing: [[JobQueues.DOC_MENTION_SETTLE, data, quiet]],
      leaving: [
        [JobQueues.DOC_MENTION_SETTLE, data, quiet],
        [
          JobQueues.DOC_MENTION_SETTLE,
          data,
          { processAfter: undefined, messageId: `doc-mention:${docId}:${owner}:now:3` },
        ],
      ],
      rewrite: [
        [JobQueues.DOC_MENTION_SETTLE, data, quiet],
        [
          JobQueues.DOC_MENTION_SETTLE,
          data,
          { processAfter: undefined, messageId: `doc-mention:${docId}:${owner}:now:5` },
        ],
      ],
    })
  })
})
