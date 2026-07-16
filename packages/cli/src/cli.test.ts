import { afterEach, expect, spyOn, test } from "bun:test"
import { run } from "./cli"
import { fetchByPath, jsonResponse, TEST_CONFIG } from "./test-support"

const fetchSpy = spyOn(globalThis, "fetch")

afterEach(() => {
  fetchSpy.mockReset()
})

function calledPaths(): string[] {
  return fetchSpy.mock.calls.map((call) => new URL(String(call[0]))).map((u) => `${u.pathname}${u.search}`)
}

test("whoami --json emits the /me principal with binding info to stdout, exit 0", async () => {
  fetchSpy.mockResolvedValue(
    jsonResponse(200, {
      data: { kind: "user", userId: "usr_1", apiVersion: { resolved: "2026-07-01" } },
    })
  )

  const result = await run(["whoami", "--json"], { config: TEST_CONFIG, isTTY: true })

  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe("")
  const payload = JSON.parse(result.stdout) as {
    principal: { kind: string; apiVersion?: unknown }
    baseUrl: string
    workspaceId: string
  }
  expect(payload.principal.kind).toBe("user")
  expect(payload.principal.apiVersion).toBeDefined()
  expect(payload.baseUrl).toBe("https://app.threa.io")
  expect(payload.workspaceId).toBe("ws_1")
})

test("whoami renders concise human text on a TTY and forces JSON with --json", async () => {
  fetchSpy.mockImplementation(fetchByPath(() => jsonResponse(200, { data: { kind: "user", userId: "usr_1" } })))

  const human = await run(["whoami"], { config: TEST_CONFIG, isTTY: true })
  expect(human.exitCode).toBe(0)
  expect(human.stdout).toContain("principal: user usr_1")
  expect(() => JSON.parse(human.stdout)).toThrow()

  const json = await run(["whoami", "--json"], { config: TEST_CONFIG, isTTY: true })
  expect(() => JSON.parse(json.stdout)).not.toThrow()
})

test("piped output (no TTY) is JSON even without --json", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: { kind: "user", userId: "usr_1" } }))

  const result = await run(["whoami"], { config: TEST_CONFIG, isTTY: false })
  expect(() => JSON.parse(result.stdout)).not.toThrow()
})

test("stream #slug resolves the channel then reads the stream and its messages", async () => {
  fetchSpy.mockImplementation(
    fetchByPath((path) => {
      if (path.endsWith("/messages")) return jsonResponse(200, { data: [], hasMore: false })
      if (path.endsWith("/streams/stream_1")) return jsonResponse(200, { data: { id: "stream_1", slug: "eng" } })
      if (path.endsWith("/streams")) return jsonResponse(200, { data: [{ id: "stream_1", slug: "eng" }] })
      return jsonResponse(404, { error: "unexpected", code: "NOT_FOUND" })
    })
  )

  const result = await run(["stream", "#eng", "--json"], { config: TEST_CONFIG, isTTY: false })

  expect(result.exitCode).toBe(0)
  const payload = JSON.parse(result.stdout) as { stream: { id: string } }
  expect(payload.stream.id).toBe("stream_1")
  expect(calledPaths().some((p) => p.includes("/streams?") && p.includes("query=eng"))).toBe(true)
  expect(calledPaths()).toContain("/api/v1/workspaces/ws_1/streams/stream_1")
})

test("search rejects a filter the chosen what does not support: exit 1, stderr JSON, no HTTP", async () => {
  const result = await run(["search", "x", "--what", "attachments", "--type", "channel"], {
    config: TEST_CONFIG,
    isTTY: false,
  })

  expect(result.exitCode).toBe(1)
  expect(result.stdout).toBe("")
  const err = JSON.parse(result.stderr) as { code: string; message: string }
  expect(err.code).toBe("UNSUPPORTED_FILTER")
  expect(err.message).toContain("type")
  expect(fetchSpy).not.toHaveBeenCalled()
})

