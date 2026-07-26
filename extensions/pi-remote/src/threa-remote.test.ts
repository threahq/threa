import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import threaRemote, { __testing } from "./threa-remote"

let testStorageDirectory: string

beforeEach(async () => {
  await __testing.resetRuntimeForTesting()
  testStorageDirectory = mkdtempSync(join(tmpdir(), "pi-remote-test-"))
  await __testing.setStorageDirectoryForTesting(testStorageDirectory)
})

afterEach(async () => {
  await __testing.resetRuntimeForTesting()
  rmSync(testStorageDirectory, { recursive: true, force: true })
})

describe("Pi remote trace safety", () => {
  test("selects temporary storage only for test entrypoints", () => {
    expect(__testing.defaultStorageDirectoryForTesting("/repo/src/threa-remote.test.ts")).not.toBe(
      join(homedir(), ".pi", "agent")
    )
    expect(__testing.defaultStorageDirectoryForTesting("/usr/local/bin/pi")).toBe(join(homedir(), ".pi", "agent"))
  })

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
      sessionControlCommands: [
        "compact",
        "model",
        "thinking",
        "skill",
        "reload",
        "shell",
        "steer",
        "stop",
        "kick",
        "carry-on",
      ],
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

  test("parses session-control commands from prompt markdown", () => {
    expect(__testing.parseSessionControlCommand("/model ")).toEqual({ name: "model", args: "" })
    expect(__testing.parseSessionControlCommand("/model anthropic/claude-sonnet-4-6")).toEqual({
      name: "model",
      args: "anthropic/claude-sonnet-4-6",
    })
    expect(__testing.parseSessionControlCommand("  /thinking high  ")).toEqual({ name: "thinking", args: "high" })
    expect(__testing.parseSessionControlCommand("/shell echo hello")).toEqual({ name: "shell", args: "echo hello" })
    expect(__testing.parseSessionControlCommand("/steer check the failing test first")).toEqual({
      name: "steer",
      args: "check the failing test first",
    })
    expect(__testing.parseSessionControlCommand("/stop")).toEqual({ name: "stop", args: "" })
    expect(__testing.parseSessionControlCommand("/kick")).toEqual({ name: "kick", args: "" })
  })

  test("rejects prompts that do not look like session-control commands", () => {
    expect(__testing.parseSessionControlCommand("/remote-control status")).toBeNull()
    expect(__testing.parseSessionControlCommand("not a command")).toBeNull()
    expect(__testing.parseSessionControlCommand("I tried /model but it failed")).toBeNull()
    expect(__testing.parseSessionControlCommand("/")).toBeNull()
  })

  test("resolves session-control command from metadata when present", () => {
    const invocation = {
      id: "binv_1",
      activeStreamId: "stream_1",
      sourceMessageId: "msg_1",
      promptMarkdown: "/model ",
      claimToken: "claim",
      claimExpiresAt: null,
      requiredCapability: "active-scratchpad",
      metadata: { command: { id: "cmd_1", name: "thinking", args: "high", executionKind: "bot-runtime" } },
    }
    expect(__testing.resolveSessionControlCommand(invocation)).toEqual({
      id: "cmd_1",
      name: "thinking",
      args: "high",
      executionKind: "bot-runtime",
    })
  })

  test("does not mistake an active-scratchpad message for a session-control command", () => {
    const invocation = {
      id: "binv_1",
      activeStreamId: "stream_1",
      sourceMessageId: "msg_1",
      promptMarkdown: "/steer I want option 2",
      claimToken: "claim",
      claimExpiresAt: null,
      requiredCapability: "active-scratchpad",
    }
    expect(__testing.resolveSessionControlCommand(invocation)).toBeNull()
  })

  test("preserves non-steer command fallback for active-scratchpad messages", () => {
    const invocation = {
      id: "binv_1",
      activeStreamId: "stream_1",
      sourceMessageId: "msg_1",
      promptMarkdown: "/model openai-codex/gpt-5.6-sol",
      claimToken: "claim",
      claimExpiresAt: null,
      requiredCapability: "active-scratchpad",
    }
    expect(__testing.resolveSessionControlCommand(invocation)).toEqual({
      id: "msg_1",
      name: "model",
      args: "openai-codex/gpt-5.6-sol",
      executionKind: "bot-runtime",
    })
  })

  test("formats Pi mid-turn steers like normal user messages", () => {
    expect(__testing.formatSteerPrompt("I want option 2")).toBe("I want option 2")
    expect(
      __testing.formatSteerPrompt(
        "Look at this image",
        "Attachments saved into this session's working directory — read them from these paths:\n- image.png → /tmp/image.png"
      )
    ).toBe(
      "Look at this image\n\nAttachments saved into this session's working directory — read them from these paths:\n- image.png → /tmp/image.png"
    )
  })

  test("does not treat mention invocations as session-control commands", () => {
    const invocation = {
      id: "binv_1",
      activeStreamId: "stream_1",
      sourceMessageId: "msg_1",
      promptMarkdown: "/model ",
      claimToken: "claim",
      claimExpiresAt: null,
      requiredCapability: "mentionable",
    }
    expect(__testing.resolveSessionControlCommand(invocation)).toBeNull()
  })

  test("falls back to parsing prompt for session-control invocations missing metadata", () => {
    const invocation = {
      id: "binv_1",
      activeStreamId: "stream_1",
      sourceMessageId: "msg_1",
      promptMarkdown: "/thinking high",
      claimToken: "claim",
      claimExpiresAt: null,
      requiredCapability: "session-control",
    }
    expect(__testing.resolveSessionControlCommand(invocation)).toEqual({
      id: "msg_1",
      name: "thinking",
      args: "high",
      executionKind: "bot-runtime",
    })
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

  test("uses only the last assistant message as the reply, not the concatenated narration", () => {
    // During an agentic turn the model emits one assistant message per step
    // ("I'll rebase…", "Running the suite…", …). Only the final summary is the
    // user-facing answer; the intermediate narration must stay in the trace,
    // not get joined into the posted reply.
    expect(
      __testing.resolveFinalText(
        {},
        {
          assistantTexts: [
            "I'll rebase the PR worktree onto fresh origin/main.",
            "Rebase completed cleanly and force-pushed with lease.",
            "Done.\n- Rebased onto b328a444\n- CI is green",
          ],
          otherTexts: [],
        }
      )
    ).toBe("Done.\n- Rebased onto b328a444\n- CI is green")
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

  test("textFromAgentMessages keeps only the last assistant message from the fallback scan", () => {
    expect(
      __testing.textFromAgentMessages([
        { role: "assistant", content: "I'll rebase onto origin/main." },
        { role: "assistant", content: "Rebase completed cleanly." },
        { role: "assistant", content: "Done. CI is green." },
      ])
    ).toBe("Done. CI is green.")
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

  // The 2026-07-03 Pi-Orchestrator failure: opencode's gateway 502'd every
  // call, the client THREW (so `after_provider_response` never fired and
  // providerError stayed unset), and each errored assistant message had empty
  // content plus `stopReason: "error"`. The turn fell through every branch to
  // the "Done." fallback — the user asked "Did I mess up?" and got "Done.".
  test("surfaces a model error carried on an errored assistant message instead of Done.", () => {
    const messages = [
      { role: "user", content: "Hi" },
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "502 status code (no body)",
        provider: "opencode-go",
        model: "deepseek-v4-flash",
      },
    ]
    expect(__testing.resolveFinalText({ messages }, { assistantTexts: [], otherTexts: [] })).toBe(
      "⚠️ Model call failed (opencode-go/deepseek-v4-flash): 502 status code (no body). Try /model to switch models."
    )
  })

  test("prefers the modelError captured at message_end when agent_end carries no messages", () => {
    const modelError =
      "⚠️ Model call failed (opencode-go/deepseek-v4-flash): 502 status code (no body). Try /model to switch models."
    expect(__testing.resolveFinalText({}, { assistantTexts: [], otherTexts: [], modelError })).toBe(modelError)
  })

  test("a successful assistant message after an errored one means the retry recovered", () => {
    const messages = [
      { role: "assistant", content: [], stopReason: "error", errorMessage: "502 status code (no body)" },
      { role: "assistant", content: "Recovered on retry — here is the answer." },
    ]
    expect(__testing.trailingModelError(messages)).toBeUndefined()
    expect(__testing.resolveFinalText({ messages }, { assistantTexts: [], otherTexts: [] })).toBe(
      "Recovered on retry — here is the answer."
    )
  })

  test("appends the model error when narration exists but the final model call died", () => {
    const messages = [
      { role: "assistant", content: "Let me rebase the branch first." },
      { role: "assistant", content: [], stopReason: "error", errorMessage: "502 status code (no body)" },
    ]
    expect(
      __testing.resolveFinalText({ messages }, { assistantTexts: ["Let me rebase the branch first."], otherTexts: [] })
    ).toBe(
      "Let me rebase the branch first.\n\n⚠️ Model call failed: 502 status code (no body). Try /model to switch models."
    )
  })

  test("extractModelError formats without a provider/model pair and defaults a blank message", () => {
    expect(__testing.extractModelError({ role: "assistant", stopReason: "error", errorMessage: "  " })).toBe(
      "⚠️ Model call failed: unknown error. Try /model to switch models."
    )
    expect(
      __testing.extractModelError({ role: "assistant", stopReason: "stop", errorMessage: "irrelevant" })
    ).toBeUndefined()
    expect(__testing.extractModelError({ role: "user", stopReason: "error" })).toBeUndefined()
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

  test("buildRetryPrompt folds queued carry-on texts into the retry (oldest first)", () => {
    expect(__testing.buildRetryPrompt("original prompt", [])).toBe("original prompt")
    const folded = __testing.buildRetryPrompt("original prompt", ["first", "second"])
    expect(folded).toContain("original prompt")
    expect(folded).toContain("queued while the session was rate-limited")
    expect(folded.indexOf("1. first")).toBeLessThan(folded.indexOf("2. second"))
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
        "defaultDisplayName": " Local Pi ",
        "defaultLabel": " Pi remote "
      }`)
    ).toEqual({
      baseUrl: "https://app.threa.io/",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
      pollMs: 1500,
      defaultDisplayName: "Local Pi",
      defaultLabel: "Pi remote",
    })
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

  test("WS_BACKSTOP_POLL_MS is the 15-minute edge-billed safety cadence", () => {
    // Every backstop tick is an HTTP claim through the billed edge Worker; the
    // socket push is the real delivery path. See the constant's comment.
    expect(__testing.WS_BACKSTOP_POLL_MS).toBe(15 * 60 * 1000)
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

  test("creates websocket-safe instance ids", () => {
    const id = __testing.createInstanceId()
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(id.length).toBeLessThanOrEqual(64)
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

describe("buildPersistedConfig", () => {
  test("preserves hand-edited top-level fields from on-disk config not present in memory", () => {
    const result = __testing.buildPersistedConfig(
      {
        baseUrl: "https://app.threa.io",
        workspaceId: "ws_123",
        apiKey: "threa_bk_test",
        linkedSessions: {
          session_a: {
            linkId: "a",
            rootStreamId: "s1",
            activeStreamId: "s1",
            runtimeSessionId: "rs1",
            streamUrlPath: "/s1",
          },
        },
      } as never,
      {
        defaultLabel: "coding",
        pollMs: 5000,
      } as never
    )
    // In-memory required fields present
    expect(result.baseUrl).toBe("https://app.threa.io")
    expect(result.workspaceId).toBe("ws_123")
    // Hand-edited fields from on-disk absent from the in-memory config survive
    expect(result.defaultLabel).toBe("coding")
    expect(result.pollMs).toBe(5000)
    // linkedSessions from in-memory still present
    expect(result.linkedSessions).toMatchObject({ session_a: { linkId: "a" } })
  })

  test("in-memory defined fields override on-disk values", () => {
    const result = __testing.buildPersistedConfig(
      {
        baseUrl: "https://staging.threa.io",
        workspaceId: "ws_123",
        apiKey: "threa_bk_test",
      } as never,
      {
        baseUrl: "https://app.threa.io",
      } as never
    )
    expect(result.baseUrl).toBe("https://staging.threa.io")
  })

  test("merges linkedSessions from both sides, in-memory keys win", () => {
    const result = __testing.buildPersistedConfig(
      {
        baseUrl: "https://app.threa.io",
        workspaceId: "ws_123",
        apiKey: "threa_bk_test",
        linkedSessions: {
          session_b: {
            linkId: "b",
            rootStreamId: "s1",
            activeStreamId: "s1",
            runtimeSessionId: "rs2",
            streamUrlPath: "/s1",
          },
        },
      } as never,
      {
        linkedSessions: {
          session_a: {
            linkId: "a",
            rootStreamId: "s1",
            activeStreamId: "s1",
            runtimeSessionId: "rs1",
            streamUrlPath: "/s1",
          },
        },
      } as never
    )
    expect(result.linkedSessions).toMatchObject({
      session_a: { linkId: "a" },
      session_b: { linkId: "b" },
    })
  })

  test("removes migrated global enabled flag from output", () => {
    const result = __testing.buildPersistedConfig(
      {
        baseUrl: "https://app.threa.io",
        workspaceId: "ws_123",
        apiKey: "threa_bk_test",
        enabled: true,
      } as never,
      { enabled: true } as never
    )
    expect(result.enabled).toBeUndefined()
  })

  test("migrates global streamCursors from either side", () => {
    const result = __testing.buildPersistedConfig(
      {
        baseUrl: "https://app.threa.io",
        workspaceId: "ws_123",
        apiKey: "threa_bk_test",
        streamCursors: { stream_b: "50" },
      } as never,
      {
        streamCursors: { stream_a: "42" },
      } as never
    )
    expect(result.streamCursors).toMatchObject({ stream_a: "42", stream_b: "50" })
  })

  test("skips writing streamCursors when neither side has cursors", () => {
    const result = __testing.buildPersistedConfig(
      {
        baseUrl: "https://app.threa.io",
        workspaceId: "ws_123",
        apiKey: "threa_bk_test",
      } as never,
      {} as never
    )
    expect(result.streamCursors).toBeUndefined()
  })
})

describe("Pi reload session control", () => {
  test("completes the control claim then queues reload through a command context", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>()
    const followUps: Array<{ text: string; options: unknown }> = []
    const pi = {
      registerCommand: (name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) =>
        commands.set(name, options),
      on: () => {},
      sendUserMessage: (text: string, options: unknown) => followUps.push({ text, options }),
    }
    threaRemote(pi as never)
    __testing.setConfigForTesting({
      baseUrl: "https://example.test",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
    })
    const writes: string[] = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      writes.push(String(input))
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch)
    const eventContext = {
      isIdle: () => true,
      cwd: "/tmp",
      sessionManager: { getSessionId: () => "runtime_reload_control" },
      modelRegistry: { getAvailable: () => [] },
    }

    try {
      await __testing.runReloadCommand(
        pi as never,
        {
          id: "binv_reload_control",
          activeStreamId: "stream_1",
          sourceMessageId: "msg_1",
          promptMarkdown: "/reload",
          claimToken: "claim_reload_control",
          claimedInstanceId: "pi-test",
          claimExpiresAt: null,
        } as never,
        eventContext as never
      )

      expect(writes.some((url) => url.endsWith("/bot-invocations/binv_reload_control/complete"))).toBe(true)
      expect(followUps).toEqual([{ text: "/threa-remote-reload", options: { deliverAs: "followUp" } }])
      expect(__testing.reloadPending()).toBe(true)

      let reloads = 0
      await commands.get("threa-remote-reload")!.handler("", {
        reload: async () => {
          reloads++
        },
      })
      expect(reloads).toBe(1)
      expect(__testing.reloadPending()).toBe(false)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe("Pi reconnect session control", () => {
  const invocation = {
    id: "binv_reconnect",
    claimToken: "claim",
    claimedInstanceId: "pi-instance",
    rootStreamId: "stream-root-exact",
  } as never
  const context = (idle: boolean) =>
    ({
      sessionManager: { getSessionId: () => "runtime-exact" },
      modelRegistry: { getAvailable: () => [] },
      isIdle: () => idle,
    }) as never

  beforeEach(() => {
    process.env.TMUX_PANE = "%9"
    __testing.setConfigForTesting({
      baseUrl: "https://app.threa.io",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
      linkedSessions: {
        "runtime-exact": {
          enabled: true,
          instanceId: "pi-instance",
          runtimeSessionId: "runtime-exact",
          rootStreamId: "stream-root-exact",
          activeStreamId: "stream-root-exact",
          streamUrlPath: "/streams/stream-root-exact",
        },
      },
    })
  })

  afterEach(() => {
    delete process.env.TMUX_PANE
    __testing.clearPendingForTesting()
    __testing.setConfigForTesting(undefined)
  })

  test("uses exact routing, gates start on ack, preserves force, and stays nonaccepting", async () => {
    for (const force of [false, true]) {
      const prepared: unknown[][] = []
      let started = false
      await __testing.runReconnectCommand(invocation, force ? "--force" : "", context(true), {
        available: () => true,
        prepare: (...args: unknown[]) => {
          prepared.push(args)
          return () => {
            started = true
          }
        },
        complete: async () => true,
        heartbeat: async () => undefined,
      } as never)
      expect({ prepared, started, guarded: __testing.reconnectPending() }).toEqual({
        prepared: [["runtime-exact", "stream-root-exact", { force }]],
        started: true,
        guarded: true,
      })
      expect(await __testing.claimNextInvocation(context(true))).toBeNull()
      __testing.clearPendingForTesting()
    }
  })

  test("advertises reconnect only for the exact current reconnect link", () => {
    const ctx = context(true)
    const validLink = {
      enabled: true,
      instanceId: "pi-instance",
      runtimeSessionId: "runtime-exact",
      rootStreamId: "stream-root-exact",
      activeStreamId: "stream-root-exact",
      streamUrlPath: "/streams/stream-root-exact",
    }
    const advertised = () =>
      (__testing.buildRuntimeCapabilities(ctx, () => true).sessionControlCommands as string[]).includes("reconnect")

    expect(advertised()).toBe(true)
    for (const invalidLink of [
      { ...validLink, enabled: false },
      { ...validLink, rootStreamId: "" },
      { ...validLink, rootStreamId: "   " },
      { ...validLink, runtimeSessionId: "runtime-other" },
      { ...validLink, instanceId: undefined },
    ]) {
      __testing.setConfigForTesting({
        baseUrl: "https://app.threa.io",
        workspaceId: "ws_123",
        apiKey: "threa_bk_test",
        linkedSessions: { "runtime-exact": invalidLink },
      })
      expect(advertised()).toBe(false)
    }

    __testing.setConfigForTesting({
      baseUrl: "https://app.threa.io",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
      linkedSessions: { "runtime-exact": validLink },
    })
    delete process.env.TMUX_PANE
    expect(advertised()).toBe(false)
    process.env.TMUX_PANE = "%9"
    expect(
      (__testing.buildRuntimeCapabilities(ctx, () => false).sessionControlCommands as string[]).includes("reconnect")
    ).toBe(false)
  })

  test("advertises and sends an allowed key only for the exact link using Pi's PID", async () => {
    const commands = __testing.buildRuntimeCapabilities(context(true), () => true).sessionControlCommands as string[]
    expect(commands).toContain("key")

    const sent: unknown[][] = []
    const messages: string[] = []
    await __testing.runKeyCommand(invocation, "ctrl-u", context(true), {
      send: (...args: unknown[]) => sent.push(args),
      complete: async (_invocation: unknown, message: string) => {
        messages.push(message)
        return true
      },
    } as never)
    expect({ sent, messages }).toEqual({
      sent: [["ctrl-u", process.pid]],
      messages: ["Sent `ctrl-u` to the linked Pi session."],
    })

    delete process.env.TMUX_PANE
    expect(
      __testing.buildRuntimeCapabilities(context(true), () => true).sessionControlCommands as string[]
    ).not.toContain("key")
  })

  test("stale root, instance, or relinked runtime sends no key", async () => {
    let sends = 0
    const staleInvocations = [
      { ...invocation, rootStreamId: "stream-root-stale" },
      { ...invocation, claimedInstanceId: "pi-instance-stale" },
    ]
    for (const staleInvocation of staleInvocations) {
      await expect(
        __testing.runKeyCommand(staleInvocation as never, "enter", context(true), {
          send: () => sends++,
          complete: async () => true,
        } as never)
      ).rejects.toThrow("Key control is unavailable")
    }

    __testing.setConfigForTesting({
      baseUrl: "https://app.threa.io",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
      linkedSessions: {
        "runtime-exact": {
          enabled: true,
          instanceId: "pi-instance-new",
          runtimeSessionId: "runtime-exact",
          rootStreamId: "stream-root-new",
          activeStreamId: "stream-root-new",
          streamUrlPath: "/streams/stream-root-new",
        },
      },
    })
    await expect(
      __testing.runKeyCommand(invocation, "enter", context(true), {
        send: () => sends++,
        complete: async () => true,
      } as never)
    ).rejects.toThrow("Key control is unavailable")
    expect(sends).toBe(0)
  })

  test("rejects malformed key args without sending", async () => {
    const messages: string[] = []
    let sends = 0
    for (const args of ["Enter", " enter", "enter ", "enter down", "-t", "%2", "unknown"]) {
      await __testing.runKeyCommand(invocation, args, context(true), {
        send: () => {
          sends++
        },
        complete: async (_invocation: unknown, message: string) => {
          messages.push(message)
          return true
        },
      } as never)
    }
    expect({ sends, messages }).toEqual({ sends: 0, messages: Array(7).fill("Usage: `/key <name>`.") })
  })

  test("a claim from link A cannot prepare or ack after relinking to B", async () => {
    let prepared = 0
    let acknowledged = 0
    for (const staleInvocation of [
      { ...invocation, rootStreamId: "stream-root-a" },
      { ...invocation, claimedInstanceId: "pi-instance-a" },
    ]) {
      await expect(
        __testing.runReconnectCommand(staleInvocation as never, "", context(true), {
          available: () => true,
          prepare: () => {
            prepared++
            return () => undefined
          },
          complete: async () => {
            acknowledged++
            return true
          },
        } as never)
      ).rejects.toThrow("Harness reconnect is unavailable")
    }
    expect({ prepared, acknowledged }).toEqual({ prepared: 0, acknowledged: 0 })
  })

  test("accepts only empty args or exact --force", async () => {
    const messages: string[] = []
    let prepared = 0
    for (const args of ["--force ", " --force", "--force=yes", "extra"]) {
      await __testing.runReconnectCommand(invocation, args, context(true), {
        available: () => true,
        prepare: () => {
          prepared++
          return () => undefined
        },
        complete: async (_invocation: unknown, message: string) => {
          messages.push(message)
          return true
        },
      } as never)
    }
    expect({ messages, prepared }).toEqual({
      messages: Array(4).fill("Usage: `/reconnect [--force]`."),
      prepared: 0,
    })
  })

  test("preparation failure and failed ack never start reconnect", async () => {
    expect(
      __testing.runReconnectCommand(invocation, "", context(true), {
        available: () => true,
        prepare: () => {
          throw new Error("preflight failed")
        },
        complete: async () => true,
      } as never)
    ).rejects.toThrow("preflight failed")

    let started = false
    await __testing.runReconnectCommand(invocation, "", context(true), {
      available: () => true,
      prepare: () => () => {
        started = true
      },
      complete: async () => false,
      heartbeat: async () => undefined,
    } as never)
    expect(started).toBe(false)
    expect(__testing.reconnectPending()).toBe(false)
  })

  test("real plaintext completion finishes before start and completion failure prevents start", async () => {
    for (const completeOk of [true, false]) {
      const order: string[] = []
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input)
        order.push(url.includes("/complete") ? "complete" : "trace")
        return new Response(JSON.stringify({ data: {} }), {
          status: url.includes("/complete") && !completeOk ? 500 : 200,
          headers: { "content-type": "application/json" },
        })
      })
      const reconnect = __testing.runReconnectCommand(invocation, "", context(true), {
        available: () => true,
        prepare: () => () => order.push("start"),
        complete: __testing.completeInvocationWithMarkdown,
        heartbeat: async () => undefined,
      } as never)
      if (completeOk) await expect(reconnect).resolves.toBeUndefined()
      else await expect(reconnect).rejects.toThrow("500")
      expect(order.filter((step) => step !== "trace")).toEqual(completeOk ? ["complete", "start"] : ["complete"])
      fetchSpy.mockRestore()
      __testing.clearPendingForTesting()
    }
  })

  test("E2E key failure that only closes noResponse does not start reconnect", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (String(input).endsWith("/complete")) bodies.push(body)
      if (body.finalMessageMarkdown) {
        return new Response(JSON.stringify({ error: { code: "E2E_STREAM_PLAINTEXT_UNSUPPORTED" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    let started = false
    await __testing.runReconnectCommand({ ...invocation, sealedAck: { invalid: true } } as never, "", context(true), {
      available: () => true,
      prepare: () => () => {
        started = true
      },
      complete: __testing.completeInvocationWithMarkdown,
      heartbeat: async () => undefined,
    } as never)
    expect({ bodies, started }).toEqual({
      bodies: [
        expect.objectContaining({ finalMessageMarkdown: expect.any(String) }),
        expect.objectContaining({ noResponse: true }),
      ],
      started: false,
    })
    fetchSpy.mockRestore()
  })

  test("revalidates pinned link facts after ack and restores actual presence", async () => {
    for (const mutate of [
      (link: Record<string, unknown>) => (link.enabled = false),
      (link: Record<string, unknown>) => (link.rootStreamId = "stream-other"),
      (link: Record<string, unknown>) => (link.runtimeSessionId = "runtime-other"),
      (link: Record<string, unknown>) => (link.instanceId = "pi-other"),
    ]) {
      const link = {
        enabled: true,
        instanceId: "pi-instance",
        runtimeSessionId: "runtime-exact",
        rootStreamId: "stream-root-exact",
      }
      __testing.setConfigForTesting({
        baseUrl: "https://app.threa.io",
        workspaceId: "ws_123",
        apiKey: "threa_bk_test",
        linkedSessions: { "runtime-exact": link },
      })
      let started = false
      const presence: string[] = []
      await __testing.runReconnectCommand(invocation, "", context(true), {
        available: () => true,
        prepare: () => () => {
          started = true
        },
        complete: async () => {
          mutate(link)
          return true
        },
        heartbeat: async (status: string) => {
          presence.push(status)
        },
      } as never)
      expect({ started, presence: presence.at(-1) }).toEqual({
        started: false,
        presence: link.enabled ? "available" : "offline",
      })
      __testing.clearPendingForTesting()
    }
  })

  test("synchronous start failure restores the handoff state", async () => {
    await expect(
      __testing.runReconnectCommand(invocation, "", context(true), {
        available: () => true,
        prepare: () => () => {
          throw new Error("start failed")
        },
        complete: async () => true,
        heartbeat: async () => undefined,
      } as never)
    ).rejects.toThrow("start failed")
    expect(__testing.reconnectPending()).toBe(false)
  })

  test("force bypasses only local busy state and never an owned Threa invocation", async () => {
    const messages: string[] = []
    let prepared = 0
    const deps = {
      available: () => true,
      prepare: () => {
        prepared++
        return () => {}
      },
      complete: async (_invocation: unknown, message: string) => {
        messages.push(message)
        return true
      },
      heartbeat: async () => undefined,
    } as never
    await __testing.runReconnectCommand(invocation, "", context(false), deps)
    await __testing.runReconnectCommand(invocation, "--force", context(false), deps)
    __testing.clearPendingForTesting()
    __testing.beginPendingInvocation({ id: "binv_owned", claimToken: "owned" } as never)
    await __testing.runReconnectCommand(invocation, "--force", context(false), deps)
    expect({ messages, prepared }).toEqual({
      messages: [
        "Pi is busy; retry when idle or use `/reconnect --force`.",
        "Reconnect request accepted; attempting to resume the linked Pi session.",
        "A Threa invocation is still running; use `/stop` before reconnecting.",
      ],
      prepared: 1,
    })
  })
})

describe("claim drain serialization", () => {
  afterEach(() => {
    __testing.clearPendingForTesting()
    __testing.setConfigForTesting(undefined)
  })

  test("serializes concurrent callers and reruns after a coalesced wakeup", async () => {
    __testing.setConfigForTesting({
      baseUrl: "https://app.threa.io",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
      linkedSessions: { runtime: { enabled: true, instanceId: "pi-instance", runtimeSessionId: "runtime" } },
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let requests = 0
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      requests++
      await gate
      return new Response(JSON.stringify({ data: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    const ctx = {
      sessionManager: { getSessionId: () => "runtime" },
      isIdle: () => true,
      cwd: "/tmp",
    } as never
    const pi = {} as never

    const first = __testing.claimIfIdle(pi, ctx)
    const second = __testing.claimIfIdle(pi, ctx)
    expect(first).toBe(second)
    release()
    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(requests).toBe(2)
    fetchSpy.mockRestore()
  })

  test("stops draining on an empty claim during a rate-limit wait", async () => {
    __testing.setConfigForTesting({
      baseUrl: "https://app.threa.io",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
      linkedSessions: { runtime: { enabled: true, instanceId: "pi-instance", runtimeSessionId: "runtime" } },
    })
    __testing.setRateLimitWaitForTesting(true)
    let claimRequests = 0
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/bot-invocations/claim")) claimRequests++
      return new Response(JSON.stringify({ data: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    const ctx = {
      sessionManager: { getSessionId: () => "runtime" },
      isIdle: () => true,
      cwd: "/tmp",
      modelRegistry: { getAvailable: () => [] },
      ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_tone: string, text: string) => text } },
    } as never

    try {
      expect(await __testing.claimIfIdle({} as never, ctx)).toBe(true)
      expect(claimRequests).toBe(1)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("drains all pending invocations from one wakeup", async () => {
    __testing.setConfigForTesting({
      baseUrl: "https://app.threa.io",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
      linkedSessions: { runtime: { enabled: true, instanceId: "pi-instance", runtimeSessionId: "runtime" } },
    })
    const expectedMessages = Array.from({ length: 12 }, (_, index) => `message-${index + 1}`)
    const queued = [...expectedMessages]
    let claimRequests = 0
    const deliveries: Array<{ text: string; options?: { deliverAs: string } }> = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith("/bot-invocations/claim")) {
        const promptMarkdown = queued.shift()
        claimRequests++
        return new Response(
          JSON.stringify({
            data: promptMarkdown
              ? {
                  id: `binv_${promptMarkdown}`,
                  activeStreamId: "stream_1",
                  sourceMessageId: `msg_${promptMarkdown}`,
                  promptMarkdown,
                  claimToken: `claim_${promptMarkdown}`,
                  claimExpiresAt: null,
                }
              : null,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      }
      if (url.includes("/streams/stream_1/messages?")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    const ctx = {
      sessionManager: { getSessionId: () => "runtime" },
      isIdle: () => true,
      cwd: "/tmp",
      modelRegistry: { getAvailable: () => [] },
      ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_tone: string, text: string) => text } },
    } as never
    const pi = {
      sendUserMessage: (text: string, options?: { deliverAs: string }) => deliveries.push({ text, options }),
    } as never

    try {
      const result = await __testing.claimIfIdle(pi, ctx)
      expect({
        result,
        claimRequests,
        firstDeliveryEndsWithPrompt: deliveries[0]?.text.endsWith(`\n${expectedMessages[0]}`),
        deliveryOptions: deliveries.map(({ options }) => options),
        steeredTexts: deliveries.slice(1).map(({ text }) => text),
      }).toEqual({
        result: true,
        claimRequests: 13,
        firstDeliveryEndsWithPrompt: true,
        deliveryOptions: [undefined, ...Array.from({ length: 11 }, () => ({ deliverAs: "steer" }))],
        steeredTexts: expectedMessages.slice(1),
      })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("runtime reset drains an in-flight claim before teardown completes", async () => {
    __testing.setConfigForTesting({
      baseUrl: "https://app.threa.io",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
      linkedSessions: { runtime: { enabled: true, instanceId: "pi-instance", runtimeSessionId: "runtime" } },
    })
    let releaseClaim!: () => void
    const claimGate = new Promise<void>((resolve) => (releaseClaim = resolve))
    const writes: string[] = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith("/bot-invocations/claim")) {
        await claimGate
        return new Response(
          JSON.stringify({
            data: {
              id: "binv_reset",
              activeStreamId: "stream_1",
              sourceMessageId: "msg_1",
              promptMarkdown: "late work",
              claimToken: "claim_reset",
              claimExpiresAt: null,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      }
      if (url.endsWith("/bot-invocations/binv_reset/fail")) writes.push("fail")
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    const ctx = {
      sessionManager: { getSessionId: () => "runtime" },
      isIdle: () => true,
      cwd: "/tmp",
    } as never

    try {
      const claim = __testing.claimIfIdle({} as never, ctx)
      await Bun.sleep(0)
      let resetComplete = false
      const reset = __testing.resetRuntimeForTesting().then(() => {
        resetComplete = true
      })
      await Bun.sleep(0)
      expect(resetComplete).toBe(false)
      releaseClaim()
      expect(await claim).toBe(false)
      await reset
      expect({ resetComplete, writes }).toEqual({ resetComplete: true, writes: ["fail"] })
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe("session-scoped lifecycle isolation", () => {
  afterEach(() => {
    delete process.env.TMUX_PANE
    __testing.teardownTransport()
    __testing.setSupervisedRevivalBlockedForTesting(false)
    __testing.clearPendingForTesting()
    __testing.setConfigForTesting(undefined)
  })

  test("closes a claim returned after shutdown before teardown completes", async () => {
    const shutdownHandlers: Array<(event: unknown, ctx: unknown) => Promise<void>> = []
    threaRemote({
      registerCommand: () => {},
      on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
        if (event === "session_shutdown") shutdownHandlers.push(handler)
      },
    } as never)
    __testing.teardownTransport()
    __testing.setConfigForTesting({
      baseUrl: "https://example.test",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
      linkedSessions: { parent: { enabled: true, instanceId: "pi-parent", runtimeSessionId: "parent" } },
    })
    let releaseClaim!: () => void
    const claimGate = new Promise<void>((resolve) => (releaseClaim = resolve))
    const writes: string[] = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith("/bot-invocations/claim")) {
        await claimGate
        return new Response(
          JSON.stringify({
            data: {
              id: "binv_late",
              activeStreamId: "stream_1",
              sourceMessageId: "msg_1",
              promptMarkdown: "late work",
              claimToken: "claim_late",
              claimExpiresAt: null,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      }
      if (url.endsWith("/bot-invocations/binv_late/fail")) writes.push("fail")
      if (url.endsWith("/bot-runtime/presence")) writes.push("offline")
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    const ctx = {
      sessionManager: { getSessionId: () => "parent" },
      isIdle: () => true,
      cwd: "/tmp",
      ui: { setStatus: () => {}, notify: () => {} },
    } as never

    try {
      const claim = __testing.claimIfIdle({} as never, ctx)
      await Bun.sleep(0)
      const shutdown = shutdownHandlers[0]!({ reason: "quit" }, ctx)
      releaseClaim()
      expect(await claim).toBe(false)
      await shutdown
      expect(writes.at(0)).toBe("fail")
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("child shutdown preserves the parent claim while parent shutdown clears it without touching other storage", async () => {
    const shutdownHandlers: Array<(event: unknown, ctx: unknown) => Promise<void>> = []
    threaRemote({
      registerCommand: () => {},
      on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
        if (event === "session_shutdown") shutdownHandlers.push(handler)
      },
    } as never)
    const shutdown = shutdownHandlers[0]
    expect(shutdown).toBeDefined()

    const sentinelPath = __testing.storagePaths().configPath
    const sentinel = `${JSON.stringify({
      baseUrl: "https://sentinel.invalid",
      workspaceId: "ws_sentinel",
      apiKey: "sentinel-fixture-key",
      linkedSessions: { existing: { runtimeSessionId: "existing" } },
    })}\n`
    writeFileSync(sentinelPath, sentinel)
    const persistenceDirectory = mkdtempSync(join(tmpdir(), "pi-remote-persistence-"))
    await __testing.setStorageDirectoryForTesting(persistenceDirectory)

    __testing.setConfigForTesting({
      baseUrl: "https://app.threa.io",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
      linkedSessions: {
        parent: {
          enabled: true,
          runtimeSessionId: "parent",
          activeStreamId: "stream_a",
        },
      },
    })
    __testing.beginPendingInvocation({
      id: "binv_parent",
      activeStreamId: "stream_a",
      sourceMessageId: "msg_1",
      promptMarkdown: "run workflow",
      claimToken: "claim_1",
      claimedInstanceId: "pi-parent",
      claimExpiresAt: null,
    } as never)

    const requests: string[] = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      requests.push(String(input))
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch)
    const context = (sessionId: string) =>
      ({
        sessionManager: { getSessionId: () => sessionId },
        ui: { setStatus: () => {}, notify: () => {} },
      }) as never

    try {
      await shutdown({ reason: "quit" }, context("workflow-child"))
      expect({ claimActive: __testing.claimRenewTimerActive(), requestCount: requests.length }).toEqual({
        claimActive: true,
        requestCount: 0,
      })

      await shutdown({ reason: "quit" }, context("parent"))
      expect({ claimActive: __testing.claimRenewTimerActive(), madeRequests: requests.length > 0 }).toEqual({
        claimActive: false,
        madeRequests: true,
      })

      expect(readFileSync(sentinelPath, "utf8")).toBe(sentinel)
      const paths = __testing.storagePaths()
      const persisted = JSON.parse(readFileSync(paths.configPath, "utf8")) as Record<string, unknown>
      expect(persisted).toMatchObject({ workspaceId: "ws_123", apiKey: "threa_bk_test" })
      expect(readdirSync(persistenceDirectory).sort()).toEqual(["threa-remote-bik.json", "threa-remote.json"])
    } finally {
      fetchSpy.mockRestore()
      rmSync(persistenceDirectory, { recursive: true, force: true })
    }
  })
})

describe("reload claim continuity", () => {
  test("restores, renews, and completes the in-flight claim after the extension cache is cleared", async () => {
    const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void>>()
    const pi = {
      registerCommand: () => {},
      on: (event: string, handler: (event: unknown, ctx: any) => Promise<void>) => handlers.set(event, handler),
      sendUserMessage: () => {},
    }
    threaRemote(pi as never)

    const runtimeSessionId = "runtime_reload"
    const config = {
      baseUrl: "https://example.test",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
      linkedSessions: {
        [runtimeSessionId]: {
          enabled: true,
          instanceId: "pi-reload",
          runtimeSessionId,
          rootStreamId: "stream_1",
          activeStreamId: "stream_1",
        },
      },
    }
    let idle = false
    const ctx = {
      sessionManager: { getSessionId: () => runtimeSessionId, getBranch: () => [] },
      isIdle: () => idle,
      cwd: "/tmp",
      modelRegistry: { getAvailable: () => [] },
      ui: {
        setStatus: () => {},
        notify: () => {},
        theme: { fg: (_tone: string, text: string) => text },
      },
    }
    const writes: Array<{ url: string; body?: Record<string, unknown> }> = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = String(input)
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      writes.push({ url, body })
      if (url.endsWith(`/api/workspaces/${config.workspaceId}/config`)) {
        return new Response("", { status: 404 })
      }
      const data = url.endsWith("/bot-invocations/claim") ? null : {}
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch)

    try {
      __testing.setConfigForTesting(config)
      __testing.beginPendingInvocation({
        id: "binv_reload",
        activeStreamId: "stream_1",
        rootStreamId: "stream_1",
        sourceMessageId: "msg_1",
        promptMarkdown: "keep working",
        claimToken: "claim_reload",
        claimedInstanceId: "pi-reload",
        claimExpiresAt: null,
      } as never)

      await handlers.get("session_shutdown")!({ reason: "reload" }, ctx)
      const snapshotPath = __testing.pendingSnapshotPathForTesting(runtimeSessionId)
      expect(existsSync(snapshotPath)).toBe(true)

      await __testing.resetRuntimeForTesting()
      __testing.setConfigForTesting(config)
      expect(__testing.pendingInvocationId()).toBeUndefined()

      await handlers.get("session_start")!({ reason: "reload" }, ctx)
      expect(__testing.pendingInvocationId()).toBe("binv_reload")
      expect(__testing.claimRenewTimerActive()).toBe(true)
      expect(writes.some((write) => write.url.endsWith("/bot-invocations/binv_reload/renew"))).toBe(true)

      idle = true
      await handlers.get("agent_end")!(
        {
          messages: [
            { role: "user", content: "keep working" },
            { role: "assistant", content: "Finished after reload." },
          ],
        },
        ctx
      )

      const completion = writes.find((write) => write.url.endsWith("/bot-invocations/binv_reload/complete"))
      expect(completion?.body).toMatchObject({
        instanceId: "pi-reload",
        claimToken: "claim_reload",
        finalMessageMarkdown: "Finished after reload.",
      })
      expect(__testing.pendingInvocationId()).toBeUndefined()
      expect(__testing.claimRenewTimerActive()).toBe(false)
      expect(existsSync(snapshotPath)).toBe(false)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe("recovered completion retry", () => {
  test("keeps the restored claim and retries a transient completion failure", async () => {
    const runtimeSessionId = "runtime_recovered_completion"
    __testing.setConfigForTesting({
      baseUrl: "https://example.test",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
      linkedSessions: {
        [runtimeSessionId]: {
          enabled: true,
          instanceId: "pi-recovery",
          runtimeSessionId,
          rootStreamId: "stream_1",
          activeStreamId: "stream_1",
        },
      },
    })
    __testing.beginPendingInvocation({
      id: "binv_recovered_completion",
      activeStreamId: "stream_1",
      rootStreamId: "stream_1",
      sourceMessageId: "msg_1",
      promptMarkdown: "finish me",
      claimToken: "claim_recovery",
      claimedInstanceId: "pi-recovery",
      claimExpiresAt: null,
    } as never)
    const ctx = {
      sessionManager: { getSessionId: () => runtimeSessionId },
      isIdle: () => true,
      cwd: "/tmp",
      modelRegistry: { getAvailable: () => [] },
    }
    let completionAttempts = 0
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/bot-invocations/binv_recovered_completion/complete")) {
        completionAttempts++
        if (completionAttempts === 1) {
          return new Response(JSON.stringify({ error: "temporary" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          })
        }
      }
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch)

    try {
      __testing.scheduleRecoveredCompletion("Recovered reply.", ctx as never)
      await Bun.sleep(1200)
      expect(completionAttempts).toBe(2)
      expect(__testing.pendingInvocationId()).toBeUndefined()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe("claim renewal during a turn", () => {
  const invocation = {
    id: "binv_renew_1",
    activeStreamId: "stream_a",
    sourceMessageId: "msg_1",
    promptMarkdown: "do the thing",
    claimToken: "tok_1",
    claimedInstanceId: "pi-test-1",
    claimExpiresAt: null,
  }

  test("renew interval is comfortably inside the claim TTL", () => {
    // Two consecutive missed renews must still leave the claim alive — the
    // regression this guards: renewal riding on the 15-min WS backstop poll
    // while the server-side claim TTL is 120s (any turn longer than the TTL
    // lost its claim and the completion 404'd).
    expect(__testing.CLAIM_RENEW_INTERVAL_MS * 3).toBeLessThanOrEqual(__testing.CLAIM_TTL_SECONDS * 1000)
    expect(__testing.CLAIM_RENEW_INTERVAL_MS).toBeLessThan(__testing.WS_BACKSTOP_POLL_MS)
  })

  test("beginPendingInvocation starts the renew timer and clearing the turn stops it", () => {
    expect(__testing.claimRenewTimerActive()).toBe(false)
    __testing.beginPendingInvocation(invocation as never)
    expect(__testing.claimRenewTimerActive()).toBe(true)
    __testing.clearPendingForTesting()
    expect(__testing.claimRenewTimerActive()).toBe(false)
  })

  test("renewActiveClaims posts a renew with the claim TTL for the pending invocation", async () => {
    __testing.setConfigForTesting({
      baseUrl: "https://app.threa.io",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
    })
    __testing.beginPendingInvocation(invocation as never)
    const renews: Array<Record<string, unknown>> = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = String(input)
      if (url.endsWith(`/bot-invocations/${invocation.id}/renew`)) {
        renews.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch)
    try {
      await __testing.renewActiveClaims()
    } finally {
      fetchSpy.mockRestore()
    }
    expect(renews).toEqual([
      {
        instanceId: "pi-test-1",
        claimToken: "tok_1",
        claimTtlSeconds: __testing.CLAIM_TTL_SECONDS,
      },
    ])
  })
})

describe("nextQuietPollMs (no-socket idle backoff)", () => {
  test("doubles empty idle ticks to the cap and resets cleanly", () => {
    __testing.resetQuietPollsForTesting()
    // No transport, no pending turn, default 3s pollMs.
    expect(__testing.nextQuietPollMs()).toBe(3000)
    expect(__testing.nextQuietPollMs()).toBe(6000)
    expect(__testing.nextQuietPollMs()).toBe(12000)
    for (let i = 0; i < 10; i++) __testing.nextQuietPollMs()
    expect(__testing.nextQuietPollMs()).toBe(__testing.NO_SOCKET_POLL_CAP_MS)
    __testing.resetQuietPollsForTesting()
    expect(__testing.nextQuietPollMs()).toBe(3000)
  })
})

describe("archived-scratchpad wind-down", () => {
  const ctx = {
    sessionManager: { getSessionId: () => "runtime" },
    isIdle: () => true,
    cwd: "/tmp",
    ui: { notify: () => {} },
  } as never

  function linkConfig() {
    __testing.setConfigForTesting({
      baseUrl: "https://app.threa.io",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
      linkedSessions: {
        runtime: {
          enabled: true,
          instanceId: "pi-instance",
          runtimeSessionId: "runtime",
          rootStreamId: "stream_root",
        },
      },
    })
  }

  afterEach(() => {
    __testing.clearArchivePendingForTesting()
    __testing.setConfigForTesting(undefined)
  })

  test("an archive with no push detaches on the poll probe and suspends claiming", async () => {
    linkConfig()
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      async (input) =>
        new Response(
          JSON.stringify(
            String(input).endsWith("/streams/stream_root")
              ? { data: { archivedAt: "2026-07-20T10:00:00.000Z" } }
              : { data: {} }
          ),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    )
    try {
      await __testing.probeArchiveState(ctx)

      expect(__testing.archivePendingRootStreamId()).toBe("stream_root")
      // Detached: no claims against an archived scratchpad, and the poll drops
      // onto the reattach probe cadence instead of the 15-min backstop.
      expect(await __testing.claimIfIdle({} as never, ctx)).toBe(false)
      expect(__testing.nextQuietPollMs()).toBe(45_000)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("an unarchive inside the grace window reattaches instead of winding down", async () => {
    linkConfig()
    let archived = true
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      const body = url.endsWith("/streams/stream_root")
        ? { data: { archivedAt: archived ? "2026-07-20T10:00:00.000Z" : null } }
        : url.endsWith("/bot-runtime/sessions")
          ? { data: { rootStreamId: "stream_root", runtimeSessionId: "runtime" } }
          : { data: {} }
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
    })
    try {
      await __testing.probeArchiveState(ctx)
      expect(__testing.archivePendingRootStreamId()).toBe("stream_root")

      archived = false
      await __testing.probeArchiveState(ctx)

      expect(__testing.archivePendingRootStreamId()).toBeUndefined()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("a probe failure is never treated as an archive", async () => {
    linkConfig()
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("threa unreachable")
    })
    try {
      await __testing.probeArchiveState(ctx)
      expect(__testing.archivePendingRootStreamId()).toBeUndefined()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
