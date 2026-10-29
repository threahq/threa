import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import * as Y from "yjs"
import { AuthorTypes, type JSONContent, type Stream } from "@threahq/types"
import {
  DocAgentService,
  DocRepository,
  DocService,
  decodeUpdateBase64,
  encodeUpdateBase64,
  listHostedDocs,
  writeContentJson,
  ydocToContentJson,
  type DocAgentContext,
  type HostedDocAgentContext,
} from "../../src/features/docs"
import { BotChannelService } from "../../src/features/api-keys"
import { StreamEventRepository, StreamRepository, StreamService } from "../../src/features/streams"
import { BotChannelAccessRepository } from "../../src/features/api-keys"
import { EventService } from "../../src/features/messaging"
import { UserRepository, WorkspaceRepository } from "../../src/features/workspaces"
import { blockId, botChannelAccessId, botId, personaId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupIsolatedTestDatabase, withTransaction } from "./setup"

let pool: Pool
let cleanup: () => Promise<void>
let streamService: StreamService
let docService: DocService
let agent: DocAgentService
let wsId: string
let owner: string
let outsider: string
const persona = personaId()

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("doc-agent")
  pool = db.pool
  cleanup = db.cleanup
  streamService = new StreamService(pool)
  docService = new DocService({ pool })
  agent = new DocAgentService({ pool, docService, streamService, botChannelService: new BotChannelService({ pool }) })
  wsId = workspaceId()
  await withTransaction(pool, async (client) => {
    owner = (await addTestMember(client, wsId, userId())).id
    outsider = (await addTestMember(client, wsId, userId())).id
    await WorkspaceRepository.insert(client, {
      id: wsId,
      name: "Doc Agent Workspace",
      slug: `doc-agent-${wsId.toLowerCase()}`,
      createdBy: owner,
    })
  })
})

afterAll(async () => {
  await cleanup()
})

const paragraph = (text: string, id = blockId()): JSONContent => ({
  type: "paragraph",
  attrs: { blockId: id },
  content: [{ type: "text", text }],
})

/** A client's update built from the doc as it stands now, posted later. */
async function draftClientUpdate(docId: string, edit: (blocks: JSONContent[]) => JSONContent[]): Promise<string> {
  const { state } = await docService.get({ workspaceId: wsId, userId: owner, docId })
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, decodeUpdateBase64(state))
  const json = ydocToContentJson(ydoc)
  return encodeUpdateBase64(writeContentJson(ydoc, { ...json, content: edit(json.content ?? []) }))
}

async function postClient(docId: string, update: string): Promise<void> {
  await docService.postUpdate({ workspaceId: wsId, userId: owner, docId, update })
}

let slugCounter = 0
async function createHostedDoc(
  blocks: JSONContent[],
  visibility: "public" | "private" = "public"
): Promise<{ host: Stream; doc: Stream; ctx: HostedDocAgentContext }> {
  const host = await streamService.createChannel({
    workspaceId: wsId,
    slug: `doc-agent-${++slugCounter}`,
    visibility,
    createdBy: owner,
  })
  const doc = await streamService.create({ workspaceId: wsId, type: "doc", parentStreamId: host.id, createdBy: owner })
  if (blocks.length > 0) await postClient(doc.id, await draftClientUpdate(doc.id, () => blocks))
  return {
    host,
    doc,
    ctx: {
      workspaceId: wsId,
      hostStreamId: host.id,
      principal: { kind: "user", userId: owner },
      actor: { actorId: persona, actorType: AuthorTypes.PERSONA },
    },
  }
}

async function readOk(ctx: HostedDocAgentContext, docId: string) {
  const read = await agent.readDoc(ctx, { docId })
  if (read.status !== "ok") throw new Error(`Expected doc ${docId} to be readable, got ${read.status}`)
  return read
}

async function sectionMarkdown(docId: string): Promise<string[]> {
  return (await DocRepository.listSections(pool, wsId, docId)).map((section) => section.markdown)
}

async function docUpdatedOutbox(docId: string) {
  const result = await pool.query<{ seq: number; actor_type: string }>(
    "SELECT (payload->>'seq')::int AS seq, payload->>'actorType' AS actor_type FROM outbox WHERE event_type = 'doc:updated' AND payload->>'streamId' = $1 ORDER BY id",
    [docId]
  )
  return result.rows
}

