import { describe, expect, spyOn, test } from "bun:test"
import type { BotRuntimeTransport } from "@threa/bot-runtime-client"
import { ThreaClient, type RemoteSessionConfig } from "@threa/remote-session"
import { ChannelServer, buildInstructions, parsePermissionVerdict } from "./channel-server"

describe("parsePermissionVerdict", () => {
  test("parses allow/deny in long and short forms", () => {
    expect(parsePermissionVerdict("yes abcde")).toEqual({ behavior: "allow", requestId: "abcde" })
    expect(parsePermissionVerdict("y abcde")).toEqual({ behavior: "allow", requestId: "abcde" })
    expect(parsePermissionVerdict("no abcde")).toEqual({ behavior: "deny", requestId: "abcde" })
    expect(parsePermissionVerdict("n abcde")).toEqual({ behavior: "deny", requestId: "abcde" })
  })

  test("tolerates surrounding whitespace and autocorrect caps", () => {
    expect(parsePermissionVerdict("  YES ABCDE  ")).toEqual({ behavior: "allow", requestId: "abcde" })
  })

  test("rejects ids using 'l' (outside Claude Code's id alphabet)", () => {
    expect(parsePermissionVerdict("yes ablde")).toBeNull()
  })

  test("rejects ordinary chat that isn't a verdict", () => {
    expect(parsePermissionVerdict("yes please do it")).toBeNull()
    expect(parsePermissionVerdict("approve it")).toBeNull()
    expect(parsePermissionVerdict("yes")).toBeNull()
  })
})

describe("buildInstructions", () => {
  test("always tells Claude to reply with the invocation_id", () => {
    const text = buildInstructions(false)
    expect(text).toContain("reply")
    expect(text).toContain("invocation_id")
  })

  test("documents both the send and reply tools", () => {
    const text = buildInstructions(false)
    expect(text).toContain("`send`")
    expect(text).toContain("`reply`")
    expect(text).toContain("invocation_id")
  })

  test("mentions permission forwarding only when relay is enabled", () => {
    expect(buildInstructions(true).toLowerCase()).toContain("approv")
    expect(buildInstructions(false).toLowerCase()).not.toContain("approv")
  })

  test("in plain-MCP mode says the channel is inactive instead of claiming a scratchpad link", () => {
    const text = buildInstructions(false, false)
    expect(text).not.toContain("You are linked")
    expect(text.toLowerCase()).toContain("inactive")
  })
})

function makeConfig(): RemoteSessionConfig {
  return {
    baseUrl: "https://threa.test",
    workspaceId: "ws_1",
    apiKey: "threa_bk_test",
    displayName: "Claude Code - test",
    instanceId: "cc-test",
    runtimeSessionId: "ccs-test",
    permissionRelay: false,
    pollMs: 60_000,
    idleTimeoutMs: 60_000,
    sealedFullTrace: true,
  }
}

function makeFakeTransport(): BotRuntimeTransport {
  return {
    connect: async () => {},
    disconnect: () => {},
    socketConnected: false,
    sendHello: () => {},
    recordSteps: async () => {},
    renewClaim: async () => ({ notFound: false }),
    updatePresence: async () => {},
  } as unknown as BotRuntimeTransport
}

describe("ChannelServer lifecycle gating", () => {
  test("shutdown before start never touches the Threa session", async () => {
    const config = makeConfig()
    const server = new ChannelServer(config, new ThreaClient(config), makeFakeTransport())
    const sessionShutdown = spyOn(server.session, "shutdown")
    await server.shutdown()
    expect(sessionShutdown).not.toHaveBeenCalled()
  })

  test("shutdown after start shuts the session down", async () => {
    const config = makeConfig()
    const server = new ChannelServer(config, new ThreaClient(config), makeFakeTransport())
    const sessionStart = spyOn(server.session, "start").mockResolvedValue()
    const sessionShutdown = spyOn(server.session, "shutdown").mockResolvedValue()
    await server.start()
    await server.shutdown()
    expect(sessionStart).toHaveBeenCalled()
    expect(sessionShutdown).toHaveBeenCalled()
  })
})
