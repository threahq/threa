import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { __testing } from "./threa-remote"

describe("Pi remote trace safety", () => {
  test("omits sensitive bash command arguments from tool_call traces", () => {
    const trace = __testing.formatToolCallTrace({
      toolName: "bash",
      toolCallId: "call_1",
      input: { command: "cat .env && curl -H 'Authorization: Bearer sk-test-secret-token' https://example.com" },
    } as never)

    expect(trace).toContain("Shell command omitted for safety")
    expect(trace).not.toContain("cat .env")
    expect(trace).not.toContain("sk-test-secret-token")
    expect(__testing.describeToolCall({ toolName: "bash", toolCallId: "call_1", input: {} } as never)).toBe(
      "Running shell command…"
    )
  })

  test("omits tool result bodies while preserving output size telemetry", () => {
    const trace = __testing.formatToolResultTrace({
      toolName: "bash",
      toolCallId: "call_1",
      isError: false,
      content: "DATABASE_URL=postgres://user:password@example.test/db\nOPENAI_API_KEY=sk-test-secret-token",
    } as never)

    expect(trace).toContain("Tool output omitted for safety")
    expect(trace).toContain("characters across 2 lines")
    expect(trace).not.toContain("DATABASE_URL")
    expect(trace).not.toContain("sk-test-secret-token")
  })

  test("omits write/edit patch bodies from argument summaries", () => {
    const trace = __testing.formatToolCallTrace({
      toolName: "edit",
      toolCallId: "call_1",
      input: { path: "src/config.ts", oldText: "password = 'secret'", newText: "password = 'new-secret'" },
    } as never)

    expect(trace).toContain("Edit target:")
    expect(trace).toContain("File contents and patches omitted for safety")
    expect(trace).not.toContain("oldText")
    expect(trace).not.toContain("secret")
  })

  test("migrates legacy global enabled and stream cursors into session links", () => {
    const migrated = __testing.migrateSessionState({
      baseUrl: "https://app.threa.io",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
      streamCursors: { stream_a: "42" },
      linkedSessions: {
        session_1: {
          linkId: "brsl_123",
          rootStreamId: "stream_a",
          activeStreamId: "stream_a",
          runtimeSessionId: "session_1",
          streamUrlPath: "/streams/stream_a",
        },
      },
    })

    expect(migrated.linkedSessions?.session_1.enabled).toBe(true)
    expect(migrated.linkedSessions?.session_1.streamCursors).toEqual({ stream_a: "42" })
  })

  test("drops malformed linked session entries during migration", () => {
    const migrated = __testing.migrateSessionState({
      baseUrl: "https://app.threa.io",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
      linkedSessions: {
        session_1: null,
      } as never,
    })

    expect(migrated.linkedSessions).toEqual({})
  })

  test("includes the Pi session id when claiming invocations", () => {
    expect(__testing.buildClaimInvocationPayload("pi-host-123", "pi-session-abc")).toMatchObject({
      runtimeKind: "pi-local",
      instanceId: "pi-host-123",
      runtimeSessionId: "pi-session-abc",
      supportedCapabilities: ["active-scratchpad", "mentionable"],
      claimTtlSeconds: 120,
    })
    expect(
      __testing.buildClaimInvocationPayload("pi-host-123", "pi-session-abc", { includeSessionControl: true })
    ).toMatchObject({
      supportedCapabilities: ["active-scratchpad", "mentionable", "session-control"],
    })
  })

  test("advertises session-control command capabilities", () => {
    expect(__testing.buildRuntimeCapabilities()).toMatchObject({
      supportsSessionControlCommands: true,
      sessionControlCommands: ["compact", "model", "thinking", "skill", "reload", "shell"],
    })
  })

  test("parses runtime command invocation metadata", () => {
    expect(
      __testing.getRuntimeCommand({
        id: "binv_1",
        activeStreamId: "stream_1",
        sourceMessageId: "cmd_1",
        promptMarkdown: "/thinking high",
        claimToken: "claim",
        claimExpiresAt: null,
        metadata: { command: { id: "cmd_1", name: "thinking", args: "high", executionKind: "bot-runtime" } },
      })
    ).toEqual({ id: "cmd_1", name: "thinking", args: "high", executionKind: "bot-runtime" })
  })

  test("normalizes thinking level aliases", () => {
    expect(__testing.normalizeThinkingLevel("x-high")).toBe("xhigh")
    expect(__testing.normalizeThinkingLevel("none")).toBe("off")
    expect(__testing.normalizeThinkingLevel("bogus")).toBeNull()
  })

  test("forwards model provider errors instead of the default Done. fallback", () => {
    const limitMessage = "Error: You have hit your ChatGPT usage limit (plus plan). Try again in ~139 min."

    expect(__testing.resolveFinalText({ error: limitMessage }, { assistantTexts: [], otherTexts: [] })).toBe(
      limitMessage
    )
    expect(
      __testing.resolveFinalText({ error: { message: limitMessage } }, { assistantTexts: [], otherTexts: [] })
    ).toBe(limitMessage)
  })

  test("prefers captured assistant text over an event error", () => {
    expect(
      __testing.resolveFinalText({ error: "rate limited" }, { assistantTexts: ["here is the answer"], otherTexts: [] })
    ).toBe("here is the answer")
  })

  test("falls back to captured non-assistant message text when assistant produced nothing", () => {
    expect(
      __testing.resolveFinalText(
        { messages: [] },
        { assistantTexts: [], otherTexts: [{ role: "system", text: "usage limit hit" }] }
      )
    ).toBe("usage limit hit")
  })

  test("extracts non-assistant content from event.messages as the last-resort fallback", () => {
    expect(
      __testing.resolveFinalText(
        { messages: [{ role: "system", content: "usage limit hit" }] },
        { assistantTexts: [], otherTexts: [] }
      )
    ).toBe("usage limit hit")
  })

  test("ignores user-role echoes when picking the final response", () => {
    expect(
      __testing.resolveFinalText(
        { messages: [{ role: "user", content: "the original prompt" }] },
        { assistantTexts: [], otherTexts: [] }
      )
    ).toBe("Done.")
  })

  test("returns Done. only when nothing useful is captured", () => {
    expect(__testing.resolveFinalText({}, { assistantTexts: [], otherTexts: [] })).toBe("Done.")
  })

  test("prefers the captured provider error over message scans", () => {
    expect(
      __testing.resolveFinalText(
        { messages: [{ role: "system", content: "something else" }] },
        { assistantTexts: [], otherTexts: [], providerError: "Error: model provider rate-limited the request." }
      )
    ).toBe("Error: model provider rate-limited the request.")
  })

  test("parseRetryAfter understands the seconds form of Retry-After", () => {
    expect(__testing.parseRetryAfter({ "retry-after": "120" })).toBe(120_000)
    expect(__testing.parseRetryAfter({ "Retry-After": "0.5" })).toBe(500)
  })

  test("parseRetryAfter understands HTTP-date form of Retry-After", () => {
    const now = Date.parse("2026-05-25T12:00:00Z")
    const future = new Date(now + 90_000).toUTCString()
    expect(__testing.parseRetryAfter({ "retry-after": future }, now)).toBe(90_000)
  })

  test("parseRetryAfter clamps past dates to 0 and rejects garbage", () => {
    const now = Date.parse("2026-05-25T12:00:00Z")
    const past = new Date(now - 30_000).toUTCString()
    expect(__testing.parseRetryAfter({ "retry-after": past }, now)).toBe(0)
    expect(__testing.parseRetryAfter({ "retry-after": "not a date" }, now)).toBeUndefined()
    expect(__testing.parseRetryAfter({}, now)).toBeUndefined()
  })

  test("describeProviderError composes a 429 message with the exact local retry time", () => {
    const now = Date.parse("2026-05-25T12:00:00Z")
    const message = __testing.describeProviderError(429, { "retry-after": "139" }, now + 139_000 * 0)
    expect(message).toContain("HTTP 429")
    expect(message).toMatch(/Try again around \d{2}:\d{2}/)
    expect(message).toContain("in ~")
  })

  test("describeProviderError handles other status codes without retry info", () => {
    expect(__testing.describeProviderError(401, {})).toContain("HTTP 401")
    expect(__testing.describeProviderError(503, {})).toContain("HTTP 503")
    expect(__testing.describeProviderError(429, {})).toBe("Error: model provider rate-limited the request (HTTP 429).")
  })

  test("formatRetryNotice mentions the attempt number once past the first try", () => {
    expect(__testing.formatRetryNotice(60_000, 1)).not.toContain("attempt")
    expect(__testing.formatRetryNotice(60_000, 2)).toContain(`attempt 2 of ${__testing.MAX_RETRY_ATTEMPTS}`)
  })

  test("formatDuration rounds reasonably across minute/hour boundaries", () => {
    expect(__testing.formatDuration(10_000)).toBe("<1 min")
    expect(__testing.formatDuration(5 * 60_000)).toBe("5 min")
    expect(__testing.formatDuration(60 * 60_000)).toBe("1h")
    expect(__testing.formatDuration(139 * 60_000)).toBe("2h 19m")
  })

  test("builds scratchpad URLs from workspace and stream ids the client already owns", () => {
    // The frontend route is `/w/:workspaceId/s/:streamId`. Composing locally
    // means the URL is right even when `link.streamUrlPath` was persisted by a
    // server version that returned the legacy `/streams/<id>` shape.
    expect(__testing.buildScratchpadUrl("https://app.threa.io", "ws_123", "stream_123")).toBe(
      "https://app.threa.io/w/ws_123/s/stream_123"
    )
    expect(__testing.buildScratchpadUrl("https://app.threa.io/app/", "ws_123", "stream_123")).toBe(
      "https://app.threa.io/w/ws_123/s/stream_123"
    )
  })

  test("parses pasted self-configuration JSON", () => {
    expect(
      __testing.parseConfigPatch(`{
        "baseUrl": " https://app.threa.io/ ",
        "workspaceId": " ws_123 ",
        "apiKey": " threa_bk_test ",
        "pollMs": 1500,
        "defaultDisplayName": " Local Pi "
      }`)
    ).toEqual({
      baseUrl: "https://app.threa.io/",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
      pollMs: 1500,
      defaultDisplayName: "Local Pi",
    })
  })

  test("parseWsHint accepts the workspace config wsUrl shape", () => {
    expect(__testing.parseWsHint({ url: "wss://eu.threa.io", path: "/socket.io/", namespace: "/bot" })).toEqual({
      url: "wss://eu.threa.io",
      path: "/socket.io/",
      namespace: "/bot",
    })
  })

  test("parseWsHint defaults the Socket.IO path and namespace when the server omits them", () => {
    expect(__testing.parseWsHint({ url: "wss://eu.threa.io" })).toEqual({
      url: "wss://eu.threa.io",
      path: "/socket.io/",
      namespace: "/bot",
    })
  })

  test("parseWsHint rejects payloads without a url so we do not dial blank origins", () => {
    expect(__testing.parseWsHint({ path: "/socket.io/", namespace: "/bot" })).toBeUndefined()
    expect(__testing.parseWsHint(null)).toBeUndefined()
    expect(__testing.parseWsHint("wss://eu.threa.io")).toBeUndefined()
    expect(__testing.parseWsHint({ url: "   " })).toBeUndefined()
  })

  test("preserves an existing wsCursor when migrating session state", () => {
    const migrated = __testing.migrateSessionState({
      baseUrl: "https://app.threa.io",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
      linkedSessions: {
        session_1: {
          linkId: "brsl_123",
          rootStreamId: "stream_a",
          activeStreamId: "stream_a",
          runtimeSessionId: "session_1",
          streamUrlPath: "/streams/stream_a",
          wsCursor: "2026-05-27T12:34:56.000Z",
        },
      },
    })

    expect(migrated.linkedSessions?.session_1.wsCursor).toBe("2026-05-27T12:34:56.000Z")
  })

  test("WS_BACKSTOP_POLL_MS is the 30s safety cadence described in the plan", () => {
    expect(__testing.WS_BACKSTOP_POLL_MS).toBe(30_000)
  })
})

