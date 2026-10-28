import { afterEach, expect, spyOn, test } from "bun:test"
import { run } from "../cli"
import { fetchByPath, jsonResponse, TEST_CONFIG } from "../test-support"

const fetchSpy = spyOn(globalThis, "fetch")

afterEach(() => {
  fetchSpy.mockReset()
})

const STREAMS_LIST = "/api/v1/workspaces/ws_1/streams"
const DOCS = "/api/v1/workspaces/ws_1/docs"

function lastCall(): { method?: string; url: URL; body: unknown } {
  const call = fetchSpy.mock.calls.at(-1)!
  const init = call[1] as RequestInit
  return {
    method: init.method,
    url: new URL(String(call[0])),
    body: init.body ? JSON.parse(String(init.body)) : undefined,
  }
}

test("docs list resolves a #channel-slug and lists that stream's docs", async () => {
  fetchSpy.mockImplementation(
    fetchByPath((path) => {
      if (path === STREAMS_LIST) {
        return jsonResponse(200, { data: [{ id: "stream_gen", slug: "general" }], hasMore: false })
      }
      return jsonResponse(200, { data: [{ id: "stream_d1", hostStreamId: "stream_gen", title: null, seq: 3 }] })
    })
  )

  const result = await run(["docs", "list", "#general", "-o", "text"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(0)
  const call = lastCall()
  expect({ method: call.method, path: call.url.pathname, streamId: call.url.searchParams.get("streamId") }).toEqual({
    method: "GET",
    path: DOCS,
    streamId: "stream_gen",
  })
  expect(result.stdout).toContain("stream_d1  (untitled)  3  stream_gen")
})

test("docs list without a stream searches the workspace and hints the next cursor", async () => {
  fetchSpy.mockResolvedValue(
    jsonResponse(200, {
      data: [{ id: "stream_d2", hostStreamId: "stream_ops", title: "Runbook", seq: 1, archived: true }],
      hasMore: true,
      cursor: "cur_2",
    })
  )

  const result = await run(
    ["docs", "list", "--query", "run", "--archived", "--after", "cur_1", "--limit", "1", "-o", "text"],
    { config: TEST_CONFIG }
  )

  expect(result.exitCode).toBe(0)
  const call = lastCall()
  expect({ path: call.url.pathname, query: Object.fromEntries(call.url.searchParams) }).toEqual({
    path: DOCS,
    query: { query: "run", includeArchived: "true", after: "cur_1", limit: "1" },
  })
  expect(result.stdout).toContain("stream_d2  Runbook  1  stream_ops  [archived]\n… more (--after cur_2)")
})

test("docs read prints the markdown with block markers as is", async () => {
  const markdown = "<!-- blk_1 -->\n# Plan\n"
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: { id: "stream_d1", title: "Plan", seq: 1, markdown } }))

  const result = await run(["docs", "read", "stream_d1", "-o", "text"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(0)
  expect(lastCall().method).toBe("GET")
  expect(lastCall().url.pathname).toBe(`${DOCS}/stream_d1`)
  expect(result.stdout).toContain(markdown.trimEnd())
})

test("docs edit pairs --old/--new by position and confines both to --block", async () => {
  fetchSpy.mockResolvedValue(
    jsonResponse(200, { data: { id: "stream_d1", title: "Plan", seq: 4, touchedBlockIds: ["blk_1"], markdown: "x" } })
  )

  const result = await run(
    [
      "docs",
      "edit",
      "stream_d1",
      "--reason",
      "fix typos",
      "--old",
      "a",
      "--new",
      "b",
      "--old",
      "c",
      "--new",
      "d",
      "--block",
      "blk_1",
      "-o",
      "text",
    ],
    { config: TEST_CONFIG }
  )

  expect(result.exitCode).toBe(0)
  const call = lastCall()
  expect({ method: call.method, path: call.url.pathname, body: call.body }).toEqual({
    method: "POST",
    path: `${DOCS}/stream_d1/edits`,
    body: {
      reason: "fix typos",
      edits: [
        { blockId: "blk_1", old: "a", new: "b" },
        { blockId: "blk_1", old: "c", new: "d" },
      ],
    },
  })
  expect(result.stdout).toContain("edited stream_d1 seq 4: 1 block(s)")
})

test("docs edit with mismatched --old/--new counts is a usage error before any HTTP", async () => {
  const result = await run(["docs", "edit", "stream_d1", "--reason", "r", "--old", "a", "--old", "c", "--new", "b"], {
    config: TEST_CONFIG,
  })

  expect(result.exitCode).toBe(2)
  expect((JSON.parse(result.stderr) as { code: string }).code).toBe("USAGE")
  expect(fetchSpy).not.toHaveBeenCalled()
})

test("docs create reads --body - from stdin", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(201, { data: { id: "doc_9", title: "Notes", seq: 1, markdown: "" } }))

  const result = await run(
    ["docs", "create", "stream_1", "--title", "Notes", "--body", "-", "--reason", "start notes", "-o", "text"],
    { config: TEST_CONFIG, readStdin: () => Promise.resolve("# Notes\n") }
  )

  expect(result.exitCode).toBe(0)
  const call = lastCall()
  expect({ method: call.method, path: call.url.pathname, body: call.body }).toEqual({
    method: "POST",
    path: DOCS,
    body: { streamId: "stream_1", title: "Notes", markdown: "# Notes\n", reason: "start notes" },
  })
  expect(result.stdout).toContain("created doc_9  Notes")
})

test("docs create with --body but no --reason is a usage error before any HTTP", async () => {
  const result = await run(["docs", "create", "stream_1", "--body", "hi"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(2)
  expect((JSON.parse(result.stderr) as { code: string }).code).toBe("USAGE")
  expect(fetchSpy).not.toHaveBeenCalled()
})

test("docs comment reads --body - from stdin and names the thread", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(201, { data: { threadId: "stream_t1", message: { id: "msg_1" } } }))

  const result = await run(
    ["docs", "comment", "stream_d1", "--block", "blk_1", "--body", "-", "--client-message-id", "retry-1", "-o", "text"],
    {
      config: TEST_CONFIG,
      readStdin: () => Promise.resolve("Who owns this?\n"),
    }
  )

  expect(result.exitCode).toBe(0)
  const call = lastCall()
  expect({ method: call.method, path: call.url.pathname, body: call.body }).toEqual({
    method: "POST",
    path: `${DOCS}/stream_d1/sections/blk_1/comments`,
    body: { content: "Who owns this?\n", clientMessageId: "retry-1" },
  })
  expect(result.stdout).toContain("commented in thread stream_t1")
})

test("docs comment without --block is a usage error before any HTTP", async () => {
  const result = await run(["docs", "comment", "stream_d1", "--body", "hi"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(2)
  expect((JSON.parse(result.stderr) as { code: string }).code).toBe("USAGE")
  expect(fetchSpy).not.toHaveBeenCalled()
})
