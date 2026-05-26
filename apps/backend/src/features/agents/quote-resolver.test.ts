import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from "bun:test"
import type { JSONContent } from "@threa/types"
import type { Querier } from "../../db"
import { MessageRepository, type Message } from "../messaging"
import { UserRepository } from "../workspaces"
import { PersonaRepository } from "./persona-repository"
import { resolveQuoteReplies, renderMessageWithQuoteContext, extractAppendedQuoteContext } from "./quote-resolver"

const mockClient = {} as Querier

function paragraph(text: string): JSONContent {
  return { type: "paragraph", content: [{ type: "text", text }] }
}

function quoteReplyNode(messageId: string, streamId = "stream_src"): JSONContent {
  return {
    type: "quoteReply",
    attrs: {
      messageId,
      streamId,
      authorName: "Quoted Author",
      authorId: "usr_quoted",
      actorType: "user",
      snippet: `snippet for ${messageId}`,
    },
  }
}

function doc(...nodes: JSONContent[]): JSONContent {
  return { type: "doc", content: nodes }
}

function createMessage(overrides: Partial<Message> & { id: string }): Message {
  const base: Message = {
    id: overrides.id,
    streamId: "stream_main",
    sequence: 1n,
    authorId: "usr_alice",
    authorType: "user",
    contentJson: doc(paragraph(`body of ${overrides.id}`)),
    contentMarkdown: `body of ${overrides.id}`,
    replyCount: 0,
    reactions: {},
    metadata: {},
    clientMessageId: null,
    sentVia: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date("2024-01-01T10:00:00Z"),
    ciphertext: null,
    envelope: null,
    e2eVersion: null,
  }
  return { ...base, ...overrides }
}

const mockFindByIdsInStreams = mock((_db: Querier, _ids: string[], _streamIds: string[]) =>
  Promise.resolve(new Map<string, Message>())
)
const mockFindUsersByIds = mock(() => Promise.resolve([] as { id: string; name: string }[]))
const mockFindPersonasByIds = mock(() => Promise.resolve([] as { id: string; name: string }[]))

function primeUsers(byId: Record<string, string>): void {
  mockFindUsersByIds.mockResolvedValue(Object.entries(byId).map(([id, name]) => ({ id, name })))
}

