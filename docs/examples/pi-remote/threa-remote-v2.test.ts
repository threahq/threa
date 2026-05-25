import { describe, expect, test } from "bun:test"
import { __testing } from "./threa-remote-v2"

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
})
