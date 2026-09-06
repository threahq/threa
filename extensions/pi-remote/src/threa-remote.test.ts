import { readHarnessLinks } from "@threa/harness-client"
import { encryptAttachmentBytes } from "@threahq/bot-runtime-client"
import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import threaRemote, { __testing } from "./threa-remote"
import { attachmentRef, invocation, sealingState, type TestInvocation } from "./threa-remote.test-helpers"

process.env.THREA_HARNESS_LINKS_DIR = mkdtempSync(join(tmpdir(), "harness-links-test-"))
// A harness-supervised shell exports this, and verifySupervisedRevival then
// blocks every fake session as "points at a different scratchpad" — the suite
// must behave the same inside a supervised pane as in CI.
delete process.env.THREA_EXPECTED_ROOT_STREAM_ID

let testStorageDirectory: string
let expectedRootStreamId: string | undefined

beforeEach(async () => {
  expectedRootStreamId = process.env.THREA_EXPECTED_ROOT_STREAM_ID
  delete process.env.THREA_EXPECTED_ROOT_STREAM_ID
  await __testing.resetRuntimeForTesting()
  testStorageDirectory = mkdtempSync(join(tmpdir(), "pi-remote-test-"))
  await __testing.setStorageDirectoryForTesting(testStorageDirectory)
})