describe("resolveQuoteReplies", () => {
  beforeEach(() => {
    mockFindByIdsInStreams.mockReset()
    mockFindUsersByIds.mockReset()
    mockFindPersonasByIds.mockReset()
    mockFindUsersByIds.mockResolvedValue([])
    mockFindPersonasByIds.mockResolvedValue([])
    spyOn(MessageRepository, "findByIdsInStreams").mockImplementation(mockFindByIdsInStreams as never)
    spyOn(UserRepository, "findByIds").mockImplementation(mockFindUsersByIds as never)
    spyOn(PersonaRepository, "findByIds").mockImplementation(mockFindPersonasByIds as never)
  })

  afterEach(() => mock.restore())

  test("resolves a single direct precursor", async () => {
    const seed = createMessage({
      id: "msg_A",
      contentJson: doc(quoteReplyNode("msg_B"), paragraph("reply text")),
    })
    const precursor = createMessage({ id: "msg_B", contentMarkdown: "original" })
    mockFindByIdsInStreams.mockResolvedValueOnce(new Map([["msg_B", precursor]]))
    primeUsers({ usr_alice: "Alice" })

    const { resolved } = await resolveQuoteReplies(mockClient, "ws_test", {
      seedMessages: [seed],
      accessibleStreamIds: new Set(["stream_main"]),
    })

    expect(resolved.size).toBe(1)
    expect(resolved.get("msg_B")?.id).toBe("msg_B")
    expect(mockFindByIdsInStreams).toHaveBeenCalledTimes(1)
    expect(mockFindByIdsInStreams.mock.calls[0][1]).toEqual(["msg_B"])
  })

  test("follows a depth chain up to maxDepth=5", async () => {
    // A quotes B, B quotes C, C quotes D, D quotes E, E quotes F, F quotes G
    const seed = createMessage({ id: "msg_A", contentJson: doc(quoteReplyNode("msg_B")) })
    const b = createMessage({ id: "msg_B", contentJson: doc(quoteReplyNode("msg_C")) })
    const c = createMessage({ id: "msg_C", contentJson: doc(quoteReplyNode("msg_D")) })
    const d = createMessage({ id: "msg_D", contentJson: doc(quoteReplyNode("msg_E")) })
    const e = createMessage({ id: "msg_E", contentJson: doc(quoteReplyNode("msg_F")) })
    const f = createMessage({ id: "msg_F", contentJson: doc(quoteReplyNode("msg_G")) })

    mockFindByIdsInStreams
      .mockResolvedValueOnce(new Map([["msg_B", b]]))
      .mockResolvedValueOnce(new Map([["msg_C", c]]))
      .mockResolvedValueOnce(new Map([["msg_D", d]]))
      .mockResolvedValueOnce(new Map([["msg_E", e]]))
      .mockResolvedValueOnce(new Map([["msg_F", f]]))
    primeUsers({ usr_alice: "Alice" })

    const { resolved } = await resolveQuoteReplies(mockClient, "ws_test", {
      seedMessages: [seed],
      accessibleStreamIds: new Set(["stream_main"]),
      maxDepth: 5,
    })

    // Should resolve B through F (5 hops), stop before G
    expect([...resolved.keys()].sort()).toEqual(["msg_B", "msg_C", "msg_D", "msg_E", "msg_F"])
    expect(mockFindByIdsInStreams).toHaveBeenCalledTimes(5)
  })

  test("cycle detection: A → B → A terminates", async () => {
    const seed = createMessage({ id: "msg_A", contentJson: doc(quoteReplyNode("msg_B")) })
    // B has been edited to quote A back
    const b = createMessage({ id: "msg_B", contentJson: doc(quoteReplyNode("msg_A")) })
    mockFindByIdsInStreams.mockResolvedValueOnce(new Map([["msg_B", b]]))

    const { resolved } = await resolveQuoteReplies(mockClient, "ws_test", {
      seedMessages: [seed],
      accessibleStreamIds: new Set(["stream_main"]),
    })

    expect([...resolved.keys()]).toEqual(["msg_B"])
    // Only one fetch: A is the seed (visited), B's quote of A is a cycle
    expect(mockFindByIdsInStreams).toHaveBeenCalledTimes(1)
  })

  test("self-cycle: message that quotes itself is skipped entirely", async () => {
    const seed = createMessage({ id: "msg_A", contentJson: doc(quoteReplyNode("msg_A")) })

    const { resolved } = await resolveQuoteReplies(mockClient, "ws_test", {
      seedMessages: [seed],
      accessibleStreamIds: new Set(["stream_main"]),
    })

    expect(resolved.size).toBe(0)
    expect(mockFindByIdsInStreams).not.toHaveBeenCalled()
  })

  test("adjacent seeds referencing each other are not refetched", async () => {
    const a = createMessage({ id: "msg_A", contentJson: doc(quoteReplyNode("msg_B")) })
    const b = createMessage({ id: "msg_B", contentMarkdown: "body B" })

    const { resolved } = await resolveQuoteReplies(mockClient, "ws_test", {
      seedMessages: [a, b],
      accessibleStreamIds: new Set(["stream_main"]),
    })

    expect(resolved.size).toBe(0) // B is already a seed, visited before walking
    expect(mockFindByIdsInStreams).not.toHaveBeenCalled()
  })

  test("deduplicates when multiple messages quote the same precursor", async () => {
    const a = createMessage({ id: "msg_A", contentJson: doc(quoteReplyNode("msg_B")) })
    const c = createMessage({ id: "msg_C", contentJson: doc(quoteReplyNode("msg_B")) })
    const b = createMessage({ id: "msg_B", contentMarkdown: "body B" })
    mockFindByIdsInStreams.mockResolvedValueOnce(new Map([["msg_B", b]]))

    const { resolved } = await resolveQuoteReplies(mockClient, "ws_test", {
      seedMessages: [a, c],
      accessibleStreamIds: new Set(["stream_main"]),
    })

    expect([...resolved.keys()]).toEqual(["msg_B"])
    expect(mockFindByIdsInStreams).toHaveBeenCalledTimes(1)
    expect(mockFindByIdsInStreams.mock.calls[0][1]).toEqual(["msg_B"])
  })

  test("multiple distinct precursors in one message are all resolved", async () => {
    const seed = createMessage({
      id: "msg_A",
      contentJson: doc(quoteReplyNode("msg_B"), quoteReplyNode("msg_C"), paragraph("tail")),
    })
    const b = createMessage({ id: "msg_B", contentMarkdown: "body B" })
    const c = createMessage({ id: "msg_C", contentMarkdown: "body C" })
    mockFindByIdsInStreams.mockResolvedValueOnce(
      new Map([
        ["msg_B", b],
        ["msg_C", c],
      ])
    )

    const { resolved } = await resolveQuoteReplies(mockClient, "ws_test", {
      seedMessages: [seed],
      accessibleStreamIds: new Set(["stream_main"]),
    })

    expect([...resolved.keys()].sort()).toEqual(["msg_B", "msg_C"])
    expect(mockFindByIdsInStreams.mock.calls[0][1]).toEqual(["msg_B", "msg_C"])
  })

  test("access-denied or soft-deleted precursors are filtered at the SQL layer", async () => {
    const seed = createMessage({ id: "msg_A", contentJson: doc(quoteReplyNode("msg_B")) })
    // findByIdsInStreams filters at the SQL level; we simulate by returning an empty map
    mockFindByIdsInStreams.mockResolvedValueOnce(new Map())

    const { resolved } = await resolveQuoteReplies(mockClient, "ws_test", {
      seedMessages: [seed],
      accessibleStreamIds: new Set(["stream_main"]),
    })

    expect(resolved.size).toBe(0)
    expect(mockFindByIdsInStreams).toHaveBeenCalledTimes(1)
  })

  test("passes accessibleStreamIds to the SQL-level filter", async () => {
    const seed = createMessage({ id: "msg_A", contentJson: doc(quoteReplyNode("msg_B")) })
    mockFindByIdsInStreams.mockResolvedValueOnce(new Map())

    await resolveQuoteReplies(mockClient, "ws_test", {
      seedMessages: [seed],
      accessibleStreamIds: new Set(["stream_main", "stream_other"]),
    })

    const streamIdsArg = mockFindByIdsInStreams.mock.calls[0][2]
    expect(new Set(streamIdsArg)).toEqual(new Set(["stream_main", "stream_other"]))
  })

  test("maxTotalResolved caps total precursors fetched", async () => {
    // Seed with many direct quotes to test the total cap
    const manyQuotes = Array.from({ length: 10 }, (_, i) => quoteReplyNode(`msg_B${i}`))
    const seed = createMessage({ id: "msg_A", contentJson: doc(...manyQuotes) })
    // Only return the first 3 (simulating the cap)
    mockFindByIdsInStreams.mockImplementation((_db, ids) => {
      const result = new Map<string, Message>()
      for (const id of ids) {
        result.set(id, createMessage({ id, contentMarkdown: `body ${id}` }))
      }
      return Promise.resolve(result)
    })

    const { resolved } = await resolveQuoteReplies(mockClient, "ws_test", {
      seedMessages: [seed],
      accessibleStreamIds: new Set(["stream_main"]),
      maxTotalResolved: 3,
    })

    expect(resolved.size).toBe(3)
    // Only the first 3 IDs should have been fetched
    expect(mockFindByIdsInStreams.mock.calls[0][1]).toEqual(["msg_B0", "msg_B1", "msg_B2"])
  })

  test("batch resolves author names for all precursors", async () => {
    const seed = createMessage({ id: "msg_A", contentJson: doc(quoteReplyNode("msg_B")) })
    const b = createMessage({ id: "msg_B", authorId: "usr_bob", contentMarkdown: "body B" })
    mockFindByIdsInStreams.mockResolvedValueOnce(new Map([["msg_B", b]]))
    primeUsers({ usr_bob: "Bob" })

    const { authorNames } = await resolveQuoteReplies(mockClient, "ws_test", {
      seedMessages: [seed],
      accessibleStreamIds: new Set(["stream_main"]),
    })

    expect(authorNames.get("usr_bob")).toBe("Bob")
    expect(mockFindUsersByIds).toHaveBeenCalledWith(mockClient, "ws_test", ["usr_bob"])
  })
})

