import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import type { JSONContent } from "@threahq/types"
import { setupTestDatabase, withTransaction } from "./setup"
import {
  MESSAGE_REFERENCE_PINS_BACKFILL_NAME,
  MessageRepository,
  MessageVersionRepository,
  messageVersionKey,
  registerMessageReferencePinsBackfill,
  sliceReferenceContent,
} from "../../src/features/messaging"
import {
  plan as planSearchConfig,
  processChunk as processSearchConfig,
} from "../../src/features/messaging/search-config-backfill"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { getBackfill } from "../../src/lib/backfill"
import {
  draftId,
  messageId,
  messageVersionId,
  scheduledMessageId,
  streamId,
  userId,
  workspaceId,
} from "../../src/lib/id"
import { DEFAULT_SEARCH_CONFIG } from "../../src/lib/text-search-config"

const SWEDISH_TEXT = "Jag har skickat fakturorna nu, säg till om något saknas"

function docOf(text: string): JSONContent {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }
}

function withLegacyQuote(sourceId: string, sourceStreamId: string, snippet: string, author: string): JSONContent {
  return {
    type: "doc",
    content: [
      {
        type: "quoteReply",
        attrs: { messageId: sourceId, streamId: sourceStreamId, authorName: "Author", authorId: author, snippet },
      },
      ...docOf("reply").content!,
    ],
  }
}

function quoteAttrs(content: JSONContent): unknown {
  return content.content?.find((node) => node.type === "quoteReply")?.attrs
}

function sorted(values: Iterable<string>) {
  return [...values].sort()
}