describe("buildBotSocketUrl", () => {
  test("appends the namespace to a bare wsUrl", () => {
    expect(__testing.buildBotSocketUrl({ url: "https://eu.threa.io", path: "/socket.io/", namespace: "/bot" })).toBe(
      "https://eu.threa.io/bot"
    )
  })

  test("does not double the slash when wsUrl already has a trailing slash", () => {
    expect(__testing.buildBotSocketUrl({ url: "https://eu.threa.io/", path: "/socket.io/", namespace: "/bot" })).toBe(
      "https://eu.threa.io/bot"
    )
  })

  test("preserves a query string on the wsUrl (staging routes region via ?region=…)", () => {
    // Regression: prior `${url}${namespace}` concat produced
    // `https://ws-staging.threa.io?region=staging/bot`, which Socket.IO rejects.
    expect(
      __testing.buildBotSocketUrl({
        url: "https://ws-staging.threa.io?region=staging",
        path: "/socket.io/",
        namespace: "/bot",
      })
    ).toBe("https://ws-staging.threa.io/bot?region=staging")
  })

  test("nests under an existing pathname when the wsUrl already has one", () => {
    expect(
      __testing.buildBotSocketUrl({ url: "https://gateway.threa.io/api/", path: "/socket.io/", namespace: "/bot" })
    ).toBe("https://gateway.threa.io/api/bot")
  })
})