describe("renderMessageWithQuoteContext", () => {
  test("returns base markdown when there are no quote references", () => {
    const m = createMessage({ id: "msg_A", contentMarkdown: "plain text" })
    const rendered = renderMessageWithQuoteContext(m, new Map(), new Map())
    expect(rendered).toBe("plain text")
  })

  test("appends a quoted-source block for a resolved precursor", () => {
    const seed = createMessage({
      id: "msg_A",
      contentJson: doc(quoteReplyNode("msg_B"), paragraph("my reply")),
      contentMarkdown:
        "> snippet for msg_B\n>\n> — [Quoted Author](quote:stream_src/msg_B/usr_quoted/user)\n\nmy reply",
    })
    const b = createMessage({
      id: "msg_B",
      streamId: "stream_src",
      authorId: "usr_bob",
      contentMarkdown: "The full original body of msg_B",
      createdAt: new Date("2024-01-01T09:00:00Z"),
    })
    const rendered = renderMessageWithQuoteContext(seed, new Map([["msg_B", b]]), new Map([["usr_bob", "Bob"]]))

    expect(rendered).toContain(seed.contentMarkdown)
    expect(rendered).toContain(
      '<quoted-source id="msg_B" author="Bob" streamId="stream_src" createdAt="2024-01-01T09:00:00.000Z">'
    )
    expect(rendered).toContain("The full original body of msg_B")
    expect(rendered).toContain("</quoted-source>")
  })

  test("nests quoted-source blocks for chained precursors", () => {
    const a = createMessage({ id: "msg_A", contentJson: doc(quoteReplyNode("msg_B")), contentMarkdown: "A body" })
    const b = createMessage({
      id: "msg_B",
      contentJson: doc(quoteReplyNode("msg_C")),
      contentMarkdown: "B body",
      authorId: "usr_bob",
    })
    const c = createMessage({ id: "msg_C", contentMarkdown: "C body", authorId: "usr_carol" })

    const rendered = renderMessageWithQuoteContext(
      a,
      new Map([
        ["msg_B", b],
        ["msg_C", c],
      ]),
      new Map([
        ["usr_bob", "Bob"],
        ["usr_carol", "Carol"],
      ])
    )

    // B is inside A, C is inside B
    const bIdx = rendered.indexOf('id="msg_B"')
    const cIdx = rendered.indexOf('id="msg_C"')
    expect(bIdx).toBeGreaterThan(-1)
    expect(cIdx).toBeGreaterThan(-1)
    expect(cIdx).toBeGreaterThan(bIdx)
    expect(rendered).toContain("C body")
  })

  test("stops expanding at maxDepth", () => {
    const a = createMessage({ id: "msg_A", contentJson: doc(quoteReplyNode("msg_B")), contentMarkdown: "A" })
    const b = createMessage({ id: "msg_B", contentJson: doc(quoteReplyNode("msg_C")), contentMarkdown: "B" })
    const c = createMessage({ id: "msg_C", contentMarkdown: "C" })

    const rendered = renderMessageWithQuoteContext(
      a,
      new Map([
        ["msg_B", b],
        ["msg_C", c],
      ]),
      new Map(),
      0,
      1
    )

    expect(rendered).toContain('id="msg_B"')
    expect(rendered).not.toContain('id="msg_C"')
  })

  test("silently skips unresolved precursor references", () => {
    const a = createMessage({
      id: "msg_A",
      contentJson: doc(quoteReplyNode("msg_B"), quoteReplyNode("msg_C")),
      contentMarkdown: "A body",
    })
    const b = createMessage({ id: "msg_B", contentMarkdown: "B body", authorId: "usr_bob" })
    // msg_C is NOT in the resolved map (e.g., filtered by access)

    const rendered = renderMessageWithQuoteContext(a, new Map([["msg_B", b]]), new Map([["usr_bob", "Bob"]]))

    expect(rendered).toContain('id="msg_B"')
    expect(rendered).not.toContain('id="msg_C"')
  })

  test("escapes XML special characters in author names", () => {
    const a = createMessage({ id: "msg_A", contentJson: doc(quoteReplyNode("msg_B")), contentMarkdown: "A" })
    const b = createMessage({ id: "msg_B", authorId: "usr_bob", contentMarkdown: "B" })

    const rendered = renderMessageWithQuoteContext(
      a,
      new Map([["msg_B", b]]),
      new Map([["usr_bob", 'Bob "The Builder" <bob@test>']])
    )

    expect(rendered).toContain('author="Bob &quot;The Builder&quot; &lt;bob@test&gt;"')
  })

  test("deduplicates when the same precursor is quoted twice", () => {
    const a = createMessage({
      id: "msg_A",
      contentJson: doc(quoteReplyNode("msg_B"), quoteReplyNode("msg_B")),
      contentMarkdown: "A",
    })
    const b = createMessage({ id: "msg_B", contentMarkdown: "B body", authorId: "usr_bob" })
    const rendered = renderMessageWithQuoteContext(a, new Map([["msg_B", b]]), new Map([["usr_bob", "Bob"]]))

    const matches = rendered.match(/id="msg_B"/g) ?? []
    expect(matches.length).toBe(1)
  })
})

describe("extractAppendedQuoteContext", () => {
  test("returns empty string when nothing was appended", () => {
    expect(extractAppendedQuoteContext("hello", "hello")).toBe("")
  })

  test("strips the base prefix and the \\n\\n separator", () => {
    const base = "A body"
    const rendered = 'A body\n\n<quoted-source id="msg_B">B body</quoted-source>'
    expect(extractAppendedQuoteContext(rendered, base)).toBe('<quoted-source id="msg_B">B body</quoted-source>')
  })
})
