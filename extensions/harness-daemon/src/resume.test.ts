import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { latestAgents, parseScratchpadUrl, recordedNoYolo } from "./resume"
import { launchAgentPlist } from "./boot"
import { claudeLaunchArgs, ensureChannelServerKeyEnv } from "./spawners"
import type { ManagedAgent } from "./types"

function agent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  return {
    id: "claude-1",
    name: "repair",
    runtime: "claude",
    status: "online",
    command: ["threa-harnessd", "spawn", "claude"],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  }
}

test("parses a stream id from a scratchpad URL", () => {
  expect(parseScratchpadUrl("https://app.threa.io/w/ws_01WORKSPACE/s/stream_01ABCDEF?view=chat")).toEqual({
    baseUrl: "https://app.threa.io",
    workspaceId: "ws_01WORKSPACE",
    streamId: "stream_01ABCDEF",
  })
  expect(parseScratchpadUrl("not-a-url")).toBeUndefined()
})

test("selects only the latest inventory row for an agent name", () => {
  const newest = agent({ id: "claude-2", updatedAt: "2026-07-02T00:00:00.000Z" })
  expect(latestAgents([agent(), newest, agent({ name: "other" })])).toEqual([agent({ name: "other" }), newest])
})

test("preserves an explicitly non-yolo launch", () => {
  expect(recordedNoYolo(agent())).toBeFalse()
  expect(recordedNoYolo(agent({ command: ["threa-harnessd", "spawn", "claude", "--no-yolo"] }))).toBeTrue()
})

test("writes a login LaunchAgent that runs boot-resume in a dedicated tmux session", () => {
  const plist = launchAgentPlist({
    bun: "/Users/me/.bun/bin/bun",
    entrypoint: "/repo/extensions/harness-daemon/src/index.ts",
    tmux: "threa-agents",
    logDir: "/Users/me/.threa/harnessd/log",
    path: "/Users/me/.bun/bin:/usr/bin:/bin",
    environment: { THREA_API_KEY: "secret" },
  })
  expect(plist).toContain("<key>RunAtLoad</key><true/>")
  expect(plist).toContain("boot-resume --tmux 'threa-agents'")
  expect(plist).toContain("resume-active.error.log")
  expect(plist).toContain("<key>PATH</key><string>/Users/me/.bun/bin:/usr/bin:/bin</string>")
  expect(plist).toContain("<key>THREA_API_KEY</key><string>secret</string>")
})

test("injects the registration-carried server key into a legacy MCP config", () => {
  const path = join(mkdtempSync(join(tmpdir(), "harnessd-mcp-")), "agent.json")
  writeFileSync(
    path,
    JSON.stringify({ mcpServers: { "threa-channel": { type: "stdio", command: "bun", args: ["/x/index.ts"] } } })
  )
  ensureChannelServerKeyEnv(path, "threa-channel")
  expect(JSON.parse(readFileSync(path, "utf8")).mcpServers["threa-channel"].env).toEqual({
    THREA_CHANNEL_SERVER_KEY: "threa-channel",
  })
})

test("leaves an already-keyed MCP config untouched", () => {
  const path = join(mkdtempSync(join(tmpdir(), "harnessd-mcp-")), "agent.json")
  const config = {
    mcpServers: {
      threa: { type: "stdio", command: "bun", args: ["/x/index.ts"], env: { THREA_CHANNEL_SERVER_KEY: "threa" } },
    },
  }
  writeFileSync(path, JSON.stringify(config))
  ensureChannelServerKeyEnv(path, "threa")
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(config)
})

test("reconstructs the Claude channel launch with the recorded permission mode", () => {
  const args = claudeLaunchArgs({
    claudeBin: "claude",
    name: "repair",
    channel: "threa",
    mcpConfig: "/tmp/repair.json",
  })
  expect(args).toEqual([
    "claude",
    "--name",
    "threa.repair",
    "--mcp-config",
    "/tmp/repair.json",
    "--dangerously-load-development-channels",
    "server:threa",
    "--dangerously-skip-permissions",
  ])
  expect(claudeLaunchArgs({ claudeBin: "claude", name: "repair", channel: "threa", noYolo: true })).not.toContain(
    "--dangerously-skip-permissions"
  )
})