test("search what=messages posts to /messages/search and maps --stream to streams", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: [{ id: "msg_1" }] }))

  const result = await run(["search", "deploy plan", "--what", "messages", "--stream", "stream_1", "--limit", "5"], {
    config: TEST_CONFIG,
    isTTY: false,
  })

  expect(result.exitCode).toBe(0)
  const call = fetchSpy.mock.calls[0]!
  expect(new URL(String(call[0])).pathname).toBe("/api/v1/workspaces/ws_1/messages/search")
  const body = JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>
  expect(body.query).toBe("deploy plan")
  expect(body.streams).toEqual(["stream_1"])
  expect(body.limit).toBe(5)
})

test("find-by-metadata parses k=v positionals into the metadata body", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: [] }))

  const result = await run(["find-by-metadata", "github.pr=org/repo#42", "--json"], {
    config: TEST_CONFIG,
    isTTY: false,
  })

  expect(result.exitCode).toBe(0)
  const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body)) as {
    metadata: Record<string, string>
  }
  expect(body.metadata).toEqual({ "github.pr": "org/repo#42" })
})

test("unknown command exits 2 with the command list on stderr", async () => {
  const result = await run(["frobnicate"], { config: TEST_CONFIG, isTTY: false })

  expect(result.exitCode).toBe(2)
  const err = JSON.parse(result.stderr) as { code: string; hint?: string }
  expect(err.code).toBe("UNKNOWN_COMMAND")
  expect(err.hint).toContain("Commands:")
  expect(fetchSpy).not.toHaveBeenCalled()
})

test("an unknown flag is a usage error (exit 2) carrying the command usage", async () => {
  const result = await run(["whoami", "--bogus"], { config: TEST_CONFIG, isTTY: false })

  expect(result.exitCode).toBe(2)
  const err = JSON.parse(result.stderr) as { code: string; hint?: string }
  expect(err.code).toBe("USAGE")
  expect(err.hint).toContain("threa whoami")
})

test("a missing required positional is a usage error (exit 2)", async () => {
  const result = await run(["stream"], { config: TEST_CONFIG, isTTY: false })

  expect(result.exitCode).toBe(2)
  expect((JSON.parse(result.stderr) as { code: string }).code).toBe("USAGE")
})

test("an API error surfaces as exit 1 with the scope hint on 404", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(404, { error: "gone", code: "NOT_FOUND" }))

  const result = await run(["memo", "memo_x", "--json"], { config: TEST_CONFIG, isTTY: false })

  expect(result.exitCode).toBe(1)
  const err = JSON.parse(result.stderr) as { code: string; hint?: string }
  expect(err.code).toBe("NOT_FOUND")
  expect(err.hint).toMatch(/scope/i)
})

test("top-level --help lists every command, exit 0", async () => {
  const result = await run(["--help"], { config: TEST_CONFIG, isTTY: true })

  expect(result.exitCode).toBe(0)
  for (const name of ["whoami", "streams", "stream", "search", "conversation", "memo", "attachment", "mcp"]) {
    expect(result.stdout).toContain(name)
  }
})

test("per-command --help documents flags to stdout, exit 0", async () => {
  const result = await run(["search", "--help"], { config: TEST_CONFIG, isTTY: true })

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain("--what")
  expect(result.stdout).toContain("--semantic")
})

test("mcp serve signals serve mode without touching HTTP; a bad subcommand is exit 2", async () => {
  const serve = await run(["mcp", "serve"], { config: TEST_CONFIG, isTTY: false })
  expect(serve.exitCode).toBe(0)
  expect(serve.serve).toBe(true)
  expect(fetchSpy).not.toHaveBeenCalled()

  const bad = await run(["mcp", "wat"], { config: TEST_CONFIG, isTTY: false })
  expect(bad.exitCode).toBe(2)
  expect((JSON.parse(bad.stderr) as { code: string }).code).toBe("USAGE")
})