describe("fetchWsHintFromConfig", () => {
  const originalFetch = globalThis.fetch
  let calls: Array<{ url: string; init?: RequestInit }>

  beforeEach(() => {
    calls = []
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init })
      return handler(url, init)
    }) as typeof fetch
  }

  test("returns the parsed hint when the workspace router responds with a wsUrl", async () => {
    mockFetch(() => new Response(JSON.stringify({ region: "eu-north-1", wsUrl: "wss://eu.threa.io" })))
    const result = await __testing.fetchWsHintFromConfig("https://app.threa.io/", "ws_123", "threa_bk_test")
    expect(result).toEqual({ hint: { url: "wss://eu.threa.io", path: "/socket.io/", namespace: "/bot" } })
    expect(calls[0]?.url).toBe("https://app.threa.io/api/workspaces/ws_123/config")
    expect((calls[0]?.init?.headers as Record<string, string>)?.Authorization).toBe("Bearer threa_bk_test")
  })

  test("surfaces HTTP failures so callers can log and fall back to polling", async () => {
    mockFetch(() => new Response("not found", { status: 404 }))
    expect(await __testing.fetchWsHintFromConfig("https://app.threa.io", "ws_123", "threa_bk_test")).toEqual({
      error: "HTTP 404",
    })
  })

  test("reports missing-wsUrl when the body omits the field (e.g. wrong endpoint hit)", async () => {
    mockFetch(() => new Response(JSON.stringify({ region: "eu-north-1" })))
    expect(await __testing.fetchWsHintFromConfig("https://app.threa.io", "ws_123", "threa_bk_test")).toEqual({
      error: "missing wsUrl",
    })
  })

  test("surfaces network errors so the resolver doesn't throw out of the polling loop", async () => {
    mockFetch(() => {
      throw new Error("ECONNREFUSED")
    })
    const result = await __testing.fetchWsHintFromConfig("https://app.threa.io", "ws_123", "threa_bk_test")
    expect("error" in result && result.error).toContain("ECONNREFUSED")
  })

  test("WS_RESOLVE_RETRY_MS gates retries to once a minute", () => {
    expect(__testing.WS_RESOLVE_RETRY_MS).toBe(60_000)
  })
})