describe("doc agent service", () => {
  test("should store an agent's bare @slug as the user's id", async () => {
    const kim = await withTransaction(pool, (client) =>
      UserRepository.insert(client, {
        id: userId(),
        workspaceId: wsId,
        workosUserId: userId(),
        email: "kim-mention@test.local",
        name: "Kim",
        role: "member",
        slug: "kim-mention",
      })
    )
    const { doc, ctx } = await createHostedDoc([paragraph("AWS key is live")])

    const result = await agent.editDoc(ctx, {
      docId: doc.id,
      reason: "Name the owner",
      edits: [{ old: "AWS key is live", new: "AWS key is live, ask @kim-mention" }],
    })
    const { state } = await docService.get({ workspaceId: wsId, userId: owner, docId: doc.id })
    const ydoc = new Y.Doc()
    Y.applyUpdate(ydoc, decodeUpdateBase64(state))
    const mentions = (ydocToContentJson(ydoc).content?.[0]?.content ?? []).filter((node) => node.type === "mention")

    expect({ status: result.status, mentions: mentions.map((node) => node.attrs) }).toEqual({
      status: "applied",
      mentions: [expect.objectContaining({ id: kim.id, slug: "kim-mention" })],
    })
  })

  test("should converge an agent edit with a human update drafted before it on another block", async () => {
    const aws = paragraph("AWS key is live")
    const gcp = paragraph("GCP key is live")
    const { doc, ctx } = await createHostedDoc([aws, gcp])
    const human = await draftClientUpdate(doc.id, ([first, second]) => [
      { ...first, content: [{ type: "text", text: "AWS key is live, rotated by Kim" }] },
      second,
    ])

    const result = await agent.editDoc(ctx, {
      docId: doc.id,
      reason: "GCP key revoked",
      edits: [{ old: "GCP key is live", new: "GCP key is revoked" }],
    })
    await postClient(doc.id, human)

    expect({ result, sections: await sectionMarkdown(doc.id) }).toEqual({
      result: {
        status: "applied",
        docId: doc.id,
        title: null,
        seq: 2,
        touchedBlockIds: [gcp.attrs!.blockId],
        markdown: `<!-- ${gcp.attrs!.blockId} -->\nGCP key is revoked`,
      },
      sections: ["AWS key is live, rotated by Kim", "GCP key is revoked"],
    })
  })

  test("should keep both writers' text when a human edits the same block the agent rewrites", async () => {
    const { doc, ctx } = await createHostedDoc([paragraph("AWS key is live")])
    const human = await draftClientUpdate(doc.id, ([first]) => [
      { ...first, content: [{ type: "text", text: "AWS key is live (checked)" }] },
    ])

    const result = await agent.editDoc(ctx, {
      docId: doc.id,
      reason: "AWS key revoked",
      edits: [{ old: "is live", new: "is revoked" }],
    })
    await postClient(doc.id, human)

    const [merged] = await sectionMarkdown(doc.id)
    const read = await agent.readDoc(ctx, { docId: doc.id })
    expect({
      status: result.status,
      agentText: merged.includes("revoked"),
      humanText: merged.includes("(checked)"),
      readable: read.status,
    }).toEqual({ status: "applied", agentText: true, humanText: true, readable: "ok" })
  })

  test("should refuse an ambiguous anchor without writing and return the whole doc", async () => {
    const { doc, ctx } = await createHostedDoc([paragraph("AWS key is live"), paragraph("GCP key is live")])
    const before = await readOk(ctx, doc.id)

    const result = await agent.editDoc(ctx, {
      docId: doc.id,
      reason: "Revoke",
      edits: [{ old: "key is live", new: "key is revoked" }],
    })

    expect({ result, after: await agent.readDoc(ctx, { docId: doc.id }) }).toEqual({
      result: {
        status: "edit_refused",
        refusal: {
          reason: "ambiguous",
          editIndex: 0,
          scope: { markdown: before.markdown },
        },
      },
      after: before,
    })
  })

  test("should refuse a missing scoped anchor with only that block's markdown", async () => {
    const target = paragraph("GCP key is live")
    const { doc, ctx } = await createHostedDoc([paragraph("AWS key is live"), target])

    const result = await agent.editDoc(ctx, {
      docId: doc.id,
      reason: "Revoke",
      edits: [{ blockId: target.attrs!.blockId, old: "AWS key", new: "Azure key" }],
    })

    expect(result).toEqual({
      status: "edit_refused",
      refusal: {
        reason: "not_found",
        editIndex: 0,
        scope: { blockId: target.attrs!.blockId, markdown: `<!-- ${target.attrs!.blockId} -->\nGCP key is live` },
      },
    })
  })

  test("should hide a private host's doc from a non-member and refuse a public host's non-member", async () => {
    const privateDoc = await createHostedDoc([paragraph("Secret")], "private")
    const publicDoc = await createHostedDoc([paragraph("Open")], "public")
    const other = await createHostedDoc([paragraph("Elsewhere")])
    const edit = { reason: "Edit", edits: [{ old: "e", new: "E" }] }

    expect({
      privateRead: await agent.readDoc(
        { ...privateDoc.ctx, principal: { kind: "user", userId: outsider } },
        { docId: privateDoc.doc.id }
      ),
      privateWrite: await agent.editDoc(
        { ...privateDoc.ctx, principal: { kind: "user", userId: outsider } },
        { docId: privateDoc.doc.id, ...edit }
      ),
      publicWrite: await agent.editDoc(
        { ...publicDoc.ctx, principal: { kind: "user", userId: outsider } },
        { docId: publicDoc.doc.id, reason: "Edit", edits: [{ old: "Open", new: "Closed" }] }
      ),
      otherHost: await agent.readDoc(publicDoc.ctx, { docId: other.doc.id }),
      otherHostWrite: await agent.editDoc(publicDoc.ctx, { docId: other.doc.id, ...edit }),
      listed: await agent.listDocs({ ...privateDoc.ctx, principal: { kind: "user", userId: outsider } }),
    }).toEqual({
      privateRead: { status: "not_found" },
      privateWrite: { status: "not_found" },
      publicWrite: { status: "refused", code: "not_a_member", reason: "not_a_member" },
      otherHost: { status: "not_found" },
      otherHostWrite: { status: "not_found" },
      listed: { status: "not_found" },
    })
  })

  test("should respect share-only and root access when listing a doc and its children", async () => {
    const host = await streamService.createChannel({
      workspaceId: wsId,
      slug: `shared-doc-host-${++slugCounter}`,
      visibility: "private",
      createdBy: owner,
    })
    const parent = await streamService.createDoc({
      workspaceId: wsId,
      parentStreamId: host.id,
      principal: { kind: "user", userId: owner },
      displayName: "Shared parent",
    })
    const child = await streamService.createDoc({
      workspaceId: wsId,
      parentStreamId: parent.id,
      principal: { kind: "user", userId: owner },
      displayName: "Private child title",
    })
    await postClient(child.id, await draftClientUpdate(child.id, () => [paragraph("Private child body")]))
    const shareStream = await streamService.createChannel({
      workspaceId: wsId,
      slug: `share-carrier-${++slugCounter}`,
      visibility: "public",
      createdBy: owner,
    })
    const eventService = new EventService(pool)
    const shareMessage = await eventService.createMessage({
      workspaceId: wsId,
      streamId: shareStream.id,
      authorId: owner,
      authorType: "user",
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "docEmbed", attrs: { docId: parent.id } }] }],
      },
      contentMarkdown: "shared parent",
      confirmedPrivacyWarning: true,
    })
    const bot = botId()
    await pool.query(`INSERT INTO bots (id, workspace_id, api_key_id, name) VALUES ($1, $2, $3, 'Doc agent bot')`, [
      bot,
      wsId,
      `key_${bot}`,
    ])
    await BotChannelAccessRepository.grantAccess(pool, {
      id: botChannelAccessId(),
      workspaceId: wsId,
      botId: bot,
      streamId: host.id,
      grantedBy: owner,
    })
    const userCtx: HostedDocAgentContext = {
      workspaceId: wsId,
      hostStreamId: parent.id,
      principal: { kind: "user", userId: owner },
      actor: { actorId: persona, actorType: AuthorTypes.PERSONA },
    }
    const selfRead = await agent.readDoc(userCtx, { docId: parent.id })
    const childRead = await agent.readDoc(userCtx, { docId: child.id })
    const childTitle = await agent.setTitle(userCtx, { docId: child.id, title: "Nested child" })
    const userListed = await agent.listDocs({ ...userCtx, principal: { kind: "user", userId: outsider } })
    const botListed = await agent.listDocs({ ...userCtx, principal: { kind: "bot", botId: bot } })

    const parentGrant = await agent.readDoc(
      { ...userCtx, principal: { kind: "user", userId: outsider } },
      { docId: parent.id }
    )
    const shareExists = await pool.query(
      "SELECT 1 FROM shared_docs WHERE workspace_id = $1 AND share_message_id = $2 AND doc_id = $3",
      [wsId, shareMessage.id, parent.id]
    )
    expect({
      shareExists: shareExists.rowCount,
      userDocs: userListed.status === "ok" ? userListed.docs.map(({ docId, title }) => ({ docId, title })) : [],
      promptDocs: await listHostedDocs(pool, wsId, parent.id, outsider),
      botDocs: botListed.status === "ok" ? botListed.docs.map(({ docId, title }) => ({ docId, title })) : [],
      parentGrant: parentGrant.status,
      self: { status: selfRead.status, title: selfRead.status === "ok" ? selfRead.title : null },
      child: {
        status: childRead.status,
        title: childRead.status === "ok" ? childRead.title : null,
        containsBody: childRead.status === "ok" && childRead.markdown.includes("Private child body"),
      },
      childTitle: { status: childTitle.status, title: childTitle.status === "applied" ? childTitle.title : null },
    }).toEqual({
      shareExists: 1,
      userDocs: [{ docId: parent.id, title: "Shared parent" }],
      promptDocs: [{ docId: parent.id, title: "Shared parent", firstLine: null, open: false }],
      botDocs: [
        { docId: parent.id, title: "Shared parent" },
        { docId: child.id, title: "Nested child" },
      ],
      parentGrant: "ok",
      self: { status: "ok", title: "Shared parent" },
      child: { status: "ok", title: "Private child title", containsBody: true },
      childTitle: { status: "applied", title: "Nested child" },
    })
    expect(JSON.stringify(userListed)).not.toContain("Private child")
    expect(JSON.stringify(userListed)).not.toContain("Private child body")
  })

  test("should attribute the write to the persona and carry the reason on doc:edited", async () => {
    const target = paragraph("AWS key is live")
    const { doc, ctx } = await createHostedDoc([target])

    await agent.editDoc(ctx, {
      docId: doc.id,
      reason: "AWS key revoked after rotation",
      edits: [{ old: "live", new: "revoked" }],
    })

    const updates = await DocRepository.listUpdatesAfter(pool, wsId, doc.id, 1)
    const edited = await StreamEventRepository.list(pool, wsId, doc.id, { types: ["doc:edited"] })
    expect({
      updates: updates.map(({ seq, actorId, actorType }) => ({ seq, actorId, actorType })),
      edited: edited.map(({ actorId, actorType, payload }) => ({ actorId, actorType, payload })),
      outbox: await docUpdatedOutbox(doc.id),
    }).toEqual({
      updates: [{ seq: 2, actorId: persona, actorType: AuthorTypes.PERSONA }],
      edited: [
        { actorId: owner, actorType: AuthorTypes.USER, payload: { seq: 1, touchedBlockIds: [target.attrs!.blockId] } },
        {
          actorId: persona,
          actorType: AuthorTypes.PERSONA,
          payload: { seq: 2, touchedBlockIds: [target.attrs!.blockId], reason: "AWS key revoked after rotation" },
        },
      ],
      outbox: [
        { seq: 1, actor_type: AuthorTypes.USER },
        { seq: 2, actor_type: AuthorTypes.PERSONA },
      ],
    })
  })

  test("should insert, move, and delete blocks", async () => {
    const heading: JSONContent = {
      type: "heading",
      attrs: { level: 2, blockId: blockId() },
      content: [{ type: "text", text: "Rotation" }],
    }
    const aws = paragraph("AWS key is live")
    const { doc, ctx } = await createHostedDoc([heading, aws])
    const headingId = heading.attrs!.blockId as string
    const awsId = aws.attrs!.blockId as string

    const inserted = await agent.insertBlock(ctx, {
      docId: doc.id,
      reason: "Track GitHub",
      after: headingId,
      markdown: "- [ ] rotate GitHub token",
    })
    const afterInsert = await sectionMarkdown(doc.id)
    const moved = await agent.moveBlock(ctx, {
      docId: doc.id,
      reason: "Heading last",
      blockId: headingId,
      after: awsId,
    })
    const afterMove = await sectionMarkdown(doc.id)
    const deleted = await agent.deleteBlock(ctx, { docId: doc.id, reason: "AWS done", blockId: awsId })
    const insertedId = inserted.status === "applied" ? inserted.touchedBlockIds[0] : ""

    expect({ inserted, afterInsert, moved, afterMove, deleted, afterDelete: await sectionMarkdown(doc.id) }).toEqual({
      inserted: {
        status: "applied",
        docId: doc.id,
        title: null,
        seq: 2,
        touchedBlockIds: [insertedId],
        markdown: `<!-- ${insertedId} -->\n- [ ] rotate GitHub token`,
      },
      afterInsert: ["## Rotation", "- [ ] rotate GitHub token", "AWS key is live"],
      moved: {
        status: "applied",
        docId: doc.id,
        title: null,
        seq: 3,
        touchedBlockIds: [],
        markdown: `<!-- ${headingId} -->\n## Rotation`,
      },
      afterMove: ["- [ ] rotate GitHub token", "AWS key is live", "## Rotation"],
      deleted: { status: "applied", docId: doc.id, title: null, seq: 4, touchedBlockIds: [awsId], markdown: "" },
      afterDelete: ["- [ ] rotate GitHub token", "## Rotation"],
    })
  })

  test("should keep a human's in-flight edit on a neighbour block when the agent moves a sibling paragraph", async () => {
    const a = paragraph("Alpha")
    const b = paragraph("Bravo")
    const c = paragraph("Charlie")
    const { doc, ctx } = await createHostedDoc([a, b, c])
    const human = await draftClientUpdate(doc.id, ([first, second, third]) => [
      first,
      { ...second, content: [{ type: "text", text: "Bravo HUMAN" }] },
      third,
    ])

    const moved = await agent.moveBlock(ctx, {
      docId: doc.id,
      reason: "Alpha last",
      blockId: a.attrs!.blockId as string,
      after: c.attrs!.blockId as string,
    })
    await postClient(doc.id, human)

    const sections = await DocRepository.listSections(pool, wsId, doc.id)
    expect({
      moved: moved.status,
      sections: sections.map(({ blockId, markdown }) => ({ blockId, markdown })),
    }).toEqual({
      moved: "applied",
      sections: [
        { blockId: b.attrs!.blockId, markdown: "Bravo HUMAN" },
        { blockId: c.attrs!.blockId, markdown: "Charlie" },
        { blockId: a.attrs!.blockId, markdown: "Alpha" },
      ],
    })
  })

  test("should trim a retitle and refuse an empty one", async () => {
    const { doc, ctx } = await createHostedDoc([paragraph("AWS key is live")])

    const titled = await agent.setTitle(ctx, { docId: doc.id, title: "  Rotation tracker " })
    const emptyTitle = await agent.setTitle(ctx, { docId: doc.id, title: "  " })

    expect({ titled, emptyTitle, listed: (await agent.listDocs(ctx)).docs?.map((summary) => summary.title) }).toEqual({
      titled: { status: "applied", docId: doc.id, title: "Rotation tracker" },
      emptyTitle: { status: "refused", code: "title_empty" },
      listed: ["Rotation tracker"],
    })
  })

  test("should create a titled doc with a body and read it back", async () => {
    const { host, ctx } = await createHostedDoc([])

    const created = await agent.createDoc(ctx, {
      reason: "Start a checklist",
      title: " Checklist ",
      markdown: "## Steps\n\n1. Rotate",
    })
    if (created.status !== "created") throw new Error(`Expected a created doc, got ${created.status}`)
    const read = await readOk(ctx, created.docId)

    expect({
      created: { ...created, markdown: created.markdown.replace(/blk_\w+/g, "blk") },
      read: { ...read, markdown: read.markdown.replace(/blk_\w+/g, "blk") },
    }).toEqual({
      created: {
        status: "created",
        docId: created.docId,
        hostStreamId: host.id,
        title: "Checklist",
        seq: 1,
        createdAt: expect.any(Date),
        markdown: "<!-- blk -->\n## Steps\n\n<!-- blk -->\n1. Rotate",
      },
      read: {
        status: "ok",
        docId: created.docId,
        hostStreamId: host.id,
        title: "Checklist",
        seq: 1,
        createdAt: expect.any(Date),
        markdown: "<!-- blk -->\n## Steps\n\n<!-- blk -->\n1. Rotate",
      },
    })
  })

  test("should leave a blank title untitled and keep the doc id when the body write throws", async () => {
    const { host, ctx } = await createHostedDoc([])
    const rewrite = spyOn(docService, "applyAgentRewrite").mockRejectedValueOnce(new Error("db down"))

    const created = await agent.createDoc(ctx, { reason: "Start a checklist", title: "   ", markdown: "1. Rotate" })
    rewrite.mockRestore()
    if (created.status !== "created") throw new Error(`Expected a created doc, got ${created.status}`)

    expect({ created, docs: await agent.listDocs(ctx) }).toEqual({
      created: {
        status: "created",
        docId: created.docId,
        hostStreamId: host.id,
        title: null,
        seq: 0,
        createdAt: expect.any(Date),
        markdown: "",
        body: { status: "error" },
      },
      docs: {
        status: "ok",
        docs: expect.arrayContaining([
          { docId: created.docId, hostStreamId: host.id, title: null, seq: 0, createdAt: expect.any(Date) },
        ]),
      },
    })
  })

  test("should store nothing for an edit that changes nothing", async () => {
    const target = paragraph("AWS key is live")
    const { doc, ctx } = await createHostedDoc([target])

    const result = await agent.editDoc(ctx, {
      docId: doc.id,
      reason: "No-op",
      edits: [{ old: "AWS key is live", new: "AWS key is live  " }],
    })

    expect({
      result,
      edits: (await StreamEventRepository.list(pool, wsId, doc.id, { types: ["doc:edited"] })).map((e) => e.payload),
      outbox: await docUpdatedOutbox(doc.id),
    }).toEqual({
      result: { status: "unchanged", docId: doc.id, title: null, seq: 1 },
      edits: [{ seq: 1, touchedBlockIds: [target.attrs!.blockId] }],
      outbox: [{ seq: 1, actor_type: AuthorTypes.USER }],
    })
  })

  test("should tolerate block markers copied into the anchor", async () => {
    const target = paragraph("GCP key is live")
    const { doc, ctx } = await createHostedDoc([paragraph("AWS key is live"), target])
    const copied = (await readOk(ctx, doc.id)).markdown.split("\n\n")[1]

    const result = await agent.editDoc(ctx, {
      docId: doc.id,
      reason: "Revoke GCP",
      edits: [{ old: copied, new: `<!-- ${target.attrs!.blockId} -->\nGCP key is revoked` }],
    })

    expect({ status: result.status, copied, sections: await sectionMarkdown(doc.id) }).toEqual({
      status: "applied",
      copied: `<!-- ${target.attrs!.blockId} -->\nGCP key is live`,
      sections: ["AWS key is live", "GCP key is revoked"],
    })
  })

  test("should create, read and edit a top-level doc, which only its readers reach", async () => {
    const topLevel = (userId: string): DocAgentContext => ({
      workspaceId: wsId,
      hostStreamId: null,
      principal: { kind: "user", userId },
      actor: { actorId: persona, actorType: AuthorTypes.PERSONA },
    })
    const ctx = topLevel(owner)

    const open = await agent.createDoc(ctx, { reason: "Start a plan", title: "Plan", visibility: "public" })
    const closed = await agent.createDoc(ctx, { reason: "Start notes", markdown: "Private notes" })
    if (open.status !== "created" || closed.status !== "created") throw new Error("Expected both docs created")
    const edited = await agent.editDoc(ctx, {
      docId: closed.docId,
      reason: "Tighten",
      edits: [{ old: "Private notes", new: "Private notes, kept short" }],
    })
    const [openRow, closedRow] = await Promise.all([
      StreamRepository.findById(pool, wsId, open.docId),
      StreamRepository.findById(pool, wsId, closed.docId),
    ])

    expect({
      open: { hostStreamId: open.hostStreamId, visibility: openRow?.visibility, parent: openRow?.parentStreamId },
      closed: { hostStreamId: closed.hostStreamId, visibility: closedRow?.visibility },
      edited: edited.status,
      markdown: await sectionMarkdown(closed.docId),
      outsiderReadsOpen: (await agent.readDoc(topLevel(outsider), { docId: open.docId })).status,
      outsiderReadsClosed: (await agent.readDoc(topLevel(outsider), { docId: closed.docId })).status,
    }).toEqual({
      open: { hostStreamId: null, visibility: "public", parent: null },
      closed: { hostStreamId: null, visibility: "private" },
      edited: "applied",
      markdown: ["Private notes, kept short"],
      outsiderReadsOpen: "ok",
      outsiderReadsClosed: "not_found",
    })
  })
})
