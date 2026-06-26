import { describe, expect, it } from "bun:test"
import {
  buildSteerContent,
  claimCapabilitiesFor,
  isSessionControlInvocation,
  parseSessionControlCommand,
  runtimeCapabilitiesFor,
  supportedCapabilitiesFor,
} from "./channel-server"
import type { ClaimedInvocation } from "./threa-client"

function invocation(overrides: Partial<ClaimedInvocation>): ClaimedInvocation {
  return {
    id: "binv_1",
    workspaceId: "ws_1",
    rootStreamId: "stream_root",
    activeStreamId: "stream_root",
    sourceMessageId: "msg_1",
    responseStreamId: "stream_root",
    actor: { type: "bot", id: "bot_1", slug: "claude" },
    trigger: "active-scratchpad",
    requiredCapability: "active-scratchpad",
    promptMarkdown: "hello",
    authorUserId: "usr_1",
    mentionedActorSlugs: [],
    claimToken: "tok",
    claimExpiresAt: "2026-01-01T00:00:00Z",
    runtimeSessionId: "ccs_1",
    metadata: {},
    ...overrides,
  }
}

describe("parseSessionControlCommand", () => {
  it("reads name + args from structured command metadata", () => {
    const inv = invocation({
      trigger: "session-control",
      promptMarkdown: "/steer focus on the failing test",
      metadata: {
        command: { executionKind: "bot-runtime", id: "cmd_1", name: "steer", args: "focus on the failing test" },
      },
    })
    expect(parseSessionControlCommand(inv)).toEqual({ name: "steer", args: "focus on the failing test" })
  })

  it("falls back to parsing the prompt for a session-control invocation without metadata", () => {
    const inv = invocation({ trigger: "session-control", promptMarkdown: "/model opus", metadata: {} })
    expect(parseSessionControlCommand(inv)).toEqual({ name: "model", args: "opus" })
  })

  it("handles a no-arg command", () => {
    const inv = invocation({ trigger: "session-control", promptMarkdown: "/stop", metadata: {} })
    expect(parseSessionControlCommand(inv)).toEqual({ name: "stop", args: "" })
  })

  it("returns null for a normal (non-session-control) message even if it starts with a slash", () => {
    const inv = invocation({ trigger: "active-scratchpad", promptMarkdown: "/not-a-command really", metadata: {} })
    expect(parseSessionControlCommand(inv)).toBeNull()
    expect(isSessionControlInvocation(inv)).toBe(false)
  })

  it("recognises a session-control invocation via metadata regardless of trigger text", () => {
    const inv = invocation({
      trigger: "session-control",
      metadata: { command: { executionKind: "bot-runtime", id: "cmd_2", name: "run", args: "/remote-control" } },
    })
    expect(isSessionControlInvocation(inv)).toBe(true)
    expect(parseSessionControlCommand(inv)).toEqual({ name: "run", args: "/remote-control" })
  })
})

describe("buildSteerContent", () => {
  it("returns the single part verbatim", () => {
    expect(buildSteerContent(["just this"])).toBe("just this")
  })

  it("combines multiple parts most-recent-last under one header", () => {
    const combined = buildSteerContent(["first queued", "second queued", "the steer"])
    expect(combined).toContain("Handle all of the following together (most recent last):")
    expect(combined.indexOf("first queued")).toBeLessThan(combined.indexOf("the steer"))
    expect(combined).toContain("second queued")
  })
})

describe("capability selection", () => {
  it("advertises session-control only when TUI control is available", () => {
    expect(supportedCapabilitiesFor(true)).toContain("session-control")
    expect(supportedCapabilitiesFor(false)).not.toContain("session-control")
    expect(supportedCapabilitiesFor(false)).toEqual(["active-scratchpad", "mentionable"])
  })

  it("claims everything when idle but session-control only when busy", () => {
    expect(claimCapabilitiesFor(false, true)).toEqual(["active-scratchpad", "mentionable", "session-control"])
    expect(claimCapabilitiesFor(true, true)).toEqual(["session-control"])
  })

  it("claims nothing while busy without TUI control (caller must not claim)", () => {
    expect(claimCapabilitiesFor(true, false)).toEqual([])
    expect(claimCapabilitiesFor(false, false)).toEqual(["active-scratchpad", "mentionable"])
  })

  it("only publishes session-control command capabilities when control is available", () => {
    const enabled = runtimeCapabilitiesFor("ccs_1", true)
    expect(enabled.supportsSessionControlCommands).toBe(true)
    expect(enabled.sessionControlCommands).toEqual(["stop", "steer", "model", "compact", "run"])
    expect(enabled.runtimeSessionId).toBe("ccs_1")

    const disabled = runtimeCapabilitiesFor("ccs_1", false)
    expect(disabled.supportsSessionControlCommands).toBeUndefined()
    expect(disabled.sessionControlCommands).toBeUndefined()
    expect(disabled.runtimeSessionId).toBe("ccs_1")
  })
})