describe("MessageVersionRepository and messaging backfill workspace scope (INV-8)", () => {
  let pool: Pool

  let wsA: string
  let wsB: string
  let author: string
  let bAuthor: string
  let streamA: string
  let streamB: string

  let source: string
  let bMessage: string
  let bOnlySource: string
  let bHost: string
  let bLegacyInA: string
  let quoteHolder: string
  let quoteHolderWithDecoy: string
  let versionQuoteHolder: string
  let insertTarget: string
  let aDraft: string
  let bDraft: string
  let aScheduled: string
  let bScheduled: string
  let searchConfigA1: string
  let searchConfigA2: string
  let searchConfigBInA: string

  const aMessageIds: string[] = []
  const aVersionIdsUnderAMessages: string[] = []
  const versionIds: Record<string, string> = {}

  let sequence = 0

  async function seedWorkspace(label: string) {
    const id = workspaceId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id,
        name: `Message version scope ${label}`,
        slug: `message-version-scope-${label}-${id}`,
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

  async function addStream(wid: string) {
    const id = streamId()
    await insertRow("streams", {
      id,
      workspace_id: wid,
      type: "channel",
      slug: `message-version-scope-${id}`,
      created_by: author,
    })
    return id
  }

  async function addMessage(
    wid: string,
    stream: string,
    options: { revision?: number; content?: JSONContent; markdown?: string; searchConfig?: string | null } = {}
  ) {
    const id = messageId()
    await insertRow("messages", {
      id,
      workspace_id: wid,
      stream_id: stream,
      sequence: ++sequence,
      author_id: wid === wsB ? bAuthor : author,
      author_type: "user",
      content_markdown: options.markdown ?? `text ${id}`,
      content_json: options.content ?? docOf(`text ${id}`),
      revision: options.revision ?? 1,
      search_config: options.searchConfig === undefined ? DEFAULT_SEARCH_CONFIG : options.searchConfig,
    })
    if (wid === wsA) aMessageIds.push(id)
    return id
  }

  async function addVersion(
    wid: string,
    message: string,
    versionNumber: number,
    options: { content?: JSONContent; markdown?: string } = {}
  ) {
    const id = messageVersionId()
    await insertRow("message_versions", {
      id,
      workspace_id: wid,
      message_id: message,
      version_number: versionNumber,
      content_json: options.content ?? docOf(`version ${versionNumber}`),
      content_markdown: options.markdown ?? `version ${versionNumber}`,
      edited_by: wid === wsB ? bAuthor : author,
    })
    return id
  }

  async function storedContent(table: string, id: string): Promise<JSONContent> {
    const result = await pool.query<{ content_json: JSONContent }>(`SELECT content_json FROM ${table} WHERE id = $1`, [
      id,
    ])
    return result.rows[0]!.content_json
  }

  async function storedSearchConfig(id: string) {
    const result = await pool.query<{ search_config: string | null }>(
      `SELECT search_config FROM messages WHERE id = $1`,
      [id]
    )
    return result.rows[0]!.search_config
  }

  async function storedVersions(message: string) {
    const result = await pool.query(
      `SELECT workspace_id, version_number FROM message_versions WHERE message_id = $1 ORDER BY version_number`,
      [message]
    )
    return result.rows.map((row) => ({ workspaceId: row.workspace_id, versionNumber: row.version_number }))
  }

  async function planByTable(wid: string) {
    const definition = getBackfill(MESSAGE_REFERENCE_PINS_BACKFILL_NAME)
    if (!definition) throw new Error("message-reference-pins backfill is not registered")
    const byTable: Record<string, string[]> = {}
    for (const chunk of (await definition.plan({ pool }, wid)) as Array<{ table: string; ids: string[] }>) {
      byTable[chunk.table] = [...(byTable[chunk.table] ?? []), ...chunk.ids]
    }
    return Object.fromEntries(Object.entries(byTable).map(([table, ids]) => [table, sorted(ids)]))
  }

  async function processReferencePins(wid: string, chunk: { table: string; ids: string[] }) {
    const definition = getBackfill(MESSAGE_REFERENCE_PINS_BACKFILL_NAME)
    if (!definition) throw new Error("message-reference-pins backfill is not registered")
    return definition.processChunk({ pool }, wid, chunk)
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    registerMessageReferencePinsBackfill()

    wsA = await seedWorkspace("a")
    wsB = await seedWorkspace("b")
    author = userId()
    bAuthor = userId()
    streamA = await addStream(wsA)
    streamB = await addStream(wsB)

    source = await addMessage(wsA, streamA, { revision: 4, content: docOf("current body"), markdown: "current body" })
    versionIds.a1 = await addVersion(wsA, source, 1, {
      content: docOf("alpha original text"),
      markdown: "alpha original text",
    })
    versionIds.a2 = await addVersion(wsA, source, 2, {
      content: docOf("beta middle text"),
      markdown: "beta middle text",
    })
    aVersionIdsUnderAMessages.push(versionIds.a1, versionIds.a2)

    bMessage = await addMessage(wsB, streamB, { revision: 2 })
    versionIds.bOwn = await addVersion(wsB, bMessage, 1)
    bOnlySource = await addMessage(wsB, streamB)
    bHost = await addMessage(wsB, streamB)

    // Decoys under A's message id: B version rows with a higher number, and one a dropped pin would use as a
    // revision to pin a quote to.
    versionIds.bDecoy3 = await addVersion(wsB, source, 3, {
      content: docOf("gamma secret decoy"),
      markdown: "gamma secret decoy",
    })
    versionIds.bDecoy7 = await addVersion(wsB, source, 7, {
      content: withLegacyQuote(bOnlySource, streamB, "x", bAuthor),
    })

    quoteHolder = await addMessage(wsA, streamA, { content: withLegacyQuote(source, streamA, "alpha", author) })
    quoteHolderWithDecoy = await addMessage(wsA, streamA, {
      content: withLegacyQuote(source, streamA, "gamma secret decoy", author),
    })
    bLegacyInA = await addMessage(wsB, streamA, { content: withLegacyQuote(bOnlySource, streamB, "x", bAuthor) })

    const versionQuoteParent = await addMessage(wsA, streamA, { revision: 2 })
    versionQuoteHolder = await addVersion(wsA, versionQuoteParent, 1, {
      content: withLegacyQuote(source, streamA, "alpha", author),
    })
    aVersionIdsUnderAMessages.push(versionQuoteHolder)
    versionIds.aUnderB = await addVersion(wsA, bHost, 1, {
      content: withLegacyQuote(source, streamA, "alpha", author),
    })

    const draftRow = (wid: string, content: JSONContent) => ({
      id: draftId(),
      workspace_id: wid,
      user_id: wid === wsB ? bAuthor : author,
      scope: `stream:${streamA}`,
      content_json: content,
      content_markdown: "reply",
      client_updated_at: new Date(),
    })
    const scheduledRow = (wid: string, content: JSONContent) => ({
      id: scheduledMessageId(),
      workspace_id: wid,
      user_id: wid === wsB ? bAuthor : author,
      stream_id: streamA,
      content_json: content,
      content_markdown: "reply",
      scheduled_for: new Date(Date.now() + 3_600_000),
    })
    const aDraftRow = draftRow(wsA, withLegacyQuote(source, streamA, "alpha", author))
    const bDraftRow = draftRow(wsB, withLegacyQuote(bOnlySource, streamB, "x", bAuthor))
    const aScheduledRow = scheduledRow(wsA, withLegacyQuote(source, streamA, "alpha", author))
    const bScheduledRow = scheduledRow(wsB, withLegacyQuote(bOnlySource, streamB, "x", bAuthor))
    await insertRow("drafts", aDraftRow)
    await insertRow("drafts", bDraftRow)
    await insertRow("scheduled_messages", aScheduledRow)
    await insertRow("scheduled_messages", bScheduledRow)
    aDraft = aDraftRow.id
    bDraft = bDraftRow.id
    aScheduled = aScheduledRow.id
    bScheduled = bScheduledRow.id

    insertTarget = await addMessage(wsA, streamA, { revision: 2 })
    versionIds.insertA1 = await addVersion(wsA, insertTarget, 1)
    aVersionIdsUnderAMessages.push(versionIds.insertA1)
    await addVersion(wsB, insertTarget, 5)

    searchConfigA1 = await addMessage(wsA, streamA, { markdown: SWEDISH_TEXT, searchConfig: null })
    searchConfigA2 = await addMessage(wsA, streamA, { markdown: "Plain english text", searchConfig: null })
    searchConfigBInA = await addMessage(wsB, streamA, { markdown: SWEDISH_TEXT, searchConfig: null })
  })

  afterEach(() => {
    mock.restore()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should load only its own workspace's snapshots when finding by message versions", async () => {
    const found = await MessageVersionRepository.findByMessageVersions(pool, wsA, [
      { messageId: source, versionNumber: 1 },
      { messageId: source, versionNumber: 3 },
      { messageId: bMessage, versionNumber: 1 },
    ])
    expect(Object.fromEntries([...found].map(([key, version]) => [key, version.id]))).toEqual({
      [messageVersionKey(source, 1)]: versionIds.a1,
    })
  })

  test("should return only its own workspace's history when finding by message ids", async () => {
    const found = await MessageVersionRepository.findByMessageIds(pool, wsA, [source, bMessage])
    expect(Object.fromEntries([...found].map(([id, versions]) => [id, versions.map((v) => v.id)]))).toEqual({
      [source]: [versionIds.a1, versionIds.a2],
    })
  })

  test("should list only its own workspace's history when listing by message id", async () => {
    const ids = async (wid: string, id: string) =>
      (await MessageVersionRepository.listByMessageId(pool, wid, id)).map((v) => v.id)
    expect({
      own: await ids(wsA, source),
      foreignId: await ids(wsA, bMessage),
      otherWorkspaceCopies: await ids(wsB, source),
    }).toEqual({
      own: [versionIds.a1, versionIds.a2],
      foreignId: [],
      otherWorkspaceCopies: [versionIds.bDecoy3, versionIds.bDecoy7],
    })
  })

  test("should skip another workspace's snapshots when finding by version numbers", async () => {
    const found = await MessageVersionRepository.findByVersionNumbers(pool, wsA, source, [1, 2, 3, 7])
    expect(sorted(found.map((v) => v.id))).toEqual(sorted([versionIds.a1, versionIds.a2]))
  })

  test("should return its own newest snapshot when another workspace's is newer", async () => {
    const latestId = async (wid: string, id: string) =>
      (await MessageVersionRepository.findLatestByMessageId(pool, wid, id))?.id ?? null
    expect({
      own: await latestId(wsA, source),
      foreignId: await latestId(wsA, bMessage),
      otherWorkspaceCopies: await latestId(wsB, source),
    }).toEqual({ own: versionIds.a2, foreignId: null, otherWorkspaceCopies: versionIds.bDecoy7 })
  })

  test("should not return another workspace's revision when reading the current revision", async () => {
    expect({
      own: await MessageVersionRepository.getCurrentRevision(pool, wsA, source),
      foreignId: await MessageVersionRepository.getCurrentRevision(pool, wsA, bMessage),
      foreignWorkspace: await MessageVersionRepository.getCurrentRevision(pool, wsB, source),
    }).toEqual({ own: 4, foreignId: null, foreignWorkspace: null })
  })

  test("should plan only its own workspace's rows when planning the reference pins backfill", async () => {
    expect(await planByTable(wsA)).toEqual({
      messages: sorted(aMessageIds),
      message_versions: sorted(aVersionIdsUnderAMessages),
      scheduled_messages: [aScheduled],
      drafts: [aDraft],
    })
  })

  test("should read and rewrite only its own workspace's messages when a chunk names another workspace's id", async () => {
    const findByIds = spyOn(MessageRepository, "findByIds")
    const keepOriginal = await storedContent("messages", quoteHolderWithDecoy)
    const keepForeign = await storedContent("messages", bLegacyInA)

    const result = await processReferencePins(wsA, {
      table: "messages",
      ids: [quoteHolder, quoteHolderWithDecoy, bLegacyInA],
    })

    const range = { from: 1, to: 6 }
    expect({
      result,
      pinned: quoteAttrs(await storedContent("messages", quoteHolder)),
      unlocatable: await storedContent("messages", quoteHolderWithDecoy),
      foreign: await storedContent("messages", bLegacyInA),
      lookups: findByIds.mock.calls.map(([, wid, ids]) => ({ workspaceId: wid, ids })),
    }).toEqual({
      result: { processed: 1 },
      pinned: {
        messageId: source,
        streamId: streamA,
        authorName: "Author",
        authorId: author,
        snippet: sliceReferenceContent(docOf("alpha original text"), range).contentMarkdown,
        version: 1,
        range,
      },
      unlocatable: keepOriginal,
      foreign: keepForeign,
      lookups: [{ workspaceId: wsA, ids: [source] }],
    })
  })

  test("should read and rewrite only its own workspace's versions when a chunk names another workspace's id", async () => {
    const findByIds = spyOn(MessageRepository, "findByIds")
    const keepForeignCopy = await storedContent("message_versions", versionIds.bDecoy7)
    const keepOrphan = await storedContent("message_versions", versionIds.aUnderB)

    const result = await processReferencePins(wsA, {
      table: "message_versions",
      ids: [versionQuoteHolder, versionIds.bDecoy7, versionIds.aUnderB],
    })

    const range = { from: 1, to: 6 }
    expect({
      result,
      pinned: quoteAttrs(await storedContent("message_versions", versionQuoteHolder)),
      foreignCopy: await storedContent("message_versions", versionIds.bDecoy7),
      orphan: await storedContent("message_versions", versionIds.aUnderB),
      lookups: findByIds.mock.calls.map(([, wid, ids]) => ({ workspaceId: wid, ids })),
    }).toEqual({
      result: { processed: 1 },
      pinned: {
        messageId: source,
        streamId: streamA,
        authorName: "Author",
        authorId: author,
        snippet: sliceReferenceContent(docOf("alpha original text"), range).contentMarkdown,
        version: 1,
        range,
      },
      foreignCopy: keepForeignCopy,
      orphan: keepOrphan,
      lookups: [{ workspaceId: wsA, ids: [source] }],
    })
  })

  async function processOwnAndForeign(table: "drafts" | "scheduled_messages", own: string, foreign: string) {
    const findByIds = spyOn(MessageRepository, "findByIds")
    const keepForeign = await storedContent(table, foreign)

    const result = await processReferencePins(wsA, { table, ids: [own, foreign] })

    const range = { from: 1, to: 6 }
    expect({
      result,
      pinned: quoteAttrs(await storedContent(table, own)),
      foreign: await storedContent(table, foreign),
      lookups: findByIds.mock.calls.map(([, wid, ids]) => ({ workspaceId: wid, ids })),
    }).toEqual({
      result: { processed: 1 },
      pinned: {
        messageId: source,
        streamId: streamA,
        authorName: "Author",
        authorId: author,
        snippet: sliceReferenceContent(docOf("alpha original text"), range).contentMarkdown,
        version: 1,
        range,
      },
      foreign: keepForeign,
      lookups: [{ workspaceId: wsA, ids: [source] }],
    })
  }

  test("should read and rewrite only its own workspace's drafts when a chunk names another workspace's id", async () => {
    await processOwnAndForeign("drafts", aDraft, bDraft)
  })

  test("should read and rewrite only its own workspace's scheduled messages when a chunk names another workspace's id", async () => {
    await processOwnAndForeign("scheduled_messages", aScheduled, bScheduled)
  })

  test("should plan only its own workspace's messages when planning the search config backfill", async () => {
    const chunks = await planSearchConfig({ pool }, wsA)
    expect(sorted(chunks.flatMap((chunk) => chunk.ids))).toEqual(sorted([searchConfigA1, searchConfigA2]))
  })

  test("should read and fill only its own workspace's messages when a chunk names another workspace's id", async () => {
    const fill = spyOn(MessageRepository, "fillMissingSearchConfigs")

    const result = await processSearchConfig({ pool }, wsA, { ids: [searchConfigA1, searchConfigBInA] })

    expect({
      result,
      stored: {
        own: await storedSearchConfig(searchConfigA1),
        foreign: await storedSearchConfig(searchConfigBInA),
      },
      fills: fill.mock.calls.map(([, wid, rows]) => ({ workspaceId: wid, rows })),
    }).toEqual({
      result: { processed: 1 },
      stored: { own: "swedish", foreign: null },
      fills: [{ workspaceId: wsA, rows: [{ id: searchConfigA1, searchConfig: "swedish" }] }],
    })
  })

  test("should compute the next version number from its own workspace's history when inserting", async () => {
    const inserted = await MessageVersionRepository.insert(pool, {
      id: messageVersionId(),
      workspaceId: wsA,
      messageId: insertTarget,
      versionNumber: 1,
      contentJson: docOf("edited"),
      contentMarkdown: "edited",
      editedBy: author,
    })
    expect({ inserted: inserted.versionNumber, stored: await storedVersions(insertTarget) }).toEqual({
      inserted: 2,
      stored: [
        { workspaceId: wsA, versionNumber: 1 },
        { workspaceId: wsA, versionNumber: 2 },
        { workspaceId: wsB, versionNumber: 5 },
      ],
    })
  })
})
