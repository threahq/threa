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

interface FakeBlock {
  id: string
  markdown: string
}

function fakeDoc(blocks: FakeBlock[], options: { onEdit?: (attempt: number) => Response | undefined } = {}) {
  const edits: { blockId: string; old: string; new: string }[] = []
  let attempt = 0
  fetchSpy.mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    if (path === `${DOCS}/stream_d1` && (init?.method ?? "GET") === "GET") {
      const markdown = blocks.map((b) => `<!-- ${b.id} -->\n${b.markdown}`).join("\n\n")
      return jsonResponse(200, { data: { id: "stream_d1", seq: 1, markdown } })
    }
    if (path === `${DOCS}/stream_d1/edits`) {
      const override = options.onEdit?.(attempt++)
      if (override) return override
      const body = JSON.parse(String(init!.body)) as { edits: { blockId: string; old: string; new: string }[] }
      const [edit] = body.edits
      edits.push(edit!)
      const block = blocks.find((b) => b.id === edit!.blockId)!
      block.markdown = block.markdown.replace(edit!.old, edit!.new)
      return jsonResponse(200, { data: { id: "stream_d1", seq: 2, touchedBlockIds: [block.id] } })
    }
    return jsonResponse(404, { error: "not found" })
  }) as unknown as typeof fetch)
  return { blocks, edits }
}

function check(args: string[]) {
  return run(["docs", "check", "stream_d1", "--reason", "done", ...args], { config: TEST_CONFIG })
}

test("docs check ticks the item by rewriting its whole block", async () => {
  const doc = fakeDoc([{ id: "blk_1", markdown: "- [ ] Write spec\n- [ ] Ship it" }])

  const result = await check(["--item", "Ship it", "-o", "text"])

  expect(result.exitCode).toBe(0)
  expect({ edits: doc.edits, markdown: doc.blocks[0]!.markdown }).toEqual({
    edits: [{ blockId: "blk_1", old: "- [ ] Write spec\n- [ ] Ship it", new: "- [ ] Write spec\n- [x] Ship it" }],
    markdown: "- [ ] Write spec\n- [x] Ship it",
  })
  expect(result.stdout).toContain("updated (blk_1): - [x] Ship it")
})

test("docs check --uncheck clears a ticked item", async () => {
  const doc = fakeDoc([{ id: "blk_1", markdown: "- [X] Ship it" }])

  const result = await check(["--item", "Ship it", "--uncheck"])

  expect(result.exitCode).toBe(0)
  expect(doc.blocks[0]!.markdown).toBe("- [ ] Ship it")
})

test("docs check on an item already in that state writes nothing", async () => {
  const doc = fakeDoc([{ id: "blk_1", markdown: "- [x] Ship it" }])

  const result = await check(["--item", "Ship it", "--json"])

  expect(result.exitCode).toBe(0)
  expect(doc.edits).toEqual([])
  expect(JSON.parse(result.stdout)).toEqual({
    data: { changed: false, blockId: "blk_1", nth: 1, checked: true, line: "- [x] Ship it" },
  })
})

test("docs check with no matching item fails DOC_TASK_NOT_FOUND", async () => {
  const doc = fakeDoc([{ id: "blk_1", markdown: "- [ ] Ship it" }])

  const result = await check(["--item", "Ship"])

  expect(result.exitCode).toBe(1)
  expect((JSON.parse(result.stderr) as { code: string }).code).toBe("DOC_TASK_NOT_FOUND")
  expect(doc.edits).toEqual([])
})

test("docs check on duplicate items without --nth lists every match", async () => {
  const doc = fakeDoc([
    { id: "blk_1", markdown: "- [ ] Review" },
    { id: "blk_2", markdown: "Phase two\n\n- [ ] Review" },
  ])

  const result = await check(["--item", "Review"])

  expect(result.exitCode).toBe(1)
  const error = JSON.parse(result.stderr) as { code: string; details: unknown }
  expect({ code: error.code, details: error.details }).toEqual({
    code: "DOC_TASK_AMBIGUOUS",
    details: {
      matches: [
        { blockId: "blk_1", nth: 1, line: "- [ ] Review" },
        { blockId: "blk_2", nth: 2, line: "- [ ] Review" },
      ],
    },
  })
  expect(doc.edits).toEqual([])
})

test("docs check --nth 2 ticks the second duplicate only", async () => {
  const doc = fakeDoc([{ id: "blk_1", markdown: "- [ ] Review\n- [ ] Merge\n- [ ] Review" }])

  const result = await check(["--item", "Review", "--nth", "2"])

  expect(result.exitCode).toBe(0)
  expect(doc.blocks[0]!.markdown).toBe("- [ ] Review\n- [ ] Merge\n- [x] Review")
})

test("docs check matches a nested, indented item", async () => {
  const doc = fakeDoc([{ id: "blk_1", markdown: "- [ ] Launch\n  - [ ] Tests green\n  - [ ] Docs" }])

  const result = await check(["--item", "Tests green"])

  expect(result.exitCode).toBe(0)
  expect(doc.blocks[0]!.markdown).toBe("- [ ] Launch\n  - [x] Tests green\n  - [ ] Docs")
})

test("docs check picks the exact item, not a longer one sharing its prefix", async () => {
  const doc = fakeDoc([{ id: "blk_1", markdown: "- [ ] foo bar\n- [ ] foo" }])

  const result = await check(["--item", "foo"])

  expect(result.exitCode).toBe(0)
  expect(doc.blocks[0]!.markdown).toBe("- [ ] foo bar\n- [x] foo")
})

test("docs check re-reads and retries once when the block moved between read and write", async () => {
  const blocks = [{ id: "blk_1", markdown: "- [ ] Ship it" }]
  const doc = fakeDoc(blocks, {
    onEdit: (attempt) => {
      if (attempt > 0) return undefined
      blocks[0]!.markdown = "- [ ] Write spec\n- [ ] Ship it"
      return jsonResponse(409, { error: "moved", code: "DOC_EDIT_TEXT_NOT_FOUND" })
    },
  })

  const result = await check(["--item", "Ship it"])

  expect(result.exitCode).toBe(0)
  expect({ edits: doc.edits, markdown: blocks[0]!.markdown }).toEqual({
    edits: [{ blockId: "blk_1", old: "- [ ] Write spec\n- [ ] Ship it", new: "- [ ] Write spec\n- [x] Ship it" }],
    markdown: "- [ ] Write spec\n- [x] Ship it",
  })
})

test("docs check without --reason is a usage error before any HTTP", async () => {
  const result = await run(["docs", "check", "stream_d1", "--item", "x"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(2)
  expect(fetchSpy).not.toHaveBeenCalled()
})

test("docs check skips a task-shaped line inside a fenced code block", async () => {
  const doc = fakeDoc([{ id: "blk_1", markdown: "- [ ] Ship it\n  ```md\n  - [ ] Ship it\n  ```" }])

  const result = await check(["--item", "Ship it"])

  expect(result.exitCode).toBe(0)
  expect(doc.blocks[0]!.markdown).toBe("- [x] Ship it\n  ```md\n  - [ ] Ship it\n  ```")
})

test("docs check --nth rejects anything but a plain positive integer", async () => {
  const results = await Promise.all(["0x2", "1e1", "0"].map((nth) => check(["--item", "x", "--nth", nth])))

  expect(results.map((r) => r.exitCode)).toEqual([2, 2, 2])
  expect(fetchSpy).not.toHaveBeenCalled()
})