describe("sanitizeInstanceIdSegment", () => {
  test("replaces dots (macOS hostname `.lan` regression)", () => {
    expect(__testing.sanitizeInstanceIdSegment("kristoffers-mbp.lan")).toBe("kristoffers-mbp-lan")
  })

  test("collapses runs of unsafe chars into a single dash", () => {
    expect(__testing.sanitizeInstanceIdSegment("host..name....with.dots")).toBe("host-name-with-dots")
  })

  test("strips leading and trailing separators", () => {
    expect(__testing.sanitizeInstanceIdSegment(".lan.")).toBe("lan")
    expect(__testing.sanitizeInstanceIdSegment("---abc---")).toBe("abc")
  })

  test("passes through already-safe identifiers unchanged", () => {
    expect(__testing.sanitizeInstanceIdSegment("pi-host-abc123")).toBe("pi-host-abc123")
    expect(__testing.sanitizeInstanceIdSegment("UPPER_lower-09")).toBe("UPPER_lower-09")
  })

  test("collapses to empty when the input contains no safe characters at all", () => {
    expect(__testing.sanitizeInstanceIdSegment("...")).toBe("")
    expect(__testing.sanitizeInstanceIdSegment("")).toBe("")
  })
})

describe("migrateInstanceId", () => {
  test("rewrites a dotted macOS-hostname id without losing the random suffix", () => {
    // Realistic shape of a macOS-derived id (`hostname()` returns `*.lan`).
    // The server `bot:hello` schema (`^[A-Za-z0-9_-]+$`) rejects the dot, so
    // the migration must preserve the suffix while normalising the host.
    expect(__testing.migrateInstanceId("pi-kristoffers-mbp.lan-249fae79")).toBe("pi-kristoffers-mbp-lan-249fae79")
  })

  test("leaves an already-valid id untouched (no churn for healthy installs)", () => {
    expect(__testing.migrateInstanceId("pi-host-abc12345")).toBe("pi-host-abc12345")
  })

  test("falls back to a fresh `pi-<random>` id when sanitization collapses to empty", () => {
    const result = __testing.migrateInstanceId("...")
    expect(result).toMatch(/^pi-[0-9a-f]{8}$/)
  })

  test("returns a fresh id when the stored value is not a string", () => {
    // `config.instanceId` is loaded via `JSON.parse` from disk and only the
    // three required string fields are validated. A hand-edited config could
    // park anything here, so we must tolerate non-strings without crashing.
    expect(__testing.migrateInstanceId(undefined)).toMatch(/^pi-[0-9a-f]{8}$/)
    expect(__testing.migrateInstanceId(null)).toMatch(/^pi-[0-9a-f]{8}$/)
    expect(__testing.migrateInstanceId(42)).toMatch(/^pi-[0-9a-f]{8}$/)
    expect(__testing.migrateInstanceId({})).toMatch(/^pi-[0-9a-f]{8}$/)
  })

  test("returns a fresh id when the stored value is an empty string", () => {
    expect(__testing.migrateInstanceId("")).toMatch(/^pi-[0-9a-f]{8}$/)
  })
})

