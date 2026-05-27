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
      sessionControlCommands: ["compact", "model", "thinking", "skill", "reload"],
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

  test("builds scratchpad URLs from configured base URL and stream path", () => {
    expect(__testing.buildScratchpadUrl("https://app.threa.io", "/workspaces/ws_123/streams/stream_123")).toBe(
      "https://app.threa.io/workspaces/ws_123/streams/stream_123"
    )
    expect(__testing.buildScratchpadUrl("https://app.threa.io/app/", "streams/stream_123")).toBe(
      "https://app.threa.io/app/streams/stream_123"
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
