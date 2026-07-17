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

  const result = await run(["whoami", "--json"], { config: TEST_CONFIG })

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

test("whoami renders human text by default and forces JSON with --json", async () => {
  fetchSpy.mockImplementation(fetchByPath(() => jsonResponse(200, { data: { kind: "user", userId: "usr_1" } })))

  const human = await run(["whoami"], { config: TEST_CONFIG })
  expect(human.exitCode).toBe(0)
  expect(human.stdout).toContain("principal: user usr_1")
  expect(() => JSON.parse(human.stdout)).toThrow()

  const json = await run(["whoami", "--json"], { config: TEST_CONFIG })
  expect(() => JSON.parse(json.stdout)).not.toThrow()
})

test("output flags are position-independent: --json and -o work anywhere in argv", async () => {
  fetchSpy.mockImplementation(fetchByPath(() => jsonResponse(200, { data: { kind: "user", userId: "usr_1" } })))

  for (const argv of [
    ["--json", "whoami"],
    ["whoami", "--json"],
    ["-o", "json", "whoami"],
    ["whoami", "-o", "json"],
    ["-o=json", "whoami"],
    ["--output=json", "whoami"],
  ]) {
    const result = await run(argv, { config: TEST_CONFIG })
    expect(result.exitCode).toBe(0)
    expect(() => JSON.parse(result.stdout)).not.toThrow()
  }
})

test("output flags work between noun and verb", async () => {
  fetchSpy.mockImplementation(fetchByPath(() => jsonResponse(200, { data: [], hasMore: false, cursor: null })))

  const result = await run(["streams", "--json", "list"], { config: TEST_CONFIG })
  expect(result.exitCode).toBe(0)
  expect(() => JSON.parse(result.stdout)).not.toThrow()
})

test("-o text overrides a config default of json", async () => {
  fetchSpy.mockImplementation(fetchByPath(() => jsonResponse(200, { data: { kind: "user", userId: "usr_1" } })))

  const jsonByConfig = await run(["whoami"], { config: { ...TEST_CONFIG, output: "json" } })
  expect(() => JSON.parse(jsonByConfig.stdout)).not.toThrow()

  const textByFlag = await run(["whoami", "-o", "text"], { config: { ...TEST_CONFIG, output: "json" } })
  expect(textByFlag.stdout).toContain("principal: user usr_1")
  expect(() => JSON.parse(textByFlag.stdout)).toThrow()
})

test("an invalid -o value is a usage error (exit 2)", async () => {
  const result = await run(["whoami", "-o", "yaml"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(2)
  const err = JSON.parse(result.stderr) as { code: string; message: string }
  expect(err.code).toBe("USAGE")
  expect(err.message).toContain("json")
  expect(fetchSpy).not.toHaveBeenCalled()
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

  const result = await run(["streams", "read", "#eng", "--json"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(0)
  const payload = JSON.parse(result.stdout) as { stream: { id: string } }
  expect(payload.stream.id).toBe("stream_1")
  expect(calledPaths().some((p) => p.includes("/streams?") && p.includes("query=eng"))).toBe(true)
  expect(calledPaths()).toContain("/api/v1/workspaces/ws_1/streams/stream_1")
})

test("search rejects a filter the chosen what does not support: exit 1, stderr JSON, no HTTP", async () => {
  const result = await run(["search", "x", "--what", "attachments", "--type", "channel"], {
    config: TEST_CONFIG,
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

  const result = await run(["messages", "find-by-metadata", "github.pr=org/repo#42", "--json"], {
    config: TEST_CONFIG,
  })

  expect(result.exitCode).toBe(0)
  const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body)) as {
    metadata: Record<string, string>
  }
  expect(body.metadata).toEqual({ "github.pr": "org/repo#42" })
})

test("unknown command exits 2 with the command list on stderr", async () => {
  const result = await run(["frobnicate"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(2)
  const err = JSON.parse(result.stderr) as { code: string; hint?: string }
  expect(err.code).toBe("UNKNOWN_COMMAND")
  expect(err.hint).toContain("Commands:")
  expect(fetchSpy).not.toHaveBeenCalled()
})

test("an unknown flag is a usage error (exit 2) carrying the command usage", async () => {
  const result = await run(["whoami", "--bogus"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(2)
  const err = JSON.parse(result.stderr) as { code: string; hint?: string }
  expect(err.code).toBe("USAGE")
  expect(err.hint).toContain("threa whoami")
})

test("a missing required positional is a usage error (exit 2)", async () => {
  const result = await run(["streams", "read"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(2)
  expect((JSON.parse(result.stderr) as { code: string }).code).toBe("USAGE")
})

test("a bare noun with no subcommand is a usage error (exit 2) listing its verbs", async () => {
  const result = await run(["delegations"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(2)
  const err = JSON.parse(result.stderr) as { code: string; message: string; hint?: string }
  expect(err.code).toBe("USAGE")
  expect(err.message).toContain("claim")
  expect(err.hint).toContain("Subcommands:")
  expect(fetchSpy).not.toHaveBeenCalled()
})

test("an unknown subcommand under a noun is a usage error (exit 2) naming valid verbs", async () => {
  const result = await run(["streams", "frobnicate"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(2)
  const err = JSON.parse(result.stderr) as { code: string; message: string }
  expect(err.code).toBe("USAGE")
  expect(err.message).toContain("read")
  expect(fetchSpy).not.toHaveBeenCalled()
})

test("noun --help lists the noun's subcommands, exit 0", async () => {
  const result = await run(["messages", "--help"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(0)
  for (const verb of ["send", "edit", "delete", "find-by-metadata"]) {
    expect(result.stdout).toContain(verb)
  }
})

test("noun verb --help documents that verb's flags, exit 0", async () => {
  const result = await run(["messages", "send", "--help"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain("threa messages send")
  expect(result.stdout).toContain("--new-conversation")
})

test("an API error surfaces as exit 1 with the scope hint on 404", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(404, { error: "gone", code: "NOT_FOUND" }))

  const result = await run(["memos", "get", "memo_x", "--json"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(1)
  const err = JSON.parse(result.stderr) as { code: string; hint?: string }
  expect(err.code).toBe("NOT_FOUND")
  expect(err.hint).toMatch(/scope/i)
})

test("top-level --help lists every command, exit 0", async () => {
  const result = await run(["--help"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(0)
  for (const name of [
    "whoami",
    "messages",
    "streams",
    "conversations",
    "users",
    "memos",
    "attachments",
    "labels",
    "delegations",
    "search",
    "skill",
    "mcp",
  ]) {
    expect(result.stdout).toContain(name)
  }
})

test("per-command --help documents flags to stdout, exit 0", async () => {
  const result = await run(["search", "--help"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain("--what")
  expect(result.stdout).toContain("--semantic")
})

test("mcp serve signals serve mode without touching HTTP; a bad subcommand is exit 2", async () => {
  const serve = await run(["mcp", "serve"], { config: TEST_CONFIG })
  expect(serve.exitCode).toBe(0)
  expect(serve.serve).toBe(true)
  expect(fetchSpy).not.toHaveBeenCalled()

  const bad = await run(["mcp", "wat"], { config: TEST_CONFIG })
  expect(bad.exitCode).toBe(2)
  expect((JSON.parse(bad.stderr) as { code: string }).code).toBe("USAGE")
})