describe("formatHelloAckDetails", () => {
  test("renders Zod fieldErrors as a parenthesized summary", () => {
    expect(
      __testing.formatHelloAckDetails({
        instanceId: ["instanceId must be 1-64 chars of [A-Za-z0-9_-]"],
      })
    ).toBe(' (instanceId: ["instanceId must be 1-64 chars of [A-Za-z0-9_-]"])')
  })

  test("returns empty when details are missing or not an object", () => {
    expect(__testing.formatHelloAckDetails(undefined)).toBe("")
    expect(__testing.formatHelloAckDetails(null)).toBe("")
    expect(__testing.formatHelloAckDetails("nope")).toBe("")
  })

  test("returns empty when details are an empty object (server sent the field but no entries)", () => {
    expect(__testing.formatHelloAckDetails({})).toBe("")
  })
})

describe("appendCapped", () => {
  test("appends below the cap and reports no truncation", () => {
    expect(__testing.appendCapped("abc", "def", 10)).toEqual({ text: "abcdef", truncated: false })
  })

  test("truncates at the cap and reports the overflow", () => {
    expect(__testing.appendCapped("abcdef", "ghijklm", 8)).toEqual({ text: "abcdefgh", truncated: true })
  })

  test("returns the existing buffer untouched once the cap is already reached", () => {
    expect(__testing.appendCapped("abcdefgh", "more", 8)).toEqual({ text: "abcdefgh", truncated: true })
  })
})