afterEach(async () => {
  await __testing.resetRuntimeForTesting()
  rmSync(testStorageDirectory, { recursive: true, force: true })
  if (expectedRootStreamId === undefined) delete process.env.THREA_EXPECTED_ROOT_STREAM_ID
  else process.env.THREA_EXPECTED_ROOT_STREAM_ID = expectedRootStreamId
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

  test("commands mode shows only the bash command input", () => {
    const trace = __testing.formatToolCallTrace(
      {
        toolName: "bash",
        toolCallId: "call_1",
        input: { command: "bun test ./src/trace.test.ts", timeout: 30_000 },
      } as never,
      "commands"
    )
    const payload = JSON.parse(trace) as {
      headline: string
      sections: Array<{ label: string; body: string; lang: string | null }>
    }

    expect(payload.headline).toBe("Running bun test ./src/trace.test.ts")
    expect(payload.sections).toEqual([{ label: "Details", body: "bun test ./src/trace.test.ts", lang: "bash" }])
    expect(trace).not.toContain("timeout")
  })

  test("commands mode keeps multiline command bodies out of the headline", () => {
    const trace = __testing.formatToolCallTrace(
      {
        toolName: "bash",
        toolCallId: "call_1",
        input: { command: "set -e\nbun test ./src/trace.test.ts\nprintf 'done\\n'" },
      } as never,
      "commands"
    )
    const payload = JSON.parse(trace) as { headline: string; sections: Array<{ body: string }> }

    expect(payload.headline).toBe("Running set -e (+2 lines)")
    expect(payload.headline).not.toContain("bun test")
    expect(payload.sections[0]!.body).toContain("bun test ./src/trace.test.ts")
  })

  test("commands mode bounds long commands and headline size", () => {
    const trace = __testing.formatToolCallTrace(
      {
        toolName: "bash",
        toolCallId: "call_1",
        input: { command: `printf '%s' '${"x".repeat(10_000)}'` },
      } as never,
      "commands"
    )
    const payload = JSON.parse(trace) as { headline: string; sections: Array<{ body: string }> }

    expect(payload.headline.length).toBeLessThanOrEqual(180)
    expect(payload.sections[0]!.body.length).toBeLessThanOrEqual(2_000)
    expect(payload.sections[0]!.body).toContain("trace content truncated")
  })

  test("commands mode keeps write bodies and tool output hidden", () => {
    const call = __testing.formatToolCallTrace(
      {
        toolName: "write",
        toolCallId: "call_1",
        input: { path: "src/config.ts", content: "API_KEY=sk-secret-value" },
      } as never,
      "commands"
    )
    const result = __testing.formatToolResultTrace(
      {
        toolName: "bash",
        toolCallId: "call_1",
        isError: false,
        content: "API_KEY=sk-secret-value",
      } as never,
      "commands"
    )

    expect(call).toContain("File contents and patches omitted for safety")
    expect(call).not.toContain("sk-secret-value")
    expect(result).toContain("Tool output omitted for safety")
    expect(result).not.toContain("sk-secret-value")
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
    // No ctx: nothing is linked yet, so every command needing a live link is
    // withheld. What remains is everything Pi actuates in-process.
    expect(__testing.buildRuntimeCapabilities()).toMatchObject({
      supportsSessionControlCommands: true,
      sessionControlCommands: ["compact", "model", "thinking", "skill", "reload", "shell", "steer", "stop", "carry-on"],
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

  test("leaves the source message out of the stream context so its text ships once", () => {
    const messages = [
      {
        id: "msg_1",
        authorType: "user",
        authorDisplayName: "Kris",
        sequence: "1",
        content: "earlier note",
        createdAt: "2026-08-30T10:00:00.000Z",
      },
      {
        id: "msg_2",
        authorType: "bot",
        authorDisplayName: "Pi",
        sequence: "2",
        content: "earlier answer",
        createdAt: "2026-08-30T10:01:00.000Z",
      },
      {
        id: "msg_3",
        authorType: "user",
        authorDisplayName: "Kris",
        sequence: "3",
        content: "run the migration",
        createdAt: "2026-08-30T10:02:00.000Z",
      },
    ]

    const context = __testing.formatInvocationContext(messages as never, "msg_3", new Map())

    expect(context).toBe(
      ["Recent Threa stream context (oldest first):", "- Kris: earlier note", "- Pi: earlier answer"].join("\n")
    )
    expect(context).not.toContain("run the migration")
  })

  test("keeps history ordering and non-source attachments while the source keeps its own block", () => {
    const messages = [
      {
        id: "msg_3",
        authorType: "user",
        authorDisplayName: "Kris",
        sequence: "3",
        content: "look at this",
        createdAt: "2026-08-30T10:02:00.000Z",
        attachments: [
          { id: "att_src", filename: "shot.png", mimeType: "image/png", sizeBytes: 12 },
          { id: "att_missing", filename: "big.zip", mimeType: "application/zip", sizeBytes: 99 },
        ],
      },
      {
        id: "msg_1",
        authorType: "user",
        sequence: "1",
        content: "context first",
        createdAt: "2026-08-30T10:00:00.000Z",
        attachments: [{ id: "att_old", filename: "notes.txt", mimeType: "text/plain", sizeBytes: 7 }],
      },
    ]

    const context = __testing.formatInvocationContext(
      messages as never,
      "msg_3",
      new Map([
        ["att_old", "/cwd/.threa-attachments/binv_1/att_old-notes.txt"],
        ["att_src", "/cwd/.threa-attachments/binv_1/att_src-shot.png"],
      ])
    )

    expect(context).toBe(
      [
        "Recent Threa stream context (oldest first):",
        "- user: context first",
        "  Attachments: [att_old] notes.txt (text/plain, 7 bytes, downloaded to /cwd/.threa-attachments/binv_1/att_old-notes.txt)",
        "",
        "Attachments on the source message:",
        "- [att_src] shot.png (image/png, 12 bytes, downloaded to /cwd/.threa-attachments/binv_1/att_src-shot.png)",
        "- [att_missing] big.zip (application/zip, 99 bytes)",
      ].join("\n")
    )
    expect(context).not.toContain("look at this")
  })

  test("emits no context when the stream is empty or holds only the source message", () => {
    const source = [
      { id: "msg_1", authorType: "user", sequence: "1", content: "just me", createdAt: "2026-08-30T10:00:00.000Z" },
    ]

    expect(__testing.formatInvocationContext([], "msg_1", new Map())).toBe("")
    expect(__testing.formatInvocationContext(source as never, "msg_1", new Map())).toBe("")
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
        "defaultLabel": " Pi remote ",
        "traceMode": "commands"
      }`)
    ).toEqual({
      baseUrl: "https://app.threa.io/",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
      pollMs: 1500,
      defaultDisplayName: "Local Pi",
      defaultLabel: "Pi remote",
      traceMode: "commands",
    })
  })

  test("rejects unsupported trace modes in pasted configuration", () => {
    expect(() =>
      __testing.parseConfigPatch(`{
        "baseUrl": "https://app.threa.io",
        "workspaceId": "ws_123",
        "apiKey": "threa_bk_test",
        "traceMode": "everything"
      }`)
    ).toThrow("traceMode must be headline or commands")
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

  test("pulls polling back to the fast cadence when a ready socket drops", () => {
    __testing.setConfigForTesting({
      baseUrl: "https://app.threa.io",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
      pollMs: 3000,
    })
    expect(__testing.nextQuietPollMs()).toBe(3000)
    expect(__testing.nextQuietPollMs()).toBe(6000)

    const delays: number[] = []
    __testing.handleTransportDisconnected((delayMs) => delays.push(delayMs), 7, 7)

    // The current run's poll owns the next timer and will observe the socketless
    // state itself; scheduling here would create a second poll loop.
    expect(delays).toEqual([])
    expect(__testing.nextQuietPollMs()).toBe(3000)

    // A poll left over from a canceled run cannot schedule for the active run,
    // so it must not suppress the disconnect wakeup.
    __testing.handleTransportDisconnected((delayMs) => delays.push(delayMs), 6, 7)
    expect(delays).toEqual([3000])
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

describe("instanceIdForRemoteCreate", () => {
  test("reuses a supervised launch identity across attempts and keeps inherited or manual sessions independent", () => {
    const savedInstanceId = process.env.THREA_INSTANCE_ID
    const savedRuntimeSessionId = process.env.THREA_RUNTIME_SESSION_ID
    try {
      process.env.THREA_INSTANCE_ID = "pi-launch-instance"
      process.env.THREA_RUNTIME_SESSION_ID = "runtime-launch"
      expect([
        __testing.instanceIdForRemoteCreate("runtime-launch"),
        __testing.instanceIdForRemoteCreate("runtime-launch"),
      ]).toEqual(["pi-launch-instance", "pi-launch-instance"])

      expect(__testing.instanceIdForRemoteCreate("runtime-child")).not.toBe(
        __testing.instanceIdForRemoteCreate("runtime-child")
      )

      delete process.env.THREA_INSTANCE_ID
      delete process.env.THREA_RUNTIME_SESSION_ID
      expect(__testing.instanceIdForRemoteCreate("runtime-manual")).not.toBe(
        __testing.instanceIdForRemoteCreate("runtime-manual")
      )

      process.env.THREA_INSTANCE_ID = "pi.invalid"
      process.env.THREA_RUNTIME_SESSION_ID = "runtime-invalid"
      expect(() => __testing.instanceIdForRemoteCreate("runtime-invalid")).toThrow("THREA_INSTANCE_ID")
    } finally {
      if (savedInstanceId === undefined) delete process.env.THREA_INSTANCE_ID
      else process.env.THREA_INSTANCE_ID = savedInstanceId
      if (savedRuntimeSessionId === undefined) delete process.env.THREA_RUNTIME_SESSION_ID
      else process.env.THREA_RUNTIME_SESSION_ID = savedRuntimeSessionId
    }
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
        baseUrl: "https://remote.threa.test",
        workspaceId: "ws_123",
        apiKey: "threa_bk_test",
      } as never,
      {
        baseUrl: "https://app.threa.io",
      } as never
    )
    expect(result.baseUrl).toBe("https://remote.threa.test")
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
    const notices: string[] = []
    const eventContext = {
      isIdle: () => true,
      cwd: "/tmp",
      sessionManager: { getSessionId: () => "runtime_reload_control" },
      modelRegistry: { getAvailable: () => [] },
      ui: { notify: (text: string) => void notices.push(text), setStatus: () => {} },
    }

    try {
      __testing.setReloadWatchdogMsForTesting(120)
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

      // A handoff Pi never dispatches (observed live 2026-08-10: the text was
      // injected as a MODEL prompt instead) must not latch claims off forever —
      // the watchdog releases the latch and says so.
      await __testing.runReloadCommand(
        pi as never,
        {
          id: "binv_reload_undispatched",
          activeStreamId: "stream_1",
          sourceMessageId: "msg_2",
          promptMarkdown: "/reload",
          claimToken: "claim_reload_undispatched",
          claimedInstanceId: "pi-test",
          claimExpiresAt: null,
        } as never,
        eventContext as never
      )
      expect(__testing.reloadPending()).toBe(true)
      await Bun.sleep(220)
      expect(__testing.reloadPending()).toBe(false)
      expect(notices.some((text) => text.includes("was not dispatched"))).toBe(true)
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

  test("advertises kick only when harnessd can actually reach a tmux pane", async () => {
    // `kick` asks harnessd to press Enter in this session's pane. Everything
    // else Pi advertises actuates in-process, so kick is the one command that
    // is unrunnable without tmux — offering it anyway is a dead button.
    const ctx = context(true)
    const commands = (available: boolean) =>
      __testing.buildRuntimeCapabilities(ctx, () => available).sessionControlCommands as string[]

    expect(commands(true)).toContain("kick")

    delete process.env.TMUX_PANE
    expect(commands(true)).not.toContain("kick")

    process.env.TMUX_PANE = "%9"
    expect(commands(false)).not.toContain("kick")

    // The in-process commands stay available throughout — this gate must not
    // take the whole session-control surface down with it.
    expect(commands(false)).toEqual(expect.arrayContaining(["stop", "steer", "compact", "model", "thinking"]))
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
    for (const args of ["enter down", "-t", "%2", "unknown"]) {
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
    expect({ sends, messages }).toEqual({ sends: 0, messages: Array(4).fill("Usage: `/key <name>`.") })
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

describe("Pi clear session control", () => {
  const invocation = {
    id: "binv_clear",
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
  const linkedConfig = (link: Record<string, unknown>) => ({
    baseUrl: "https://app.threa.io",
    workspaceId: "ws_123",
    apiKey: "threa_bk_test",
    linkedSessions: { "runtime-exact": link },
  })
  const validLink = {
    enabled: true,
    instanceId: "pi-instance",
    runtimeSessionId: "runtime-exact",
    rootStreamId: "stream-root-exact",
    activeStreamId: "stream-root-exact",
    streamUrlPath: "/streams/stream-root-exact",
  }

  beforeEach(() => {
    process.env.TMUX_PANE = "%9"
    __testing.setConfigForTesting(linkedConfig(validLink) as never)
  })

  afterEach(() => {
    delete process.env.TMUX_PANE
    __testing.clearPendingForTesting()
    __testing.setConfigForTesting(undefined)
  })

  test("routes by runtime session alone, starts only after the ack, and stays nonaccepting", async () => {
    for (const force of [false, true]) {
      const prepared: unknown[][] = []
      const order: string[] = []
      await __testing.runClearCommand(invocation, force ? "--force" : "", context(true), {
        available: () => true,
        prepare: (...args: unknown[]) => {
          prepared.push(args)
          return () => order.push("start")
        },
        complete: async () => {
          order.push("complete")
          return true
        },
        heartbeat: async () => undefined,
      } as never)
      expect({ prepared, order, guarded: __testing.reconnectPending() }).toEqual({
        prepared: [["runtime-exact"]],
        order: ["complete", "start"],
        guarded: true,
      })
      expect(await __testing.claimNextInvocation(context(true))).toBeNull()
      __testing.clearPendingForTesting()
    }
  })

  test("advertises clear only for the exact current harness link", () => {
    const ctx = context(true)
    const advertised = (available: boolean) =>
      (__testing.buildRuntimeCapabilities(ctx, () => available).sessionControlCommands as string[]).includes("clear")

    expect(advertised(true)).toBe(true)
    expect(advertised(false)).toBe(false)

    __testing.setConfigForTesting(linkedConfig({ ...validLink, runtimeSessionId: "runtime-other" }) as never)
    expect(advertised(true)).toBe(false)

    __testing.setConfigForTesting(linkedConfig(validLink) as never)
    delete process.env.TMUX_PANE
    expect(advertised(true)).toBe(false)
  })

  test("a claim from link A cannot prepare or ack after relinking to B", async () => {
    let prepared = 0
    let acknowledged = 0
    for (const staleInvocation of [
      { ...invocation, rootStreamId: "stream-root-a" },
      { ...invocation, claimedInstanceId: "pi-instance-a" },
    ]) {
      await expect(
        __testing.runClearCommand(staleInvocation as never, "", context(true), {
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
      ).rejects.toThrow("Harness clear is unavailable")
    }
    expect({ prepared, acknowledged }).toEqual({ prepared: 0, acknowledged: 0 })
  })

  test("accepts only empty args or exact --force", async () => {
    const messages: string[] = []
    let prepared = 0
    for (const args of ["--force ", " --force", "--force=yes", "extra"]) {
      await __testing.runClearCommand(invocation, args, context(true), {
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
      messages: Array(4).fill("Usage: `/clear [--force]`."),
      prepared: 0,
    })
  })

  test("preparation failure and failed ack never start clear", async () => {
    expect(
      __testing.runClearCommand(invocation, "", context(true), {
        available: () => true,
        prepare: () => {
          throw new Error("preflight failed")
        },
        complete: async () => true,
      } as never)
    ).rejects.toThrow("preflight failed")

    let started = false
    await __testing.runClearCommand(invocation, "", context(true), {
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

  test("revalidates pinned link facts after ack and restores actual presence", async () => {
    for (const mutate of [
      (link: Record<string, unknown>) => (link.enabled = false),
      (link: Record<string, unknown>) => (link.rootStreamId = "stream-other"),
      (link: Record<string, unknown>) => (link.runtimeSessionId = "runtime-other"),
      (link: Record<string, unknown>) => (link.instanceId = "pi-other"),
    ]) {
      const link = { ...validLink }
      __testing.setConfigForTesting(linkedConfig(link) as never)
      let started = false
      const presence: string[] = []
      await __testing.runClearCommand(invocation, "", context(true), {
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
      __testing.runClearCommand(invocation, "", context(true), {
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
    await __testing.runClearCommand(invocation, "", context(false), deps)
    await __testing.runClearCommand(invocation, "--force", context(false), deps)
    __testing.clearPendingForTesting()
    __testing.beginPendingInvocation({ id: "binv_owned", claimToken: "owned" } as never)
    await __testing.runClearCommand(invocation, "--force", context(false), deps)
    expect({ messages, prepared }).toEqual({
      messages: [
        "Pi is busy; retry when idle or use `/clear --force`.",
        "Clear accepted; killing this session and starting a fresh conversation on the same scratchpad.",
        "A Threa invocation is still running; use `/stop` before clearing.",
      ],
      prepared: 1,
    })
  })
})

describe("Pi spawn and done session control", () => {
  const invocation = {
    id: "binv_spawn",
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
  const linkedConfig = (link: Record<string, unknown>) => ({
    baseUrl: "https://app.threa.io",
    workspaceId: "ws_123",
    apiKey: "threa_bk_test",
    linkedSessions: { "runtime-exact": link },
  })
  const deskLink = {
    enabled: true,
    instanceId: "pi-instance",
    runtimeSessionId: "runtime-exact",
    rootStreamId: "stream-root-exact",
    activeStreamId: "stream-root-exact",
    streamUrlPath: "/streams/stream-root-exact",
  }
  const threadLink = { ...deskLink, activeStreamId: "stream-thread-exact" }

  beforeEach(() => {
    process.env.TMUX_PANE = "%9"
    __testing.setConfigForTesting(linkedConfig(deskLink) as never)
  })

  afterEach(() => {
    delete process.env.TMUX_PANE
    __testing.clearPendingForTesting()
    __testing.setConfigForTesting(undefined)
  })

  test("anchors the spawn in the root, briefs harnessd with the prompt, and acks", async () => {
    const posted: unknown[][] = []
    const prepared: Array<Record<string, unknown>> = []
    const messages: string[] = []
    let started = false
    await __testing.runSpawnCommand(invocation, "claude fix the parser\nLook at parser.ts\nand fix it", context(true), {
      available: () => true,
      postMessage: async (...args: unknown[]) => {
        posted.push(args)
        return "msg_anchor"
      },
      prepare: (spec: Record<string, unknown>) => {
        prepared.push(spec)
        return () => {
          started = true
        }
      },
      complete: async (_invocation: unknown, message: string) => {
        messages.push(message)
        return true
      },
    } as never)

    const briefFile = prepared[0]?.briefFile as string | undefined
    const brief = briefFile ? readFileSync(briefFile, "utf8") : undefined
    if (briefFile) unlinkSync(briefFile)
    expect({ posted, spec: { ...prepared[0], briefFile: undefined }, brief, started, messages }).toEqual({
      posted: [["stream-root-exact", "Starting **fix the parser** (claude)"]],
      spec: {
        runtime: "claude",
        name: "fix the parser",
        rootStreamId: "stream-root-exact",
        anchorId: "msg_anchor",
        briefFile: undefined,
      },
      brief: "Look at parser.ts\nand fix it",
      started: true,
      messages: ["Spawning **fix the parser** as a claude thread; harnessd will brief it with your prompt."],
    })
  })

  test("an unparseable first line posts nothing and returns the usage", async () => {
    const messages: string[] = []
    let posts = 0
    let prepared = 0
    for (const args of ["", "--force\nprompt", "claude"]) {
      await __testing.runSpawnCommand(invocation, args, context(true), {
        available: () => true,
        postMessage: async () => {
          posts++
          return "msg_anchor"
        },
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
    expect({ messages, posts, prepared }).toEqual({
      messages: Array(3).fill("Usage: `/spawn [claude|pi] <name>` with the prompt on the following lines."),
      posts: 0,
      prepared: 0,
    })
  })

  test("defaults the runtime to pi and writes no brief without a prompt", async () => {
    const prepared: Array<Record<string, unknown>> = []
    const messages: string[] = []
    await __testing.runSpawnCommand(invocation, "tidy up", context(true), {
      available: () => true,
      postMessage: async () => "msg_anchor",
      prepare: (spec: Record<string, unknown>) => {
        prepared.push(spec)
        return () => undefined
      },
      complete: async (_invocation: unknown, message: string) => {
        messages.push(message)
        return true
      },
    } as never)
    expect({ prepared, messages }).toEqual({
      prepared: [
        {
          runtime: "pi",
          name: "tidy up",
          rootStreamId: "stream-root-exact",
          anchorId: "msg_anchor",
          briefFile: undefined,
        },
      ],
      messages: ["Spawning **tidy up** as a pi thread."],
    })
  })

  test("refuses inside a thread without posting an anchor", async () => {
    __testing.setConfigForTesting(linkedConfig(threadLink) as never)
    const messages: string[] = []
    let posts = 0
    await __testing.runSpawnCommand(invocation, "pi tidy up", context(true), {
      available: () => true,
      postMessage: async () => {
        posts++
        return "msg_anchor"
      },
      prepare: () => () => undefined,
      complete: async (_invocation: unknown, message: string) => {
        messages.push(message)
        return true
      },
    } as never)
    expect({ messages, posts }).toEqual({
      messages: ["Spawn is only available on the scratchpad root."],
      posts: 0,
    })
  })

  test("a claim from another scratchpad or instance cannot spawn", async () => {
    let posts = 0
    const deps = {
      available: () => true,
      postMessage: async () => {
        posts++
        return "msg_anchor"
      },
      prepare: () => () => undefined,
      complete: async () => true,
    } as never
    const stale = [
      { ...(invocation as object), rootStreamId: "stream-other" },
      { ...(invocation as object), claimedInstanceId: "pi-other" },
    ]
    for (const claim of stale) {
      await expect(__testing.runSpawnCommand(claim as never, "pi tidy up", context(true), deps)).rejects.toThrow(
        "Spawn request no longer matches the linked scratchpad."
      )
    }
    expect(posts).toBe(0)
  })

  test("a replaced claim posts no anchor, and one replaced mid-post leaves no brief behind", async () => {
    const messages: string[] = []
    let posts = 0
    let prepared = 0
    const briefs = () => readdirSync(tmpdir()).filter((entry) => entry.startsWith("threa-spawn-"))
    const before = briefs()
    const deps = {
      available: () => true,
      postMessage: async () => {
        posts++
        return "msg_anchor"
      },
      prepare: () => {
        prepared++
        return () => undefined
      },
      complete: async (_invocation: unknown, message: string) => {
        messages.push(message)
        return true
      },
    } as never

    await __testing.runSpawnCommand(invocation, "pi tidy up\nfix it", context(true), deps, () => false)
    let posted = false
    await __testing.runSpawnCommand(invocation, "pi tidy up\nfix it", context(true), deps, () => {
      const wasCurrent = !posted
      posted = true
      return wasCurrent
    })

    expect({ messages, posts, prepared, leaked: briefs().filter((brief) => !before.includes(brief)) }).toEqual({
      messages: [],
      posts: 1,
      prepared: 0,
      leaked: [],
    })
  })

  test("a launch failure names the anchor, acks nothing, and removes the brief it wrote", async () => {
    const messages: string[] = []
    let briefFile: string | undefined
    await expect(
      __testing.runSpawnCommand(invocation, "pi broken\nfix the thing", context(true), {
        available: () => true,
        postMessage: async () => "msg_anchor",
        prepare: (spec: Record<string, unknown>) => {
          briefFile = spec.briefFile as string
          return () => {
            throw new Error("harnessd missing")
          }
        },
        complete: async (_invocation: unknown, message: string) => {
          messages.push(message)
          return true
        },
      } as never)
    ).rejects.toThrow("Spawn launch failed after posting anchor msg_anchor: harnessd missing")
    expect({ messages, briefWritten: Boolean(briefFile), briefLeft: existsSync(briefFile ?? "") }).toEqual({
      messages: [],
      briefWritten: true,
      briefLeft: false,
    })
  })

  test("winds a thread session down through harnessd and refuses on the desk", async () => {
    __testing.setConfigForTesting(linkedConfig(threadLink) as never)
    const prepared: unknown[][] = []
    const order: string[] = []
    const messages: string[] = []
    const deps = (record: string[]) =>
      ({
        available: () => true,
        prepare: (...args: unknown[]) => {
          prepared.push(args)
          return () => order.push("start")
        },
        complete: async (_invocation: unknown, message: string) => {
          order.push("complete")
          record.push(message)
          return true
        },
        heartbeat: async () => undefined,
      }) as never
    await __testing.runDoneCommand(invocation, "", context(true), deps(messages))
    __testing.clearPendingForTesting()
    await __testing.runDoneCommand(invocation, "extra", context(true), deps(messages))
    __testing.setConfigForTesting(linkedConfig(deskLink) as never)
    await __testing.runDoneCommand(invocation, "", context(true), deps(messages))

    expect({ prepared, order, messages }).toEqual({
      prepared: [["runtime-exact", "stream-root-exact"]],
      order: ["complete", "start", "complete", "complete"],
      messages: [
        "Wrapping up: committing, pushing, removing the worktree and ending this thread's session.",
        "Usage: `/done [--force]`.",
        "Done is only available inside a thread session.",
      ],
    })
  })

  test("done force bypasses only local busy state and never an owned Threa invocation", async () => {
    __testing.setConfigForTesting(linkedConfig(threadLink) as never)
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
    await __testing.runDoneCommand(invocation, "", context(false), deps)
    await __testing.runDoneCommand(invocation, "--force", context(false), deps)
    __testing.clearPendingForTesting()
    __testing.beginPendingInvocation({ id: "binv_owned", claimToken: "owned" } as never)
    await __testing.runDoneCommand(invocation, "--force", context(false), deps)

    expect({ messages, prepared }).toEqual({
      messages: [
        "Pi is busy; retry when idle or use `/done --force`.",
        "Wrapping up: committing, pushing, removing the worktree and ending this thread's session.",
        "A Threa invocation is still running; use `/stop` before finishing.",
      ],
      prepared: 1,
    })
  })

  test("a done that never restarts this pane releases the busy latch on the fallback", async () => {
    // harnessd refuses the wind-down whenever a reaper veto applies, and a
    // refused `done` leaves this pane alive: without the deadline it stays
    // latched busy and never accepts another claim.
    __testing.setConfigForTesting(linkedConfig(threadLink) as never)
    const heartbeats: string[] = []
    const deps = {
      available: () => true,
      prepare: () => () => {},
      complete: async () => true,
      heartbeat: async (status: string) => void heartbeats.push(status),
    } as never
    jest.useFakeTimers()
    try {
      await __testing.runDoneCommand(invocation, "", context(true), deps)
      expect(__testing.reconnectPending()).toBe(true)
      jest.advanceTimersByTime(__testing.HARNESS_HANDOFF_FALLBACK_MS)
    } finally {
      jest.useRealTimers()
    }

    expect({ latched: __testing.reconnectPending(), heartbeats }).toEqual({
      latched: false,
      heartbeats: ["busy", "available"],
    })
  })

  test("advertises spawn only on the desk, done only inside a thread, and neither without a link", () => {
    const ctx = context(true)
    const advertised = (available: boolean) =>
      (__testing.buildRuntimeCapabilities(ctx, () => available).sessionControlCommands as string[]).filter(
        (name) => name === "spawn" || name === "done"
      )

    const desk = advertised(true)
    const unavailable = advertised(false)
    __testing.setConfigForTesting(linkedConfig(threadLink) as never)
    const thread = advertised(true)
    __testing.setConfigForTesting(linkedConfig(deskLink) as never)
    delete process.env.TMUX_PANE
    const unpaned = advertised(true)

    expect({ desk, thread, unavailable, unpaned }).toEqual({
      desk: ["spawn"],
      thread: ["done"],
      unavailable: [],
      unpaned: [],
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

  test("a no-turn control command restores available presence instead of staying busy", async () => {
    // The dispatch heartbeats "busy, Running /X…" on entry and every success
    // path returned with that presence still standing — a /stop with nothing
    // to stop left the agent advertised busy and not-accepting until some
    // later turn happened to heartbeat (observed 2026-08-10).
    __testing.setConfigForTesting({
      baseUrl: "https://app.threa.io",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
      linkedSessions: {
        runtime: {
          enabled: true,
          instanceId: "pi-instance",
          runtimeSessionId: "runtime",
          rootStreamId: "stream_1",
          activeStreamId: "stream_1",
        },
      },
    })
    const presence: Array<Record<string, unknown>> = []
    let claimServed = false
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = String(input)
      if (url.endsWith("/bot-invocations/claim")) {
        if (claimServed) {
          return new Response(JSON.stringify({ data: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        claimServed = true
        return new Response(
          JSON.stringify({
            data: {
              id: "binv_stop",
              activeStreamId: "stream_1",
              sourceMessageId: "msg_stop",
              promptMarkdown: "/stop",
              trigger: "session-control",
              requiredCapability: "session-control",
              claimToken: "claim_stop",
              claimExpiresAt: null,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      }
      if (url.endsWith("/bot-runtime/presence") && typeof init?.body === "string") {
        presence.push(JSON.parse(init.body) as Record<string, unknown>)
      }
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch)
    const ctx = {
      sessionManager: { getSessionId: () => "runtime", getBranch: () => [] },
      isIdle: () => true,
      cwd: "/tmp",
      modelRegistry: { getAvailable: () => [] },
      ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_tone: string, text: string) => text } },
    } as never
    const pi = { sendUserMessage: () => {} } as never

    try {
      await __testing.claimIfIdle(pi, ctx)

      expect(presence.at(-1)).toMatchObject({ status: "available", acceptingInvocations: true })
      // Session-control claims have no agent session server-side; a step write
      // can only bounce (SESSION_CONTROL_TRACE_UNSUPPORTED), so none may leave.
      const stepWrites = fetchSpy.mock.calls.map((call) => String(call[0])).filter((url) => url.includes("/steps"))
      expect(stepWrites).toEqual([])
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

    const requests: Array<{ url: string; body: unknown }> = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      requests.push({ url: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : null })
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
      expect(requests.length).toBe(0)

      await shutdown({ reason: "quit" }, context("parent"))
      expect(requests.map((entry) => ({ path: new URL(entry.url).pathname, body: entry.body }))).toEqual([
        {
          path: "/api/v1/workspaces/ws_123/bot-invocations/binv_parent/fail",
          body: { instanceId: "pi-parent", claimToken: "claim_1", errorMessage: "Pi session shut down" },
        },
      ])

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
  test("starts transport and polling even when the session-start heartbeat fails", async () => {
    const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void>>()
    const pi = {
      registerCommand: () => {},
      on: (event: string, handler: (event: unknown, ctx: any) => Promise<void>) => handlers.set(event, handler),
      sendUserMessage: () => {},
    }
    threaRemote(pi as never)

    const runtimeSessionId = "runtime_heartbeat_failure"
    __testing.setConfigForTesting({
      baseUrl: "https://example.test",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
      pollMs: 10,
      linkedSessions: {
        [runtimeSessionId]: {
          enabled: true,
          instanceId: "pi-heartbeat-failure",
          runtimeSessionId,
          rootStreamId: "stream_1",
          activeStreamId: "stream_1",
        },
      },
    })
    const ctx = {
      sessionManager: { getSessionId: () => runtimeSessionId, getBranch: () => [] },
      isIdle: () => true,
      cwd: "/tmp",
      modelRegistry: { getAvailable: () => [] },
      ui: {
        setStatus: () => {},
        notify: () => {},
        theme: { fg: (_tone: string, text: string) => text },
      },
    }
    const requests: string[] = []
    let failPresence = true
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      const url = String(input)
      requests.push(url)
      if (url.endsWith("/bot-runtime/presence") && failPresence) {
        failPresence = false
        return new Response(JSON.stringify({ error: "temporary" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        })
      }
      const data = url.endsWith("/bot-invocations/claim") ? null : {}
      return new Response(JSON.stringify(url.includes("/api/workspaces/") ? {} : { data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch)

    try {
      await handlers.get("session_start")!({ reason: "reload" }, ctx)
      await Bun.sleep(30)

      expect(requests.some((url) => url.endsWith("/bot-invocations/claim"))).toBe(true)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("polling starts even while the ws-hint dial hangs", async () => {
    // The 2026-08-10 wedge: session_start awaited connect() BEFORE startPolling,
    // so a ws-hint fetch that never settled froze the runtime at one startup
    // heartbeat — no polls, no claims, pane still "linked". The backstop must
    // start before the dial it backs up.
    const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void>>()
    const pi = {
      registerCommand: () => {},
      on: (event: string, handler: (event: unknown, ctx: any) => Promise<void>) => handlers.set(event, handler),
      sendUserMessage: () => {},
    }
    threaRemote(pi as never)

    const runtimeSessionId = "runtime_hung_dial"
    __testing.setConfigForTesting({
      baseUrl: "https://example.test",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
      pollMs: 10,
      linkedSessions: {
        [runtimeSessionId]: {
          enabled: true,
          instanceId: "pi-hung-dial",
          runtimeSessionId,
          rootStreamId: "stream_1",
          activeStreamId: "stream_1",
        },
      },
    })
    const statuses: Array<string | undefined> = []
    const ctx = {
      sessionManager: { getSessionId: () => runtimeSessionId, getBranch: () => [] },
      isIdle: () => true,
      cwd: "/tmp",
      modelRegistry: { getAvailable: () => [] },
      ui: {
        setStatus: (_key: string, text?: string) => void statuses.push(text),
        notify: () => {},
        theme: { fg: (_tone: string, text: string) => text },
      },
    }
    const requests: string[] = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      const url = String(input)
      requests.push(url)
      if (url.includes("/api/workspaces/ws_123/config")) return new Promise<Response>(() => {})
      const data = url.endsWith("/bot-invocations/claim") ? null : {}
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch)

    try {
      const started = handlers.get("session_start")!({ reason: "reload" }, ctx)
      await Bun.sleep(30)

      expect(requests.some((url) => url.endsWith("/bot-invocations/claim"))).toBe(true)
      // The footer must not advertise "reloading…" forever while the dial hangs.
      expect(statuses).toContain("Threa remote: linked")
      await Promise.race([started, Promise.resolve()])
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("a Threa-triggered /reload leaves the claim loop able to claim the next message", async () => {
    // The 2026-08-10 second wedge: a /reload arriving AS a Threa invocation
    // (complete → handoff followUp → ctx.reload) left the reloaded session
    // unable to claim the message that arrived mid-reload, while a pane-native
    // reload recovered fine. This drives the full command → handoff → shutdown
    // → start sequence and requires the next claim to happen.
    const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void>>()
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>()
    const deliveries: Array<{ text: string; options?: unknown }> = []
    const pi = {
      registerCommand: (name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) =>
        commands.set(name, options),
      on: (event: string, handler: (event: unknown, ctx: any) => Promise<void>) => handlers.set(event, handler),
      sendUserMessage: (text: string, options?: unknown) => deliveries.push({ text, options }),
    }
    threaRemote(pi as never)

    const runtimeSessionId = "runtime_threa_reload"
    __testing.setConfigForTesting({
      baseUrl: "https://example.test",
      workspaceId: "ws_123",
      apiKey: "threa_bk_test",
      pollMs: 10,
      linkedSessions: {
        [runtimeSessionId]: {
          enabled: true,
          instanceId: "pi-threa-reload",
          runtimeSessionId,
          rootStreamId: "stream_1",
          activeStreamId: "stream_1",
        },
      },
    })
    const ctx = {
      sessionManager: { getSessionId: () => runtimeSessionId, getBranch: () => [] },
      isIdle: () => true,
      cwd: "/tmp",
      modelRegistry: { getAvailable: () => [] },
      ui: {
        setStatus: () => {},
        notify: () => {},
        theme: { fg: (_tone: string, text: string) => text },
      },
      reload: async () => {
        reloadRuns++
        await handlers.get("session_shutdown")!({ reason: "reload" }, ctx)
        await handlers.get("session_start")!({ reason: "reload" }, ctx)
      },
    }
    let reloadRuns = 0
    let offer = false
    let claimedAfterReload = 0
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/bot-invocations/claim")) {
        if (!offer) {
          return new Response(JSON.stringify({ data: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        offer = false
        claimedAfterReload++
        return new Response(
          JSON.stringify({
            data: {
              id: "binv_after_reload",
              activeStreamId: "stream_1",
              sourceMessageId: "msg_after",
              promptMarkdown: "Hiya",
              claimToken: "claim_after",
              claimExpiresAt: null,
            },
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
    }) as typeof fetch)

    try {
      await handlers.get("session_start")!({ reason: "startup" }, ctx)
      await __testing.runReloadCommand(
        pi as never,
        {
          id: "binv_reload",
          activeStreamId: "stream_1",
          sourceMessageId: "msg_reload",
          promptMarkdown: "/reload",
          claimToken: "claim_reload",
          claimedInstanceId: "pi-threa-reload",
          claimExpiresAt: null,
        } as never,
        ctx as never
      )
      expect(__testing.reloadPending()).toBe(true)
      // Pi delivers the handoff followUp; its handler runs ctx.reload.
      await commands.get("threa-remote-reload")!.handler("", ctx)

      offer = true
      // Quiet-poll backoff accumulated across the suite stretches the cadence,
      // so wait on the claim rather than a fixed tick.
      for (let i = 0; i < 100 && claimedAfterReload === 0; i++) await Bun.sleep(50)

      expect(reloadRuns).toBe(1)
      expect(claimedAfterReload).toBe(1)
      expect(deliveries.some((delivery) => delivery.text.includes("Hiya"))).toBe(true)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("restores, observes, and completes the in-flight claim after the extension cache is cleared", async () => {
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
      const data = url.endsWith("/bot-invocations/claim")
        ? null
        : url.endsWith("/bot-invocations/binv_reload/renew")
          ? { status: "active", claimExpiresAt: new Date(Date.now() + 120_000).toISOString(), sourceRevision: 3 }
          : {}
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
        sourceRevision: 3,
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
      expect(writes.some((write) => write.url.endsWith("/bot-invocations/binv_reload/renew"))).toBe(true)

      idle = true
      // The recovered Pi turn was already active when the extension reloaded;
      // no second turn_start is required to own its remaining output.
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
        sourceRevision: 3,
        finalMessageMarkdown: "Finished after reload.",
      })
      expect(__testing.pendingInvocationId()).toBeUndefined()
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
    ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_tone: string, text: string) => text } },
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

  test("the grace expiring while still archived hands the worktree to harnessd and takes the window down", async () => {
    linkConfig()
    let windowsKilled = 0
    __testing.setArchiveWindDownForTesting(50, () => {
      windowsKilled += 1
      return true
    })
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
      expect(windowsKilled).toBe(0)

      await Bun.sleep(120)

      // The record must survive, carrying the mark: harnessd does the pushing
      // and the removal, and it can only find this worktree through the record.
      expect({
        windowsKilled,
        pending: __testing.archivePendingRootStreamId(),
        marked: readHarnessLinks()
          .filter((link) => link.runtimeSessionId === "runtime")
          .map((link) => ({ worktree: link.worktree, requested: typeof link.windDownRequestedAt === "string" })),
      }).toEqual({
        windowsKilled: 1,
        pending: undefined,
        marked: [{ worktree: "/tmp", requested: true }],
      })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("a reattach that resolves after the wind-down already ran does not throw or half-reattach", async () => {
    linkConfig()
    let releaseReattach!: () => void
    const reattachGate = new Promise<void>((resolve) => (releaseReattach = resolve))
    __testing.setArchiveWindDownForTesting(50, () => false)
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith("/streams/stream_root")) {
        return new Response(JSON.stringify({ data: { archivedAt: "2026-07-20T10:00:00.000Z" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.endsWith("/bot-runtime/sessions")) {
        // The unarchive lands, but not before the grace deadline fires.
        await reattachGate
        return new Response(JSON.stringify({ data: { rootStreamId: "stream_root", runtimeSessionId: "runtime" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    try {
      await __testing.probeArchiveState(ctx)
      const reattach = __testing.probeArchiveState(ctx)
      await Bun.sleep(120)
      expect(__testing.archivePendingRootStreamId()).toBeUndefined()

      releaseReattach()
      await reattach

      // The wind-down won the race; the stale reattach must not resurrect the
      // session (nor blow up on the already-cleared deadline).
      expect(__testing.archivePendingRootStreamId()).toBeUndefined()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("detaching pulls the poll onto the probe cadence instead of the socket backstop", async () => {
    linkConfig()
    // With the socket up the pending tick is 15 minutes out — longer than the
    // whole grace — so a missed restore push would never get a probe.
    expect(__testing.nextQuietPollMs()).not.toBe(45_000)
    await __testing.setArchivePendingForTesting(ctx, "stream_root")
    expect(__testing.nextQuietPollMs()).toBe(45_000)
  })

  test("an archive event for a retired root does not wind down the scratchpad now linked", async () => {
    linkConfig()
    // Cold start replaced archived root A with live root B under the same
    // deterministic runtime identity; A's outbox event arrives late.
    __testing.handleArchivePush(ctx, { runtimeSessionId: "runtime", rootStreamId: "stream_retired" })
    await Bun.sleep(0)
    expect(__testing.archivePendingRootStreamId()).toBeUndefined()

    __testing.handleArchivePush(ctx, { runtimeSessionId: "runtime", rootStreamId: "stream_root" })
    await Bun.sleep(0)
    expect(__testing.archivePendingRootStreamId()).toBe("stream_root")
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

describe("invocation edit regressions", () => {
  const runtimeSessionId = "runtime_matrix"

  const deferred = <T = void>() => {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    return { promise, resolve, reject }
  }

  const waitFor = async (predicate: () => boolean, label: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return
      await Bun.sleep(1)
    }
    throw new Error(`timed out waiting for ${label}`)
  }

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })

  const context = (options: { idle?: boolean; branch?: unknown[]; abort?: () => void } = {}) =>
    ({
      sessionManager: {
        getSessionId: () => runtimeSessionId,
        getBranch: () => options.branch ?? [],
      },
      isIdle: () => options.idle ?? false,
      abort: options.abort ?? (() => {}),
      cwd: testStorageDirectory,
      modelRegistry: { getAvailable: () => [] },
      ui: {
        setStatus: () => {},
        notify: () => {},
        theme: { fg: (_tone: string, text: string) => text },
      },
    }) as any

  const configure = (linked = false) => {
    __testing.setConfigForTesting({
      baseUrl: "https://example.test",
      workspaceId: "ws_1",
      apiKey: "key",
      ...(linked
        ? {
            linkedSessions: {
              [runtimeSessionId]: {
                enabled: true,
                instanceId: "pi-matrix",
                runtimeSessionId,
                rootStreamId: "stream_1",
                activeStreamId: "stream_1",
              },
            },
          }
        : {}),
    })
  }

  async function observe(
    claim: ReturnType<typeof invocation>,
    pi: Record<string, unknown>,
    ctx: any,
    options: {
      initialState?: "unstarted" | "processing" | "running" | "recovery"
      sync?: (callbacks: any) => Promise<void> | void
      recordSteps?: (...args: any[]) => Promise<void>
      updatePresence?: (...args: any[]) => Promise<void>
    } = {}
  ) {
    let callbacks: any
    let unregisters = 0
    __testing.setTransportForTesting({
      observeClaim: (params: any) => {
        callbacks = params.callbacks
        return {
          sync: async () => options.sync?.(callbacks),
          unregister: () => {
            unregisters++
          },
        }
      },
      recordSteps: options.recordSteps ?? (async () => {}),
      updatePresence: options.updatePresence ?? (async () => {}),
      disconnect: () => {},
    })
    const active = await __testing.observeInvocation(
      pi as never,
      ctx,
      claim as never,
      options.initialState ?? "running"
    )
    return { active, callbacks, unregisters: () => unregisters }
  }

  const plaintextUpdate = (claim: TestInvocation, revision: number, promptMarkdown: string) => ({
    invocationId: claim.id,
    sourceMessageId: claim.sourceMessageId,
    sourceRevision: revision,
    delivery: "plaintext" as const,
    promptMarkdown,
    attachmentRefs: [],
  })

  const sourceMessage = (claim: TestInvocation, content: string, overrides: Record<string, unknown> = {}) => ({
    id: claim.sourceMessageId,
    authorType: "user",
    sequence: "1",
    content,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  })

  const sourceMessages = (...messages: Array<Record<string, unknown>>) => json({ data: messages })

  test("advertises the same live manifest for every presence status", () => {
    configure()
    const ctx = context()
    const manifests = ["available", "busy", "offline", "error"].map(
      (status) => (__testing.presenceBody(status as never, undefined, ctx) as any).manifest
    )
    expect(manifests).toEqual(Array(4).fill(__testing.piManifest))
    expect(__testing.piManifest).toEqual({
      output: { reply: true, trace: true, sources: false },
      input: { updates: "live" },
    })
  })

  test("initial sync applies the latest revision before processing and unregisters on cancellation", async () => {
    configure()
    const claim = invocation("binv_observed")
    const ctx = context()
    __testing.beginPendingInvocation(claim as never)
    const events: string[] = []
    let callbacks: any
    let unregisters = 0
    __testing.setTransportForTesting({
      observeClaim: (params: any) => {
        callbacks = params.callbacks
        return {
          sync: async () => {
            events.push("sync")
            expect(await callbacks.onInputUpdated(plaintextUpdate(claim, 2, "edited"))).toBe("applied")
          },
          unregister: () => {
            unregisters++
          },
        }
      },
      disconnect: () => {},
    })
    const pi = { sendUserMessage: () => events.push("steer") }

    expect(await __testing.observeInvocation(pi as never, ctx, claim as never)).toBe(true)
    expect({ events, observed: __testing.observedInvocationCount() }).toEqual({ events: ["sync"], observed: 1 })
    expect(__testing.pendingInvocationState()).toMatchObject({ sourceRevision: 2, promptMarkdown: "edited" })

    await callbacks.onCancelled({ invocationId: claim.id, sourceRevision: 2, reason: "source_deleted" })
    expect({
      pending: __testing.pendingInvocationId(),
      observed: __testing.observedInvocationCount(),
      unregisters,
    }).toEqual({ pending: undefined, observed: 0, unregisters: 1 })
  })

  test("initial claim loss returns no work and never injects", async () => {
    configure()
    const claim = invocation("binv_observed_lost")
    __testing.beginPendingInvocation(claim as never)
    let sends = 0
    __testing.setTransportForTesting({
      observeClaim: (params: any) => ({
        sync: () => params.callbacks.onClaimLost(),
        unregister: () => {},
      }),
      disconnect: () => {},
    })

    expect(
      await __testing.observeInvocation({ sendUserMessage: () => sends++ } as never, context(), claim as never)
    ).toBe(false)
    expect({ sends, pending: __testing.pendingInvocationId() }).toEqual({ sends: 0, pending: undefined })
  })

  test("restart-required keeps the target observed until the cancellation handshake", async () => {
    configure()
    const claim = invocation("binv_restart")
    __testing.beginPendingInvocation(claim as never)
    __testing.setPendingRuntimeForTesting({ invocationPrompt: "old full prompt" })
    const ctx = context()
    const sends: string[] = []
    const observation = await observe(claim, { sendUserMessage: (text: string) => sends.push(text) }, ctx)
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "context unavailable" }, 503))
    try {
      expect(await observation.callbacks.onInputUpdated(plaintextUpdate(claim, 2, "edited"))).toBe("restart-required")
      expect({
        sends,
        unregisters: observation.unregisters(),
        observed: __testing.observedInvocationCount(),
      }).toEqual({ sends: [], unregisters: 0, observed: 1 })
      await observation.callbacks.onCancelled({
        invocationId: claim.id,
        sourceRevision: 2,
        reason: "adapter_restart_required",
      })
      expect({ unregisters: observation.unregisters(), observed: __testing.observedInvocationCount() }).toEqual({
        unregisters: 1,
        observed: 0,
      })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("initial sync rewrites structured command metadata before command actuation", async () => {
    configure()
    const claim = {
      ...invocation("binv_command_sync", 1, "/thinking low"),
      requiredCapability: "session-control",
      metadata: {
        command: { id: "cmd_thinking", name: "thinking", args: "low", executionKind: "bot-runtime" },
      },
    }
    const ctx = context({ idle: true })
    const observation = await observe(claim, {}, ctx, {
      initialState: "unstarted",
      sync: async (callbacks) => {
        expect(await callbacks.onInputUpdated(plaintextUpdate(claim, 2, "/thinking high"))).toBe("applied")
      },
    })
    let level = "low"
    const writes: Array<Record<string, unknown>> = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith(`/bot-invocations/${claim.id}/complete`)) {
        writes.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      }
      return json({ data: {} })
    })
    try {
      await __testing.handleSessionControlInvocation(
        {
          getThinkingLevel: () => level,
          setThinkingLevel: (next: string) => {
            level = next
          },
        } as never,
        ctx,
        claim as never
      )
      expect(level).toBe("high")
      expect(writes).toEqual([
        expect.objectContaining({ sourceRevision: 2, finalMessageMarkdown: expect.stringContaining("high") }),
      ])
      expect(observation.unregisters()).toBe(1)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("running structured steer update sends canonical args rather than stale command markdown", async () => {
    configure()
    const claim = {
      ...invocation("binv_command_steer", 1, "/steer old direction"),
      requiredCapability: "session-control",
      metadata: {
        command: { id: "cmd_steer", name: "steer", args: "old direction", executionKind: "bot-runtime" },
      },
    }
    const ctx = context({ idle: false })
    const sends: string[] = []
    __testing.beginPendingInvocation(claim as never)
    __testing.setPendingRuntimeForTesting({ invocationPrompt: "old direction" })
    const observation = await observe(claim, { sendUserMessage: (text: string) => sends.push(text) }, ctx, {
      initialState: "running",
    })
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/streams/stream_1/messages?"))
        return sourceMessages(sourceMessage(claim, "/steer new direction"))
      return json({ data: {} })
    })
    try {
      expect(await observation.callbacks.onInputUpdated(plaintextUpdate(claim, 2, "/steer new direction"))).toBe(
        "applied"
      )
      expect(sends).toEqual([expect.stringContaining("new direction")])
      expect(sends[0]).not.toContain("/steer")
      expect(sends[0]).not.toContain("old direction")
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("combined reload synchronizes every contributor before a missed edit requests restart", async () => {
    configure(true)
    const primary = invocation("binv_reload_primary", 1, "primary old")
    const secondary = invocation("binv_reload_secondary", 1, "secondary old")
    const ctx = context({ idle: false })
    __testing.beginPendingInvocation(primary as never)
    __testing.setPendingRuntimeForTesting({
      invocationPrompt: "primary old full",
      steered: [{ invocation: secondary as never, retryPrompt: "secondary old steer" }],
    })
    __testing.savePendingSnapshot(ctx)
    const snapshot = JSON.parse(readFileSync(__testing.pendingSnapshotPathForTesting(runtimeSessionId), "utf8")) as any
    expect(snapshot.steered[0].retryPrompt).toBe("secondary old steer")

    await __testing.resetRuntimeForTesting()
    configure(true)
    const sends: string[] = []
    const unregisters = new Map<string, number>()
    let secondaryCallbacks: any
    let disposition: string | undefined
    __testing.setTransportForTesting({
      observeClaim: (params: any) => {
        if (params.invocationId === secondary.id) secondaryCallbacks = params.callbacks
        return {
          sync: async () => {
            if (params.invocationId === secondary.id) {
              disposition = await params.callbacks.onInputUpdated(
                plaintextUpdate(secondary, 2, "secondary edited during reload")
              )
            }
          },
          unregister: () => unregisters.set(params.invocationId, (unregisters.get(params.invocationId) ?? 0) + 1),
        }
      },
      recordSteps: async () => {},
      updatePresence: async () => {},
      disconnect: () => {},
    })

    await __testing.restorePendingAfterReload({ sendUserMessage: (text: string) => sends.push(text) } as never, ctx)
    expect({ disposition, sends, pending: __testing.pendingInvocationId() }).toEqual({
      disposition: "restart-required",
      sends: [],
      pending: undefined,
    })
    expect({ primary: unregisters.get(primary.id), secondary: unregisters.get(secondary.id) ?? 0 }).toEqual({
      primary: 1,
      secondary: 0,
    })
    await secondaryCallbacks.onCancelled({
      invocationId: secondary.id,
      sourceRevision: 2,
      reason: "adapter_restart_required",
    })
    expect(unregisters.get(secondary.id)).toBe(1)
  })

  test("single-claim reload retry applies a missed edit before provider delivery", async () => {
    configure(true)
    const primary = invocation("binv_retry_primary", 1, "primary old")
    const ctx = context({ idle: true })
    __testing.beginPendingInvocation(primary as never)
    __testing.setPendingRuntimeForTesting({
      invocationPrompt: "primary old full",
      waitingForRetry: true,
      retryAt: Date.now() + 60_000,
      retryAttempts: 1,
    })
    __testing.savePendingSnapshot(ctx)
    await __testing.resetRuntimeForTesting()
    configure(true)

    const sends: string[] = []
    const pi = { sendUserMessage: (text: string) => sends.push(text) }
    __testing.setTransportForTesting({
      observeClaim: (params: any) => ({
        sync: () => params.callbacks.onInputUpdated(plaintextUpdate(primary, 2, "primary newest")),
        unregister: () => {},
      }),
      recordSteps: async () => {},
      updatePresence: async () => {},
      disconnect: () => {},
    })
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/streams/stream_1/messages?"))
        return sourceMessages(sourceMessage(primary, "primary newest"))
      return json({ data: {} })
    })
    try {
      await __testing.restorePendingAfterReload(pi as never, ctx)
      expect(sends).toEqual([])
      expect(__testing.pendingRuntimeState()).toMatchObject({
        waitingForRetry: true,
        invocationPrompt: expect.stringContaining("primary newest"),
        steered: [],
      })
      __testing.setPendingRuntimeForTesting({ waitingForRetry: true, retryAttempts: 1 })
      await __testing.executeProviderRetry(pi as never, ctx, 1, __testing.sessionLifecycleGeneration())
      expect(sends).toHaveLength(1)
      expect(sends[0]).toContain("primary newest")
      expect(sends[0]).not.toContain("primary old full")
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("rate-limit retry composes the edited secondary prompt without replacing the primary", async () => {
    configure(true)
    const primary = invocation("binv_retry_composed_primary", 1, "primary source")
    const secondary = invocation("binv_retry_composed_secondary", 1, "secondary old")
    const ctx = context({ idle: true })
    const callbacks = new Map<string, any>()
    __testing.setTransportForTesting({
      observeClaim: (params: any) => {
        callbacks.set(params.invocationId, params.callbacks)
        return { sync: async () => {}, unregister: () => {} }
      },
      recordSteps: async () => {},
      updatePresence: async () => {},
      disconnect: () => {},
    })
    const pi = { sendUserMessage: (_text: string) => {} }
    __testing.beginPendingInvocation(primary as never)
    __testing.setPendingRuntimeForTesting({
      invocationPrompt: "primary canonical full prompt",
      steered: [{ invocation: secondary as never, retryPrompt: "secondary old steer" }],
      waitingForRetry: true,
      retryAttempts: 1,
    })
    expect(await __testing.observeInvocation(pi as never, ctx, primary as never, "running")).toBe(true)
    expect(await __testing.observeInvocation(pi as never, ctx, secondary as never, "running")).toBe(true)
    const sends: string[] = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/streams/stream_1/messages?"))
        return sourceMessages(
          sourceMessage(primary, "primary source"),
          sourceMessage(secondary, "secondary newest", { sequence: "2", createdAt: "2026-01-01T00:00:01Z" })
        )
      return json({ data: {} })
    })
    try {
      expect(await callbacks.get(secondary.id).onInputUpdated(plaintextUpdate(secondary, 2, "secondary newest"))).toBe(
        "applied"
      )
      expect(__testing.pendingRuntimeState()).toMatchObject({
        invocationPrompt: "primary canonical full prompt",
        steered: [{ retryPrompt: expect.stringContaining("secondary newest") }],
      })
      __testing.savePendingSnapshot(ctx)
      const snapshot = JSON.parse(
        readFileSync(__testing.pendingSnapshotPathForTesting(runtimeSessionId), "utf8")
      ) as any
      expect(snapshot.steered[0].retryPrompt).toContain("secondary newest")
      await __testing.executeProviderRetry(
        { sendUserMessage: (text: string) => sends.push(text) } as never,
        ctx,
        1,
        __testing.sessionLifecycleGeneration()
      )
      expect(sends).toHaveLength(1)
      expect(sends[0]).toContain("primary canonical full prompt")
      expect(sends[0]).toContain("secondary newest")
      expect(sends[0]).not.toContain("secondary old steer")
      expect(sends[0]!.indexOf("primary canonical full prompt")).toBeLessThan(sends[0]!.indexOf("secondary newest"))
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("plaintext source claimed during retry stays revision-owned and edits its retry prompt", async () => {
    configure(true)
    const primary = invocation("binv_wait_primary", 1, "primary")
    const contributor = invocation("binv_wait_plain", 3, "queued source")
    const ctx = context({ idle: true })
    const callbacks = new Map<string, any>()
    __testing.setTransportForTesting({
      observeClaim: (params: any) => {
        callbacks.set(params.invocationId, params.callbacks)
        return { sync: async () => {}, unregister: () => {} }
      },
      recordSteps: async () => {},
      updatePresence: async () => {},
      disconnect: () => {},
    })
    __testing.beginPendingInvocation(primary as never)
    __testing.setPendingRuntimeForTesting({
      invocationPrompt: "primary retry prompt",
      waitingForRetry: true,
      retryAt: Date.now() + 60_000,
      retryAttempts: 1,
    })
    expect(await __testing.observeInvocation({} as never, ctx, primary as never, "running")).toBe(true)
    expect(await __testing.observeInvocation({} as never, ctx, contributor as never, "processing")).toBe(true)
    const terminalWrites: string[] = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes("/streams/stream_1/messages?"))
        return sourceMessages(sourceMessage(contributor, "queued source", { sequence: "3" }))
      if (url.endsWith("/complete") || url.endsWith("/fail")) terminalWrites.push(url)
      return json({ data: {} })
    })
    try {
      expect(
        await __testing.prepareRetryWaitContributor(
          {} as never,
          ctx,
          contributor as never,
          __testing.sessionLifecycleGeneration()
        )
      ).toBe(true)
      expect(__testing.pendingRuntimeState()).toMatchObject({
        waitingForRetry: true,
        steered: [{ id: contributor.id, sourceRevision: 3, retryPrompt: "queued source" }],
      })
      expect(terminalWrites).toEqual([])
      expect(await callbacks.get(contributor.id).onInputUpdated(plaintextUpdate(contributor, 4, "queued edited"))).toBe(
        "applied"
      )
      expect(__testing.pendingRuntimeState()).toMatchObject({
        steered: [{ id: contributor.id, sourceRevision: 4, retryPrompt: expect.stringContaining("queued edited") }],
      })
      expect(__testing.observedInvocationStates()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: contributor.id, state: "running" })])
      )
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("sealed source claimed during retry hydrates strictly and remains a contributor", async () => {
    configure(true)
    const primary = invocation("binv_wait_sealed_primary", 1, "primary")
    const encrypted = await encryptAttachmentBytes(new TextEncoder().encode("sealed queued"))
    const ref = attachmentRef("att_wait_sealed", encrypted, { filename: "queued.txt", sizeBytes: 13 })
    const contributor = {
      ...invocation("binv_wait_sealed", 2, "sealed queued source"),
      sealing: sealingState(),
      sealedHistoryContextText: "sealed history",
      sealedContextText: "sealed history",
      sealedSourceAttachmentRefs: [ref],
      sealedHistoryAttachmentRefs: [],
    }
    const ctx = context({ idle: true })
    __testing.setTransportForTesting({
      observeClaim: () => ({ sync: async () => {}, unregister: () => {} }),
      recordSteps: async () => {},
      updatePresence: async () => {},
      disconnect: () => {},
    })
    __testing.beginPendingInvocation(primary as never)
    __testing.setPendingRuntimeForTesting({
      invocationPrompt: "primary retry prompt",
      waitingForRetry: true,
      retryAt: Date.now() + 60_000,
      retryAttempts: 1,
    })
    expect(await __testing.observeInvocation({} as never, ctx, primary as never, "running")).toBe(true)
    expect(await __testing.observeInvocation({} as never, ctx, contributor as never, "processing")).toBe(true)
    const requests: string[] = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      requests.push(url)
      if (url.includes("/attachments/att_wait_sealed/url")) {
        return json({ data: { url: "https://signed.test/wait-sealed" } })
      }
      if (url === "https://signed.test/wait-sealed") return new Response(encrypted.ciphertext)
      return json({ data: {} })
    })
    try {
      expect(
        await __testing.prepareRetryWaitContributor(
          {} as never,
          ctx,
          contributor as never,
          __testing.sessionLifecycleGeneration()
        )
      ).toBe(true)
      expect(__testing.pendingRuntimeState()).toMatchObject({
        waitingForRetry: true,
        steered: [{ id: contributor.id, retryPrompt: expect.stringContaining("queued.txt") }],
      })
      expect({
        terminalWrites: requests.some((url) => url.endsWith("/sealed-complete") || url.endsWith("/fail")),
        messageFetches: requests.some((url) => url.includes("/streams/") && url.includes("/messages")),
      }).toEqual({ terminalWrites: false, messageFetches: false })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("retry firing during contributor preparation live-steers only that contributor", async () => {
    configure(true)
    const primary = invocation("binv_wait_race_primary", 1, "primary")
    const contributor = invocation("binv_wait_race_contributor", 1, "contributor")
    const ctx = context({ idle: true })
    __testing.setTransportForTesting({
      observeClaim: () => ({ sync: async () => {}, unregister: () => {} }),
      recordSteps: async () => {},
      updatePresence: async () => {},
      disconnect: () => {},
    })
    const sends: Array<{ text: string; options: unknown }> = []
    const pi = { sendUserMessage: (text: string, options?: unknown) => sends.push({ text, options }) }
    __testing.beginPendingInvocation(primary as never)
    __testing.setPendingRuntimeForTesting({
      invocationPrompt: "primary retry prompt",
      waitingForRetry: true,
      retryAt: Date.now(),
      retryAttempts: 1,
    })
    expect(await __testing.observeInvocation(pi as never, ctx, primary as never, "running")).toBe(true)
    expect(await __testing.observeInvocation(pi as never, ctx, contributor as never, "processing")).toBe(true)
    const contextGate = deferred<Response>()
    let contextStarted = false
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/streams/stream_1/messages?")) {
        contextStarted = true
        return contextGate.promise
      }
      return json({ data: {} })
    })
    try {
      const preparation = __testing.prepareRetryWaitContributor(
        pi as never,
        ctx,
        contributor as never,
        __testing.sessionLifecycleGeneration()
      )
      await waitFor(() => contextStarted, "retry contributor context")
      await __testing.executeProviderRetry(pi as never, ctx, 1, __testing.sessionLifecycleGeneration())
      contextGate.resolve(sourceMessages(sourceMessage(contributor, "contributor current", { sequence: "2" })))
      expect(await preparation).toBe(true)
      expect(sends).toEqual([
        expect.objectContaining({ text: expect.stringContaining("primary retry prompt"), options: undefined }),
        expect.objectContaining({ text: "contributor", options: { deliverAs: "steer" } }),
      ])
      expect(__testing.pendingRuntimeState()).toMatchObject({
        waitingForRetry: false,
        steered: [{ id: contributor.id }],
      })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("deletion while retry contributor context is blocked cancels the combined turn", async () => {
    configure(true)
    const primary = invocation("binv_wait_delete_primary", 1, "primary")
    const contributor = invocation("binv_wait_delete_contributor", 1, "delete queued")
    const ctx = context({ idle: true })
    let callbacks: any
    __testing.setTransportForTesting({
      observeClaim: (params: any) => {
        if (params.invocationId === contributor.id) callbacks = params.callbacks
        return { sync: async () => {}, unregister: () => {} }
      },
      recordSteps: async () => {},
      updatePresence: async () => {},
      disconnect: () => {},
    })
    const sends: string[] = []
    const pi = { sendUserMessage: (text: string) => sends.push(text) }
    __testing.beginPendingInvocation(primary as never)
    __testing.setPendingRuntimeForTesting({
      invocationPrompt: "primary retry prompt",
      waitingForRetry: true,
      retryAt: Date.now() + 60_000,
      retryAttempts: 1,
    })
    expect(await __testing.observeInvocation(pi as never, ctx, primary as never, "running")).toBe(true)
    expect(await __testing.observeInvocation(pi as never, ctx, contributor as never, "processing")).toBe(true)
    const contextGate = deferred<Response>()
    let contextStarted = false
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/streams/stream_1/messages?")) {
        contextStarted = true
        return contextGate.promise
      }
      return json({ data: {} })
    })
    try {
      const preparation = __testing.prepareRetryWaitContributor(
        pi as never,
        ctx,
        contributor as never,
        __testing.sessionLifecycleGeneration()
      )
      await waitFor(() => contextStarted, "blocked contributor context")
      await callbacks.onCancelled({
        invocationId: contributor.id,
        sourceRevision: contributor.sourceRevision,
        reason: "source_deleted",
      })
      contextGate.resolve(sourceMessages(sourceMessage(contributor, "delete queued", { sequence: "2" })))
      expect(await preparation).toBe(false)
      expect({ sends, pending: __testing.pendingInvocationId() }).toEqual({ sends: [], pending: undefined })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("reload resumes contributor terminalization without repeating primary provider completion", async () => {
    configure(true)
    const primary = invocation("binv_close_reload_primary", 1, "primary")
    const contributor = invocation("binv_close_reload_contributor", 1, "contributor")
    const ctx = context({ idle: true })
    __testing.setTransportForTesting({
      observeClaim: () => ({ sync: async () => {}, unregister: () => {} }),
      recordSteps: async () => {},
      updatePresence: async () => {},
      disconnect: () => {},
    })
    __testing.beginPendingInvocation(primary as never)
    __testing.setPendingRuntimeForTesting({
      invocationPrompt: "primary prompt",
      steered: [{ invocation: contributor as never, retryPrompt: "contributor prompt" }],
    })
    expect(await __testing.observeInvocation({} as never, ctx, primary as never, "running")).toBe(true)
    expect(await __testing.observeInvocation({} as never, ctx, contributor as never, "running")).toBe(true)
    let primaryResponses = 0
    let contributorWrites = 0
    const firstFetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith(`/bot-invocations/${primary.id}/complete`)) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        if (body.finalMessageMarkdown) primaryResponses++
        return json({ data: {} })
      }
      if (
        url.endsWith(`/bot-invocations/${contributor.id}/complete`) ||
        url.endsWith(`/bot-invocations/${contributor.id}/fail`)
      ) {
        contributorWrites++
        return json({ error: "temporary" }, 503)
      }
      return json({ data: {} })
    })
    try {
      await __testing.completePending("primary answer", ctx)
      expect(__testing.pendingRuntimeState()).toMatchObject({ primaryCompleted: true, terminalWriteOwners: 1 })
      const snapshot = JSON.parse(
        readFileSync(__testing.pendingSnapshotPathForTesting(runtimeSessionId), "utf8")
      ) as Record<string, unknown>
      expect(snapshot.primaryCompleted).toBe(true)
    } finally {
      firstFetch.mockRestore()
    }
    await __testing.resetRuntimeForTesting()
    configure(true)
    __testing.setTransportForTesting({
      observeClaim: () => ({ sync: async () => {}, unregister: () => {} }),
      recordSteps: async () => {},
      updatePresence: async () => {},
      disconnect: () => {},
    })
    const secondFetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith(`/bot-invocations/${primary.id}/complete`)) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        if (body.finalMessageMarkdown) primaryResponses++
      }
      if (url.endsWith(`/bot-invocations/${contributor.id}/complete`)) contributorWrites++
      return json({ data: {} })
    })
    try {
      await __testing.restorePendingAfterReload({} as never, ctx)
      expect({ primaryResponses, pending: __testing.pendingInvocationId() }).toEqual({
        primaryResponses: 1,
        pending: undefined,
      })
      expect(contributorWrites).toBeGreaterThan(1)
    } finally {
      secondFetch.mockRestore()
    }
  })

  test("reload recovered-completion edit rejects old output and waits for cancellation", async () => {
    configure(true)
    const claim = invocation("binv_recovered_edit", 1, "old prompt")
    const ctx = context({
      idle: true,
      branch: [
        { type: "message", message: { role: "user", content: "old full prompt" } },
        { type: "message", message: { role: "assistant", content: "old answer" } },
      ],
    })
    __testing.beginPendingInvocation(claim as never)
    __testing.setPendingRuntimeForTesting({ invocationPrompt: "old full prompt" })
    __testing.savePendingSnapshot(ctx)
    await __testing.resetRuntimeForTesting()
    configure(true)

    let callbacks: any
    let disposition: string | undefined
    let unregisters = 0
    __testing.setTransportForTesting({
      observeClaim: (params: any) => {
        callbacks = params.callbacks
        return {
          sync: async () => {
            disposition = await callbacks.onInputUpdated(plaintextUpdate(claim, 2, "edited after completion"))
          },
          unregister: () => unregisters++,
        }
      },
      recordSteps: async () => {},
      updatePresence: async () => {},
      disconnect: () => {},
    })
    const writes: string[] = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      writes.push(String(input))
      return json({ data: {} })
    })
    try {
      await __testing.restorePendingAfterReload({ sendUserMessage: () => writes.push("send") } as never, ctx)
      expect({
        disposition,
        pending: __testing.pendingInvocationId(),
        unregisters,
        actuated: writes.some((write) => write.includes("/complete") || write === "send"),
      }).toEqual({ disposition: "restart-required", pending: undefined, unregisters: 0, actuated: false })
      await callbacks.onCancelled({ invocationId: claim.id, sourceRevision: 2, reason: "adapter_restart_required" })
      expect(unregisters).toBe(1)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("reload cancellation discards the snapshot without injecting or completing", async () => {
    configure(true)
    const claim = invocation("binv_reload_cancel")
    const ctx = context({ idle: false })
    __testing.beginPendingInvocation(claim as never)
    __testing.setPendingRuntimeForTesting({ invocationPrompt: "old full prompt" })
    __testing.savePendingSnapshot(ctx)
    await __testing.resetRuntimeForTesting()
    configure(true)
    let unregisters = 0
    const sends: string[] = []
    __testing.setTransportForTesting({
      observeClaim: (params: any) => ({
        sync: () => params.callbacks.onCancelled({ invocationId: claim.id, reason: "source_deleted" }),
        unregister: () => unregisters++,
      }),
      recordSteps: async () => {},
      updatePresence: async () => {},
      disconnect: () => {},
    })
    await __testing.restorePendingAfterReload({ sendUserMessage: (text: string) => sends.push(text) } as never, ctx)
    expect({
      sends,
      pending: __testing.pendingInvocationId(),
      observed: __testing.observedInvocationCount(),
      unregisters,
    }).toEqual({ sends: [], pending: undefined, observed: 0, unregisters: 1 })
  })

  for (const scenario of [
    {
      name: "a retry blocked by an edit defers and injects only the newest prompt",
      id: "binv_retry_race",
      gate: "recordSteps" as const,
      gateEveryCall: false,
      waitLabel: "blocked retry trace",
      oldPrompt: "old primary prompt",
      newPrompt: "new primary prompt",
    },
    {
      name: "a retry blocked in heartbeat waits for an overlapping edit before delivery",
      id: "binv_retry_heartbeat",
      gate: "updatePresence" as const,
      gateEveryCall: true,
      waitLabel: "retry heartbeat",
      oldPrompt: "old heartbeat prompt",
      newPrompt: "new heartbeat prompt",
    },
  ]) {
    test(scenario.name, async () => {
      configure()
      const claim = invocation(scenario.id)
      const ctx = context()
      const blockGate = deferred<void>()
      const contextGate = deferred<Response>()
      let blockedCalls = 0
      const sends: string[] = []
      __testing.beginPendingInvocation(claim as never)
      __testing.setPendingRuntimeForTesting({
        invocationPrompt: scenario.oldPrompt,
        waitingForRetry: true,
        retryAttempts: 1,
      })
      const blocked = async () => {
        blockedCalls++
        if (scenario.gateEveryCall || blockedCalls === 1) await blockGate.promise
      }
      const observation = await observe(
        claim,
        { sendUserMessage: (text: string) => sends.push(text) },
        ctx,
        scenario.gate === "recordSteps" ? { recordSteps: blocked } : { updatePresence: blocked }
      )
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        if (String(input).includes("/streams/stream_1/messages?")) return contextGate.promise
        return json({ data: {} })
      })
      try {
        const retry = __testing.executeProviderRetry(
          { sendUserMessage: (text: string) => sends.push(text) } as never,
          ctx,
          1,
          __testing.sessionLifecycleGeneration()
        )
        await waitFor(() => blockedCalls >= 1, scenario.waitLabel)
        const update = observation.callbacks.onInputUpdated(plaintextUpdate(claim, 2, scenario.newPrompt))
        blockGate.resolve()
        await retry
        contextGate.resolve(sourceMessages(sourceMessage(claim, scenario.newPrompt)))
        expect(await update).toBe("applied")
        await waitFor(() => sends.length === 1, "deferred retry delivery")
        expect(sends[0]).toContain(scenario.newPrompt)
        expect(sends[0]).not.toContain(scenario.oldPrompt)
      } finally {
        fetchSpy.mockRestore()
      }
    })
  }

  test("cancellation while a fired retry is blocked injects nothing", async () => {
    configure()
    const claim = invocation("binv_retry_cancel")
    const ctx = context()
    const traceGate = deferred<void>()
    let traceStarted = false
    const sends: string[] = []
    __testing.beginPendingInvocation(claim as never)
    __testing.setPendingRuntimeForTesting({ invocationPrompt: "delete me", waitingForRetry: true, retryAttempts: 1 })
    const observation = await observe(claim, { sendUserMessage: (text: string) => sends.push(text) }, ctx, {
      recordSteps: async () => {
        traceStarted = true
        await traceGate.promise
      },
    })
    const retry = __testing.executeProviderRetry(
      { sendUserMessage: (text: string) => sends.push(text) } as never,
      ctx,
      1,
      __testing.sessionLifecycleGeneration()
    )
    await waitFor(() => traceStarted, "retry trace")
    await observation.callbacks.onCancelled({ invocationId: claim.id, reason: "source_deleted" })
    traceGate.resolve()
    await retry
    await Bun.sleep(20)
    expect({ sends, pending: __testing.pendingInvocationId() }).toEqual({ sends: [], pending: undefined })
  })

  test("old message capture overlapping an edit cannot populate the replacement output", async () => {
    configure(true)
    const claim = invocation("binv_output_message")
    const ctx = context()
    const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>()
    const sends: string[] = []
    const pi = {
      registerCommand: () => {},
      on: (event: string, handler: (event: any, ctx: any) => Promise<void>) => handlers.set(event, handler),
      sendUserMessage: (text: string) => sends.push(text),
    }
    threaRemote(pi as never)
    __testing.beginPendingInvocation(claim as never)
    __testing.setPendingRuntimeForTesting({ invocationPrompt: "old full prompt" })
    const oldTraceGate = deferred<void>()
    let traceCalls = 0
    const observation = await observe(claim, pi, ctx, {
      recordSteps: async () => {
        traceCalls++
        if (traceCalls === 1) await oldTraceGate.promise
      },
    })
    const completions: Array<Record<string, unknown>> = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes("/streams/stream_1/messages?")) return sourceMessages(sourceMessage(claim, "new prompt"))
      if (url.endsWith(`/bot-invocations/${claim.id}/complete`)) {
        completions.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      }
      return json({ data: {} })
    })
    try {
      __testing.armPendingOutputForTesting()
      await handlers.get("turn_start")!({ turnIndex: 0 }, ctx)
      const oldMessage = handlers.get("message_end")!({ message: { role: "assistant", content: "old answer" } }, ctx)
      await waitFor(() => traceCalls === 1, "old message trace")
      expect(await observation.callbacks.onInputUpdated(plaintextUpdate(claim, 2, "new prompt"))).toBe("applied")
      await handlers.get("turn_start")!({ turnIndex: 1 }, ctx)
      oldTraceGate.resolve()
      await oldMessage
      await handlers.get("message_end")!({ message: { role: "assistant", content: "new answer" } }, ctx)
      await handlers.get("agent_end")!({ messages: [] }, ctx)
      expect(completions).toEqual([expect.objectContaining({ sourceRevision: 2, finalMessageMarkdown: "new answer" })])
      expect(JSON.stringify(completions)).not.toContain("old answer")
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("a steer stranded by an errored assistant message settles at agent_end", async () => {
    configure(true)
    const claim = invocation("binv_stranded_steer")
    const ctx = context({ idle: false })
    const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>()
    const pi = {
      registerCommand: () => {},
      on: (event: string, handler: (event: any, ctx: any) => Promise<void>) => handlers.set(event, handler),
      sendUserMessage: () => {},
    }
    threaRemote(pi as never)
    __testing.beginPendingInvocation(claim as never)
    __testing.setPendingRuntimeForTesting({ invocationPrompt: "full prompt" })
    await observe(claim, pi, ctx, { initialState: "running" })
    const completions: Array<Record<string, unknown>> = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith(`/bot-invocations/${claim.id}/complete`)) {
        completions.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      }
      return json({ data: {} })
    })
    try {
      __testing.armPendingOutputForTesting()
      await handlers.get("turn_start")!({ turnIndex: 0 }, ctx)
      await handlers.get("message_end")!({ message: { role: "assistant", content: "before the steer" } }, ctx)
      __testing.armPendingOutputForTesting()
      await handlers.get("agent_end")!(
        { messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider exploded", content: [] }] },
        ctx
      )
      expect({ completions, pending: __testing.pendingRuntimeState().invocationPrompt }).toEqual({
        completions: [expect.objectContaining({ finalMessageMarkdown: expect.stringContaining("provider exploded") })],
        pending: undefined,
      })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("old provider settlement cannot complete after a newer turn starts", async () => {
    configure(true)
    const claim = invocation("binv_output_provider")
    const ctx = context()
    const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>()
    const pi = {
      registerCommand: () => {},
      on: (event: string, handler: (event: any, ctx: any) => Promise<void>) => handlers.set(event, handler),
      sendUserMessage: () => {},
    }
    threaRemote(pi as never)
    __testing.beginPendingInvocation(claim as never)
    __testing.setPendingRuntimeForTesting({ invocationPrompt: "old full prompt" })
    const oldSettlementGate = deferred<void>()
    let traceCalls = 0
    const observation = await observe(claim, pi, ctx, {
      recordSteps: async () => {
        traceCalls++
        if (traceCalls === 1) await oldSettlementGate.promise
      },
    })
    const completions: Array<Record<string, unknown>> = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes("/streams/stream_1/messages?")) return sourceMessages(sourceMessage(claim, "edited prompt"))
      if (url.endsWith(`/bot-invocations/${claim.id}/complete`)) {
        completions.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      }
      return json({ data: {} })
    })
    try {
      __testing.armPendingOutputForTesting()
      await handlers.get("turn_start")!({ turnIndex: 0 }, ctx)
      await handlers.get("after_provider_response")!({ status: 500, headers: {} }, ctx)
      const oldEnd = handlers.get("agent_end")!({ messages: [] }, ctx)
      await waitFor(() => traceCalls === 1, "old provider settlement trace")
      expect(await observation.callbacks.onInputUpdated(plaintextUpdate(claim, 2, "edited prompt"))).toBe("applied")
      await handlers.get("turn_start")!({ turnIndex: 1 }, ctx)
      oldSettlementGate.resolve()
      await oldEnd
      expect(completions).toEqual([])
      await handlers.get("message_end")!({ message: { role: "assistant", content: "new provider answer" } }, ctx)
      await handlers.get("agent_end")!({ messages: [] }, ctx)
      expect(completions).toEqual([
        expect.objectContaining({ sourceRevision: 2, finalMessageMarkdown: "new provider answer" }),
      ])
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("plaintext update attachment failure restarts without steering", async () => {
    configure()
    const claim = invocation("binv_plain_attachment")
    const sends: string[] = []
    __testing.beginPendingInvocation(claim as never)
    __testing.setPendingRuntimeForTesting({ invocationPrompt: "old" })
    const observation = await observe(claim, { sendUserMessage: (text: string) => sends.push(text) }, context())
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes("/streams/stream_1/messages?"))
        return sourceMessages(
          sourceMessage(claim, "edited", {
            attachments: [{ id: "att_bad", filename: "bad.txt", mimeType: "text/plain", sizeBytes: 3 }],
          })
        )
      if (url.includes("/attachments/att_bad/url")) return json({ data: { url: "https://signed.test/bad" } })
      if (url === "https://signed.test/bad") return new Response("bad", { status: 503 })
      return json({ data: {} })
    })
    try {
      expect(await observation.callbacks.onInputUpdated(plaintextUpdate(claim, 2, "edited"))).toBe("restart-required")
      expect(sends).toEqual([])
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("deletion aborts a sealed update blocked in attachment rebuild before steering", async () => {
    configure()
    const encrypted = await encryptAttachmentBytes(new TextEncoder().encode("deleted secret"))
    const ref = attachmentRef("att_deleted_update", encrypted, { filename: "deleted.txt", sizeBytes: 14 })
    const sealing = sealingState()
    const claim = {
      ...invocation("binv_abort_rebuild"),
      sealing,
      sealedHistoryContextText: "history",
      sealedContextText: "history",
      sealedSourceAttachmentRefs: [],
    }
    const ctx = context({ idle: false })
    const sends: string[] = []
    __testing.beginPendingInvocation(claim as never)
    __testing.setPendingRuntimeForTesting({ invocationPrompt: "old sealed prompt" })
    const observation = await observe(claim, { sendUserMessage: (text: string) => sends.push(text) }, ctx)
    const objectGate = deferred<Response>()
    let objectStarted = false
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes("/attachments/att_deleted_update/url")) {
        return json({ data: { url: "https://signed.test/deleted-update" } })
      }
      if (url === "https://signed.test/deleted-update") {
        objectStarted = true
        return objectGate.promise
      }
      return json({ data: {} })
    })
    const controller = new AbortController()
    try {
      const update = observation.callbacks.onInputUpdated(
        {
          invocationId: claim.id,
          sourceMessageId: claim.sourceMessageId,
          sourceRevision: 2,
          delivery: "sealed",
          promptMarkdown: "must not actuate",
          attachmentRefs: [ref],
          sealing,
        },
        controller.signal
      )
      await waitFor(() => objectStarted, "sealed update object fetch")
      controller.abort()
      objectGate.resolve(new Response(encrypted.ciphertext))
      expect(await update).toBe("restart-required")
      expect({
        sends,
        pending: __testing.pendingInvocationId(),
        observed: __testing.observedInvocationCount(),
      }).toEqual({
        sends: [],
        pending: undefined,
        observed: 0,
      })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("deletion observed at the final context await prevents the steer send", async () => {
    configure()
    const claim = invocation("binv_abort_before_steer")
    const sends: string[] = []
    __testing.beginPendingInvocation(claim as never)
    __testing.setPendingRuntimeForTesting({ invocationPrompt: "old" })
    const observation = await observe(claim, { sendUserMessage: (text: string) => sends.push(text) }, context())
    const controller = new AbortController()
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (!String(input).includes("/streams/stream_1/messages?")) return json({ data: {} })
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => {
          controller.abort()
          return { data: [sourceMessage(claim, "deleted before steer")] }
        },
      } as Response
    })
    try {
      expect(
        await observation.callbacks.onInputUpdated(plaintextUpdate(claim, 2, "deleted before steer"), controller.signal)
      ).toBe("restart-required")
      expect({ sends, pending: __testing.pendingInvocationId() }).toEqual({ sends: [], pending: undefined })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("sealed source replacement and removal never retain the old source path", async () => {
    configure()
    const encrypted = await encryptAttachmentBytes(new TextEncoder().encode("new sealed file"))
    const newRef = attachmentRef("att_new", encrypted, { filename: "new.txt", sizeBytes: 15 })
    const sealing = sealingState()
    const claim = {
      ...invocation("binv_sealed_replace"),
      sealing,
      sealedHistoryContextText: "immutable history only",
      sealedContextText: "immutable history only\n\nold.txt → /old/source/path",
      sealedSteerContextText: "old.txt → /old/source/path",
      sealedSourceAttachmentRefs: [],
    }
    const sends: string[] = []
    __testing.beginPendingInvocation(claim as never)
    __testing.setPendingRuntimeForTesting({ invocationPrompt: "old sealed prompt" })
    const observation = await observe(claim, { sendUserMessage: (text: string) => sends.push(text) }, context())
    const requests: string[] = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      requests.push(url)
      if (url.includes("/attachments/att_new/url")) return json({ data: { url: "https://signed.test/new" } })
      if (url === "https://signed.test/new") return new Response(encrypted.ciphertext)
      return json({ data: {} })
    })
    try {
      expect(
        await observation.callbacks.onInputUpdated({
          invocationId: claim.id,
          sourceMessageId: claim.sourceMessageId,
          sourceRevision: 2,
          delivery: "sealed",
          promptMarkdown: "sealed edited with new file",
          attachmentRefs: [newRef],
          sealing,
        })
      ).toBe("applied")
      expect(sends.at(-1)).toContain("new.txt")
      expect(sends.at(-1)).not.toContain("old.txt")
      expect(
        await observation.callbacks.onInputUpdated({
          invocationId: claim.id,
          sourceMessageId: claim.sourceMessageId,
          sourceRevision: 3,
          delivery: "sealed",
          promptMarkdown: "sealed edited without a file",
          attachmentRefs: [],
          sealing,
        })
      ).toBe("applied")
      expect(sends.at(-1)).toContain("sealed edited without a file")
      expect(sends.at(-1)).not.toContain("new.txt")
      expect(__testing.pendingInvocationState()).toMatchObject({
        sealedHistoryContextText: "immutable history only",
        sealedContextText: "immutable history only",
      })
      expect(requests.some((url) => url.includes("/streams/") && url.includes("/messages"))).toBe(false)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("restarting a standalone control preserves an unrelated provider retry", async () => {
    configure()
    const primary = invocation("binv_waiting_primary", 4, "primary canonical")
    const control = {
      ...invocation("binv_waiting_control", 1, "/thinking high"),
      requiredCapability: "session-control",
      metadata: {
        command: { id: "cmd_waiting", name: "thinking", args: "high", executionKind: "bot-runtime" },
      },
    }
    const ctx = context({ idle: true })
    __testing.beginPendingInvocation(primary as never)
    __testing.setPendingRuntimeForTesting({
      invocationPrompt: "primary canonical full prompt",
      waitingForRetry: true,
      retryAt: Date.now() + 60_000,
      retryAttempts: 2,
      carryOns: ["keep this carry-on"],
    })
    const primaryObservation = await observe(primary, {}, ctx, { initialState: "running" })
    const traceGate = deferred<void>()
    let traceStarted = false
    const controlObservation = await observe(control, {}, ctx, {
      initialState: "processing",
      recordSteps: async () => {
        traceStarted = true
        await traceGate.promise
      },
    })
    const handling = __testing.handleSessionControlInvocation(
      {
        getThinkingLevel: () => "low",
        setThinkingLevel: () => {},
      } as never,
      ctx,
      control as never
    )
    await waitFor(() => traceStarted, "standalone control trace")
    expect(await controlObservation.callbacks.onInputUpdated(plaintextUpdate(control, 2, "/thinking xhigh"))).toBe(
      "restart-required"
    )
    traceGate.resolve()
    await handling
    expect(__testing.pendingInvocationState()).toMatchObject({ id: primary.id, sourceRevision: 4 })
    expect(__testing.pendingRuntimeState()).toMatchObject({
      waitingForRetry: true,
      invocationPrompt: "primary canonical full prompt",
    })
    expect(__testing.observedInvocationStates()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: primary.id, state: "running", restartRequested: false }),
        expect.objectContaining({ id: control.id, state: "processing", restartRequested: true }),
      ])
    )
    expect(primaryObservation.unregisters()).toBe(0)
    await controlObservation.callbacks.onCancelled({
      invocationId: control.id,
      sourceRevision: 2,
      reason: "adapter_restart_required",
    })
    expect(controlObservation.unregisters()).toBe(1)
    expect(__testing.pendingInvocationId()).toBe(primary.id)
    expect(__testing.pendingRuntimeState()).toMatchObject({ waitingForRetry: true })
    expect(__testing.observedInvocationStates()).toEqual([
      expect.objectContaining({ id: primary.id, state: "running", restartRequested: false }),
    ])
    expect(primaryObservation.unregisters()).toBe(0)
  })

  // Both shell-control regressions need the same blocked-helper-trace setup: a
  // /shell control observed in `processing`, parked inside its second trace
  // write while `handleSessionControlInvocation` is in flight.
  const blockedShellControl = async (id: string, commandId: string, markerName: string) => {
    const marker = join(testStorageDirectory, markerName)
    const claim = {
      ...invocation(id, 1, `/shell touch ${marker}`),
      requiredCapability: "session-control",
      metadata: {
        command: { id: commandId, name: "shell", args: `touch ${marker}`, executionKind: "bot-runtime" },
      },
    }
    const counters = { aborts: 0 }
    const ctx = context({ idle: false, abort: () => counters.aborts++ })
    const helperTraceGate = deferred<void>()
    let traceCalls = 0
    const observation = await observe(claim, {}, ctx, {
      initialState: "processing",
      recordSteps: async () => {
        traceCalls++
        if (traceCalls === 2) await helperTraceGate.promise
      },
    })
    const requests: string[] = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      requests.push(String(input))
      return json({ data: {} })
    })
    const handling = __testing.handleSessionControlInvocation({} as never, ctx, claim as never)
    await waitFor(() => traceCalls === 2, "shell helper trace")
    const terminalWrites = () => requests.some((url) => url.endsWith("/complete") || url.endsWith("/fail"))
    return { claim, marker, counters, observation, handling, helperTraceGate, terminalWrites, fetchSpy }
  }

  test("cancelling a shell control while its helper trace is blocked prevents actuation", async () => {
    configure()
    const shell = await blockedShellControl("binv_control_cancel", "cmd_shell", "must-not-exist")
    try {
      await shell.observation.callbacks.onCancelled({ invocationId: shell.claim.id, reason: "source_deleted" })
      shell.helperTraceGate.resolve()
      await shell.handling
      expect({
        exists: existsSync(shell.marker),
        aborts: shell.counters.aborts,
        unregisters: shell.observation.unregisters(),
        terminalWrites: shell.terminalWrites(),
      }).toEqual({ exists: false, aborts: 1, unregisters: 1, terminalWrites: false })
    } finally {
      shell.fetchSpy.mockRestore()
    }
  })

  test("editing a shell control while its helper trace is blocked requests restart without actuation", async () => {
    configure()
    const shell = await blockedShellControl("binv_control_restart", "cmd_shell_restart", "restart-must-not-exist")
    try {
      expect(
        await shell.observation.callbacks.onInputUpdated(
          plaintextUpdate(shell.claim, 2, `/shell touch ${shell.marker}`)
        )
      ).toBe("restart-required")
      expect(shell.observation.unregisters()).toBe(0)
      shell.helperTraceGate.resolve()
      await shell.handling
      expect({
        exists: existsSync(shell.marker),
        aborts: shell.counters.aborts,
        terminalWrites: shell.terminalWrites(),
      }).toEqual({ exists: false, aborts: 0, terminalWrites: false })
      await shell.observation.callbacks.onCancelled({
        invocationId: shell.claim.id,
        sourceRevision: 2,
        reason: "adapter_restart_required",
      })
      expect(shell.observation.unregisters()).toBe(1)
    } finally {
      shell.fetchSpy.mockRestore()
    }
  })

  test("successful observed reload acknowledgement still queues the reload handoff", async () => {
    configure()
    const claim = {
      ...invocation("binv_observed_reload", 0, "/reload"),
      requiredCapability: "session-control",
      metadata: { command: { id: "cmd_reload", name: "reload", args: "", executionKind: "bot-runtime" } },
    }
    const ctx = context({ idle: true })
    const followUps: Array<{ text: string; options: unknown }> = []
    const pi = { sendUserMessage: (text: string, options: unknown) => followUps.push({ text, options }) }
    const observation = await observe(claim, pi, ctx, { initialState: "processing" })
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(json({ data: {} }))
    try {
      await __testing.handleSessionControlInvocation(pi as never, ctx, claim as never)
      expect(followUps).toEqual([{ text: "/threa-remote-reload", options: { deliverAs: "followUp" } }])
      expect({ unregisters: observation.unregisters(), reloadPending: __testing.reloadPending() }).toEqual({
        unregisters: 1,
        reloadPending: true,
      })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("successful observed reconnect acknowledgement still starts the prepared handoff", async () => {
    configure(true)
    const claim = {
      ...invocation("binv_observed_reconnect", 0, "/reconnect"),
      requiredCapability: "session-control",
      metadata: { command: { id: "cmd_reconnect", name: "reconnect", args: "", executionKind: "bot-runtime" } },
    }
    const ctx = context({ idle: true })
    const observation = await observe(claim, {}, ctx, { initialState: "processing" })
    let starts = 0
    process.env.TMUX_PANE = "%pi-matrix"
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(json({ data: {} }))
    try {
      await __testing.runReconnectCommand(
        claim as never,
        "",
        ctx,
        {
          available: () => true,
          prepare: () => () => {
            starts++
          },
          complete: __testing.completeInvocationWithMarkdown,
          heartbeat: async () => {},
        } as never,
        () => __testing.observedInvocationCount() > 0
      )
      expect({ starts, unregisters: observation.unregisters() }).toEqual({ starts: 1, unregisters: 1 })
    } finally {
      delete process.env.TMUX_PANE
      fetchSpy.mockRestore()
    }
  })

  test("successful sealed ack and E2E no-response fallback both release observation ownership", async () => {
    configure()
    const ctx = context({ idle: true })
    const sealedClaim = invocation("binv_sealed_ack")
    const sealedObservation = await observe(sealedClaim, {}, ctx, { initialState: "processing" })
    const fallbackClaim = { ...invocation("binv_e2e_fallback"), sealedAck: { invalid: true } }
    const fallbackObservation = await observe(fallbackClaim, {}, ctx, { initialState: "processing" })
    const bodies: Array<Record<string, unknown>> = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith("/complete")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        bodies.push(body)
        if (body.finalMessageMarkdown) {
          return new Response(JSON.stringify({ error: { code: "E2E_STREAM_PLAINTEXT_UNSUPPORTED" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          })
        }
      }
      return json({ data: {} })
    })
    try {
      expect(
        await __testing.completeInvocationWithMarkdown(sealedClaim as never, "sealed ack", ctx, {
          sealAck: async () => ({ messageId: "sealed_ack", ciphertext: "cipher", envelope: {} }) as never,
        })
      ).toBe(true)
      expect(await __testing.completeInvocationWithMarkdown(fallbackClaim as never, "fallback ack", ctx)).toBe(false)
      expect({
        sealed: sealedObservation.unregisters(),
        fallback: fallbackObservation.unregisters(),
        noResponseFallback: bodies.some((body) => body.noResponse === true),
      }).toEqual({ sealed: 1, fallback: 1, noResponseFallback: true })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  for (const scenario of [
    { delivery: "plaintext", id: "binv_no_response_fallback", terminal: "complete", sealed: false },
    { delivery: "sealed", id: "binv_sealed_no_response_fallback", terminal: "sealed-complete", sealed: true },
  ]) {
    test(`${scenario.delivery} no-response 503 falls back to fail before releasing ownership`, async () => {
      configure()
      const claim = invocation(scenario.id, 1, "original", scenario.sealed ? { sealing: sealingState() } : {})
      const observation = await observe(claim, {}, context({ idle: true }))
      const writes: string[] = []
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input)
        writes.push(url)
        if (url.endsWith(`/bot-invocations/${claim.id}/${scenario.terminal}`)) {
          expect(observation.unregisters()).toBe(0)
          return json({ error: "temporary" }, 503)
        }
        if (url.endsWith(`/bot-invocations/${claim.id}/fail`)) {
          expect(observation.unregisters()).toBe(0)
          return json({ data: { status: "failed" } })
        }
        return json({ data: {} })
      })
      try {
        expect(await __testing.completeInvocationNoResponse(claim as never)).toBe(true)
        expect({
          writes: writes.map((url) => url.split("/").at(-1)),
          unregisters: observation.unregisters(),
          observed: __testing.observedInvocationCount(),
        }).toEqual({ writes: [scenario.terminal, "fail"], unregisters: 1, observed: 0 })
      } finally {
        fetchSpy.mockRestore()
      }
    })
  }

  test("transient fail retries keep contributor ownership until terminal success", async () => {
    configure()
    const claim = invocation("binv_terminal_retry")
    const observation = await observe(claim, {}, context({ idle: true }))
    let failCalls = 0
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith(`/bot-invocations/${claim.id}/complete`)) return json({ error: "temporary" }, 503)
      if (url.endsWith(`/bot-invocations/${claim.id}/fail`)) {
        failCalls++
        expect(observation.unregisters()).toBe(0)
        return failCalls < 3 ? json({ error: "temporary" }, 503) : json({ data: { status: "failed" } })
      }
      return json({ data: {} })
    })
    try {
      expect(await __testing.completeInvocationNoResponse(claim as never)).toBe(true)
      expect({ failCalls, unregisters: observation.unregisters() }).toEqual({ failCalls: 3, unregisters: 1 })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("cancellation during contributor fail retry stops writes and releases once", async () => {
    configure()
    const claim = invocation("binv_terminal_retry_cancel")
    const observation = await observe(claim, {}, context({ idle: true }))
    const failGate = deferred<Response>()
    let failCalls = 0
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith(`/bot-invocations/${claim.id}/complete`)) return json({ error: "temporary" }, 503)
      if (url.endsWith(`/bot-invocations/${claim.id}/fail`)) {
        failCalls++
        return failGate.promise
      }
      return json({ data: {} })
    })
    try {
      const closing = __testing.completeInvocationNoResponse(claim as never)
      await waitFor(() => failCalls === 1, "contributor fail write")
      await observation.callbacks.onCancelled({
        invocationId: claim.id,
        sourceRevision: claim.sourceRevision,
        reason: "source_deleted",
      })
      failGate.resolve(json({ error: "temporary" }, 503))
      expect(await closing).toBe(false)
      await Bun.sleep(40)
      expect({
        failCalls,
        unregisters: observation.unregisters(),
        owners: __testing.pendingRuntimeState().terminalWriteOwners,
      }).toEqual({
        failCalls: 1,
        unregisters: 1,
        owners: 0,
      })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("structured stale control completion performs no fallback fail and releases once", async () => {
    configure()
    const claim = {
      ...invocation("binv_control_stale", 9, "/thinking high"),
      requiredCapability: "session-control",
      metadata: {
        command: { id: "cmd_thinking", name: "thinking", args: "high", executionKind: "bot-runtime" },
      },
    }
    const ctx = context({ idle: true })
    const observation = await observe(claim, {}, ctx, { initialState: "processing" })
    let level = "low"
    let completeCalls = 0
    let failCalls = 0
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith(`/bot-invocations/${claim.id}/complete`)) {
        completeCalls++
        return new Response(JSON.stringify({ error: { code: "INVOCATION_INPUT_STALE" } }), {
          status: 409,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.endsWith(`/bot-invocations/${claim.id}/fail`)) failCalls++
      return json({ data: {} })
    })
    try {
      await __testing.handleSessionControlInvocation(
        {
          getThinkingLevel: () => level,
          setThinkingLevel: (next: string) => {
            level = next
          },
        } as never,
        ctx,
        claim as never
      )
      expect({ completeCalls, failCalls, unregisters: observation.unregisters(), level }).toEqual({
        completeCalls: 1,
        failCalls: 0,
        unregisters: 1,
        level: "high",
      })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("sealed initial sync installs newest refs before any attachment fetch", async () => {
    configure()
    const oldEncrypted = await encryptAttachmentBytes(new TextEncoder().encode("old"))
    const newEncrypted = await encryptAttachmentBytes(new TextEncoder().encode("new"))
    const oldRef = attachmentRef("att_old", oldEncrypted, { sizeBytes: 3 })
    const newRef = attachmentRef("att_newest", newEncrypted, { sizeBytes: 3 })
    const sealing = sealingState({ replyKeyGeneration: 2 })
    const claim = {
      ...invocation("binv_sealed_sync"),
      sealing,
      sealedHistoryContextText: "history",
      sealedContextText: "history",
      sealedSourceAttachmentRefs: [oldRef],
      sealedHistoryAttachmentRefs: [],
    }
    const fetched: string[] = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      fetched.push(url)
      if (url.includes("/attachments/att_newest/url")) return json({ data: { url: "https://signed.test/newest" } })
      if (url === "https://signed.test/newest") return new Response(newEncrypted.ciphertext)
      if (url.includes("/attachments/att_old/url")) return json({ data: { url: "https://signed.test/old" } })
      if (url === "https://signed.test/old") return new Response(oldEncrypted.ciphertext)
      return json({ data: {} })
    })
    try {
      const observation = await observe(claim, {}, context(), {
        initialState: "unstarted",
        sync: async (callbacks) => {
          expect(fetched).toEqual([])
          expect(
            await callbacks.onInputUpdated({
              invocationId: claim.id,
              sourceMessageId: claim.sourceMessageId,
              sourceRevision: 2,
              delivery: "sealed",
              promptMarkdown: "newest sealed prompt",
              attachmentRefs: [newRef],
              sealing,
            })
          ).toBe("applied")
          expect(fetched).toEqual([])
        },
      })
      expect(observation.active).toBe(true)
      await __testing.prepareSealedClaim(claim as never, context())
      expect({
        newest: fetched.some((url) => url.includes("att_newest")),
        old: fetched.some((url) => url.includes("att_old")),
        contents: readFileSync(
          join(testStorageDirectory, ".threa-attachments", claim.id, "att_newest", "att_newest.txt"),
          "utf8"
        ),
      }).toEqual({ newest: true, old: false, contents: "new" })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("sealed attachment cancellation during object fetch writes no decrypted file", async () => {
    configure()
    const encrypted = await encryptAttachmentBytes(new TextEncoder().encode("secret"))
    const ref = attachmentRef("att_cancelled", encrypted, { filename: "cancelled.txt", sizeBytes: 6 })
    const claim = {
      ...invocation("binv_sealed_cancel"),
      sealing: sealingState(),
      sealedHistoryContextText: "history",
      sealedSourceAttachmentRefs: [ref],
      sealedHistoryAttachmentRefs: [],
    }
    const objectGate = deferred<Response>()
    let objectFetchStarted = false
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes("/attachments/att_cancelled/url")) {
        return json({ data: { url: "https://signed.test/cancelled" } })
      }
      if (url === "https://signed.test/cancelled") {
        objectFetchStarted = true
        return objectGate.promise
      }
      return json({ data: {} })
    })
    try {
      const observation = await observe(claim, {}, context(), { initialState: "unstarted" })
      const preparation = __testing.prepareSealedClaim(claim as never, context())
      await waitFor(() => objectFetchStarted, "sealed object fetch")
      await observation.callbacks.onCancelled({ invocationId: claim.id, reason: "source_deleted" })
      objectGate.resolve(new Response(encrypted.ciphertext))
      await expect(preparation).rejects.toThrow("invocation changed")
      expect({
        wrote: existsSync(join(testStorageDirectory, ".threa-attachments", claim.id, "att_cancelled", "cancelled.txt")),
        unregisters: observation.unregisters(),
      }).toEqual({ wrote: false, unregisters: 1 })
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
