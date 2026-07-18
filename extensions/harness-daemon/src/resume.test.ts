import { Database } from "bun:sqlite"
import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  fetchScratchpadStatus,
  latestAgents,
  parseScratchpadUrl,
  preflightRuntimeSession,
  recordedNoYolo,
} from "./resume"
import { launchAgentPlist } from "./boot"
import { parseSpawn } from "./cli"
import { readInventory, upsertAgent } from "./inventory"
import { claudeLaunchArgs, claudeLaunchCommand, normalizeChannelMcpConfig, piLaunchArgs } from "./spawners"
import type { ManagedAgent } from "./types"

afterEach(() => mock.restore())

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

test("migrates legacy inventory and persists runtime identity", () => {
  const previousPath = process.env.THREA_HARNESSD_INVENTORY
  const path = join(mkdtempSync(join(tmpdir(), "harnessd-inventory-")), "inventory.sqlite")
  const db = new Database(path)
  db.exec(`
    CREATE TABLE managed_agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, runtime TEXT NOT NULL, status TEXT NOT NULL,
      worktree TEXT, branch TEXT, tmux_session TEXT, tmux_window TEXT, scratchpad_url TEXT,
      command_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_output TEXT,
      tmux_window_id TEXT
    )
  `)
  db.close()
  process.env.THREA_HARNESSD_INVENTORY = path
  try {
    const managed = agent({ instanceId: "cc-one", runtimeSessionId: "ccs-one" })
    upsertAgent(managed)
    expect(readInventory()).toEqual([managed])
  } finally {
    if (previousPath === undefined) delete process.env.THREA_HARNESSD_INVENTORY
    else process.env.THREA_HARNESSD_INVENTORY = previousPath
  }
})

test("records an absolute source repo for worktree restoration", () => {
  expect(parseSpawn(["claude", "--name", "repair", "--repo", "."]).repo).toBe(process.cwd())
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

test("migrates a legacy MCP registration to the current channel name and gate", () => {
  const path = join(mkdtempSync(join(tmpdir(), "harnessd-mcp-")), "agent.json")
  writeFileSync(
    path,
    JSON.stringify({ mcpServers: { threa: { type: "stdio", command: "bun", args: ["/x/index.ts"] } } })
  )
  normalizeChannelMcpConfig(path, "threa-channel", "/current/index.ts")
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    mcpServers: {
      "threa-channel": {
        type: "stdio",
        command: "bun",
        args: ["/current/index.ts"],
        env: { THREA_CHANNEL_SERVER_KEY: "threa-channel" },
      },
    },
  })
})

test("reconstructs the current Claude channel launch with stable runtime identity", () => {
  const args = claudeLaunchArgs({
    claudeBin: "claude",
    name: "repair",
    channel: "threa-channel",
    mcpConfig: "/tmp/repair.json",
  })
  expect(args).toEqual([
    "claude",
    "--name",
    "threa.repair",
    "--mcp-config",
    "/tmp/repair.json",
    "--dangerously-load-development-channels",
    "server:threa-channel",
    "--dangerously-skip-permissions",
  ])
  const command = claudeLaunchCommand(args, { instanceId: "cc-one", runtimeSessionId: "ccs-one" }, {}, "wait")
  expect(command).toContain("'THREA_INSTANCE_ID=cc-one'")
  expect(command).toContain("'THREA_RUNTIME_SESSION_ID=ccs-one'")
  expect(command).toContain("'THREA_DEFAULT_LABEL=coding'")
  expect(command).toContain("'THREA_COLD_START_IF_ARCHIVED=wait'")
  expect(
    claudeLaunchArgs({ claudeBin: "claude", name: "repair", channel: "threa-channel", noYolo: true })
  ).not.toContain("--dangerously-skip-permissions")
})

test("Pi revival reuses an exact recorded session id", () => {
  expect(piLaunchArgs("pi", "019f-session")).toEqual(["pi", "--session-id", "019f-session"])
})

test("classifies active, archived, and inaccessible scratchpads", async () => {
  const fetchMock = spyOn(globalThis, "fetch")
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: "stream_1" } }), { status: 200 }))
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ data: { id: "stream_1", archivedAt: "2026-07-01T00:00:00.000Z" } }), {
      status: 200,
    })
  )
  fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }))
  const params = { baseUrl: "https://app.threa.io", workspaceId: "ws_1", apiKey: "key", streamId: "stream_1" }
  expect(await fetchScratchpadStatus(params)).toBe("active")
  expect(await fetchScratchpadStatus(params)).toBe("archived")
  expect(await fetchScratchpadStatus(params)).toBe("inaccessible")
})

test("preflights revival with ifArchived=wait and refuses a root mismatch", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ data: { rootStreamId: "stream_other" } }), { status: 200 })
  )
  const result = await preflightRuntimeSession({
    baseUrl: "https://app.threa.io",
    workspaceId: "ws_1",
    apiKey: "key",
    runtimeKind: "claude-code-channel",
    instanceId: "cc-one",
    runtimeSessionId: "ccs-one",
    displayName: "Claude Code - repair",
    localCwd: "/repo/repair",
    expectedRootStreamId: "stream_expected",
  })
  expect(result).toEqual({
    status: "mismatch",
    rootStreamId: "stream_other",
    expectedRootStreamId: "stream_expected",
  })
  const request = fetchMock.mock.calls[0]?.[1] as RequestInit
  expect(JSON.parse(String(request.body))).toMatchObject({
    runtimeKind: "claude-code-channel",
    instanceId: "cc-one",
    runtimeSessionId: "ccs-one",
    ifArchived: "wait",
  })
  expect(String(request.body)).not.toContain("replace")
})