describe("formatShellResult", () => {
  const baseResult = {
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    exitCode: 0,
    signal: null,
    timedOut: false,
    elapsedMs: 142,
    spawnError: null,
  }

  test("formats a successful run with stdout and exit 0", () => {
    const body = __testing.formatShellResult("ls -la", { ...baseResult, stdout: "drwx 1\ndrwx 2\n" })
    expect(body).toContain("```\n$ ls -la\ndrwx 1\ndrwx 2\n```")
    expect(body).toContain("exit 0")
    // Don't pin the duration formatter's wording — just verify the elapsed segment is there.
    expect(body).toContain("·")
  })

  test("renders stderr in its own block only when present", () => {
    const without = __testing.formatShellResult("true", baseResult)
    expect(without).not.toContain("stderr")

    const withErr = __testing.formatShellResult("missing-bin", {
      ...baseResult,
      stdout: "",
      stderr: "command not found\n",
      exitCode: 127,
    })
    expect(withErr).toContain("**stderr**")
    expect(withErr).toContain("command not found")
    expect(withErr).toContain("exit 127")
  })

  test("reports timeout instead of exit code when the command was killed by the watchdog", () => {
    const body = __testing.formatShellResult("sleep 999", {
      ...baseResult,
      stdout: "",
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      elapsedMs: __testing.SHELL_TIMEOUT_MS,
    })
    expect(body).toContain("timed out after")
    expect(body).not.toContain("exit 0")
  })

  test("appends 'output truncated' when either stream hit the cap", () => {
    const body = __testing.formatShellResult("yes | head", {
      ...baseResult,
      stdout: "y\n".repeat(10),
      stdoutTruncated: true,
    })
    expect(body).toContain("output truncated")
  })

  test("surfaces spawn errors instead of swallowing them as exit code", () => {
    // INV-11: a spawn failure (e.g. cwd doesn't exist) must be visible to the
    // user, not silently presented as `exit ?`.
    const body = __testing.formatShellResult("anything", {
      ...baseResult,
      stdout: "",
      exitCode: null,
      spawnError: "ENOENT: cwd missing",
    })
    expect(body).toContain("spawn failed: ENOENT: cwd missing")
  })
})

describe("execShellCommand", () => {
  test("runs a successful command and captures stdout with exit 0", async () => {
    const result = await __testing.execShellCommand("printf 'hello\\nworld\\n'", process.cwd())
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("hello\nworld\n")
    expect(result.stderr).toBe("")
    expect(result.timedOut).toBe(false)
    expect(result.spawnError).toBeNull()
  })

  test("captures non-zero exit codes without throwing", async () => {
    const result = await __testing.execShellCommand("exit 7", process.cwd())
    expect(result.exitCode).toBe(7)
    expect(result.spawnError).toBeNull()
  })

  test("reports a spawn error when the working directory does not exist", async () => {
    const result = await __testing.execShellCommand("echo ok", "/definitely/does/not/exist-xyz-12345")
    expect(result.spawnError).not.toBeNull()
    expect(result.exitCode).toBeNull()
  })

  test("caps stdout at SHELL_MAX_OUTPUT_CHARS and flags truncation", async () => {
    // Generate well over the cap to make sure we actually hit it.
    const result = await __testing.execShellCommand(
      `node -e 'process.stdout.write("a".repeat(${__testing.SHELL_MAX_OUTPUT_CHARS + 1000}))'`,
      process.cwd()
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout.length).toBe(__testing.SHELL_MAX_OUTPUT_CHARS)
    expect(result.stdoutTruncated).toBe(true)
  })

  test("escalates SIGTERM to SIGKILL when the child traps and ignores SIGTERM", async () => {
    // A bare `trap '' TERM` sh-builtin ignores SIGTERM. Without escalation
    // the watchdog would sit forever. We've previously regressed this by
    // gating the SIGKILL on `child.killed`, which flips to `true` the moment
    // `kill()` is called and so blocked the escalation — pinned via the
    // `settled` flag now. 150ms timeout + 250ms grace keeps the test fast.
    const result = await __testing.execShellCommand("trap '' TERM; sleep 5", process.cwd(), {
      timeoutMs: 150,
      sigkillGraceMs: 250,
    })
    expect(result.timedOut).toBe(true)
    expect(result.signal).toBe("SIGKILL")
    expect(result.elapsedMs).toBeLessThan(2_000)
  })
})

describe("formatShortDuration", () => {
  test("renders sub-second durations as integer milliseconds", () => {
    expect(__testing.formatShortDuration(0)).toBe("0ms")
    expect(__testing.formatShortDuration(142)).toBe("142ms")
    expect(__testing.formatShortDuration(999)).toBe("999ms")
  })

  test("renders sub-10s durations with two decimals", () => {
    expect(__testing.formatShortDuration(1_000)).toBe("1.00s")
    expect(__testing.formatShortDuration(2_345)).toBe("2.35s")
    expect(__testing.formatShortDuration(9_999)).toBe("10.00s")
  })

  test("renders 10s–59s durations with one decimal", () => {
    expect(__testing.formatShortDuration(10_000)).toBe("10.0s")
    expect(__testing.formatShortDuration(59_949)).toBe("59.9s")
  })

  test("falls through to formatDuration at the minute boundary", () => {
    // The shell timeout is 60_000ms exactly; the boundary lands on
    // `formatDuration` so the longer-format wording stays consistent.
    expect(__testing.formatShortDuration(60_000)).toBe("1 min")
    expect(__testing.formatShortDuration(125_000)).toBe("2 min")
  })
})

describe("defaultDisplayNameFor", () => {
  test("derives `Pi remote - <dirname>` from the working directory tail", () => {
    expect(__testing.defaultDisplayNameFor("/Users/kris/dev/personal/threa")).toBe("Pi remote - threa")
  })

  test("ignores a trailing slash on the working directory", () => {
    expect(__testing.defaultDisplayNameFor("/Users/kris/dev/personal/threa/")).toBe("Pi remote - threa")
  })

  test("falls back to `session` when the working directory is the filesystem root", () => {
    expect(__testing.defaultDisplayNameFor("/")).toBe("Pi remote - session")
  })

  test("uses a configured override as a prefix and still appends the dirname", () => {
    // The override no longer wins outright — every scratchpad needs the dirname
    // to be distinguishable in the sidebar.
    expect(__testing.defaultDisplayNameFor("/Users/kris/dev/personal/threa", "Work Pi")).toBe("Work Pi - threa")
  })

  test("treats an empty configured override as unset", () => {
    expect(__testing.defaultDisplayNameFor("/Users/kris/dev/personal/threa", "")).toBe("Pi remote - threa")
  })

  test("treats the legacy `Local Pi` default as unset so old configs stop colliding", () => {
    // `configTemplate` used to bake `"Local Pi"` into the JSON the user pasted
    // during /configure, and that override beat the dirname — every scratchpad
    // across every repo ended up named "Local Pi". Stop honoring it.
    expect(__testing.defaultDisplayNameFor("/Users/kris/dev/personal/threa", "Local Pi")).toBe("Pi remote - threa")
  })

  test("ignores surrounding whitespace on the override", () => {
    expect(__testing.defaultDisplayNameFor("/Users/kris/dev/personal/threa", "   ")).toBe("Pi remote - threa")
    expect(__testing.defaultDisplayNameFor("/Users/kris/dev/personal/threa", "  Work Pi  ")).toBe("Work Pi - threa")
  })
})
