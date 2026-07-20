import { Database } from "bun:sqlite"
import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  fetchScratchpadStatus,
  latestAgents,
  parseScratchpadUrl,
  preflightRuntimeSession,
  probeSuppressed,
  recordedNoYolo,
} from "./resume"
import { launchAgentPlist } from "./boot"
import { parseResume, parseSpawn } from "./cli"
import { restoredSessionMatches, reviveAgent, type ReviveDeps, type ReviveOutcome } from "./commands"
import { readInventory, upsertAgent } from "./inventory"
import { acquireProcessLock } from "./lock"
import {
  claudeLaunchArgs,
  claudeLaunchCommand,
  normalizeChannelMcpConfig,
  piLaunchArgs,
  piResumeCommand,
} from "./spawners"
import type { ManagedAgent, ResumeOptions } from "./types"
import {
  inaccessibleBackoffMs,
  runWatchLoop,
  unavailableBackoffMs,
  uniqueSupervisorTargets,
  watchIntervalMs,
} from "./watch"

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
    const managed = agent({
      instanceId: "cc-one",
      runtimeSessionId: "ccs-one",
      probeFailures: 3,
      probeBackoffUntil: "2026-07-20T12:00:00.000Z",
    })
    upsertAgent(managed)
    expect(readInventory()).toEqual([managed])
    const cleared = { ...managed, probeFailures: undefined, probeBackoffUntil: undefined }
    upsertAgent(cleared)
    expect(readInventory()).toEqual([cleared])
  } finally {
    if (previousPath === undefined) delete process.env.THREA_HARNESSD_INVENTORY
    else process.env.THREA_HARNESSD_INVENTORY = previousPath
  }
})

test("records an absolute source repo for worktree restoration", () => {
  expect(parseSpawn(["claude", "--name", "repair", "--repo", "."]).repo).toBe(process.cwd())
})

test("rejects the removed unsafe force option", () => {
  for (const args of [["--force"], ["--force", "true"], ["--force=true"]]) {
    expect(() => parseResume(args)).toThrow("revival never launches archived or inaccessible scratchpads")
  }
})

test("preserves an explicitly non-yolo launch", () => {
  expect(recordedNoYolo(agent())).toBeFalse()
  expect(recordedNoYolo(agent({ command: ["threa-harnessd", "spawn", "claude", "--no-yolo"] }))).toBeTrue()
})

test("writes a persistent login watcher in a dedicated tmux session", () => {
  const plist = launchAgentPlist({
    bun: "/Users/me/.bun/bin/bun",
    entrypoint: "/repo/extensions/harness-daemon/src/index.ts",
    tmux: "threa-agents",
    logDir: "/Users/me/.threa/harnessd/log",
    path: "/Users/me/.bun/bin:/usr/bin:/bin",
    environment: { THREA_API_KEY: "secret" },
  })
  expect(plist).toContain("<key>RunAtLoad</key><true/>")
  expect(plist).toContain("<key>KeepAlive</key><true/>")
  expect(plist).toContain("watch-unarchived --tmux 'threa-agents'")
  expect(plist).toContain("resume-active.error.log")
  expect(plist).toContain("<key>PATH</key><string>/Users/me/.bun/bin:/usr/bin:/bin</string>")
  expect(plist).toContain("<key>THREA_API_KEY</key><string>secret</string>")
})

test("watch loop keeps reconciling after a failed pass", async () => {
  let passes = 0
  const sleeps: number[] = []
  const errors: unknown[] = []
  await runWatchLoop({
    runPass: async () => {
      passes += 1
      if (passes === 1) throw new Error("offline")
      if (passes === 2) return 24_000
    },
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    intervalMs: 12_000,
    onError: (error) => errors.push(error),
    maxPasses: 3,
  })
  expect({ passes, sleeps, error: String(errors[0]) }).toEqual({
    passes: 3,
    sleeps: [12_000, 24_000],
    error: "Error: offline",
  })
})

test("restore events require an exact root and runtime identity match", () => {
  const target = {
    botId: "bot_1",
    rootStreamId: "stream_1",
    instanceId: "inst_1",
    runtimeSessionId: "session_1",
  }
  expect(restoredSessionMatches({ ...target }, target)).toBe(true)
  expect(restoredSessionMatches({ ...target, instanceId: "inst_2" }, target)).toBe(false)
  expect(restoredSessionMatches({ ...target, runtimeSessionId: "session_2" }, target)).toBe(false)
  expect(restoredSessionMatches({ ...target, rootStreamId: "stream_2" }, target)).toBe(false)
})

test("supervisor targets dedupe shared bot credentials", () => {
  const target = { baseUrl: "https://app.threa.io", workspaceId: "ws_1", apiKey: "key_1" }
  expect(uniqueSupervisorTargets([target, { ...target }, undefined])).toEqual([target])
})

test("socket retry interval is bounded and unavailable catch-up backs off with jitter", () => {
  expect(watchIntervalMs("")).toBe(60_000)
  expect(watchIntervalMs("15000")).toBe(15_000)
  expect(() => watchIntervalMs("9999")).toThrow("must be at least 10000")
  expect(unavailableBackoffMs(60_000, 1, () => 0)).toBe(120_000)
  expect(unavailableBackoffMs(60_000, 2, () => 0.5)).toBe(252_000)
  expect(unavailableBackoffMs(60_000, 10, () => 1)).toBe(900_000)
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
  const command = claudeLaunchCommand(
    args,
    { instanceId: "cc-one", runtimeSessionId: "ccs-one" },
    {},
    "wait",
    "error",
    "stream_expected"
  )
  expect(command).toContain("'THREA_INSTANCE_ID=cc-one'")
  expect(command).toContain("'THREA_RUNTIME_SESSION_ID=ccs-one'")
  expect(command).toContain("'THREA_DEFAULT_LABEL=coding'")
  expect(command).toContain("'THREA_COLD_START_IF_ARCHIVED=wait'")
  expect(command).toContain("'THREA_COLD_START_IF_MISSING=error'")
  expect(command).toContain("'THREA_EXPECTED_ROOT_STREAM_ID=stream_expected'")
  expect(
    claudeLaunchArgs({ claudeBin: "claude", name: "repair", channel: "threa-channel", noYolo: true })
  ).not.toContain("--dangerously-skip-permissions")
})

test("Pi revival reuses an exact recorded session id bound to the expected root", () => {
  expect(piLaunchArgs("pi", "019f-session")).toEqual(["pi", "--session-id", "019f-session"])
  expect(piResumeCommand("pi", "019f-session", "stream_expected")).toContain(
    "'THREA_EXPECTED_ROOT_STREAM_ID=stream_expected'"
  )
})

test("classifies active, archived, inaccessible, and unavailable scratchpads", async () => {
  const fetchMock = spyOn(globalThis, "fetch")
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: "stream_1" } }), { status: 200 }))
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ data: { id: "stream_1", archivedAt: "2026-07-01T00:00:00.000Z" } }), {
      status: 200,
    })
  )
  fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }))
  fetchMock.mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
  const params = { baseUrl: "https://app.threa.io", workspaceId: "ws_1", apiKey: "key", streamId: "stream_1" }
  expect(await fetchScratchpadStatus(params)).toBe("active")
  expect(await fetchScratchpadStatus(params)).toBe("archived")
  expect(await fetchScratchpadStatus(params)).toBe("inaccessible")
  expect(await fetchScratchpadStatus(params)).toBe("unavailable")
})

test("scratchpad status rides out rate limiting but gives up after repeated 429s", async () => {
  const fetchMock = spyOn(globalThis, "fetch")
  fetchMock.mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "7" } }))
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: "stream_1" } }), { status: 200 }))
  fetchMock.mockResolvedValue(new Response("slow down", { status: 429 }))
  const params = { baseUrl: "https://app.threa.io", workspaceId: "ws_1", apiKey: "key", streamId: "stream_1" }
  const sleeps: number[] = []
  const sleep = async (ms: number) => {
    sleeps.push(ms)
  }
  expect(await fetchScratchpadStatus(params, sleep)).toBe("active")
  expect(await fetchScratchpadStatus(params, sleep)).toBe("unavailable")
  expect(sleeps).toEqual([7_000, 2_000, 4_000])
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
    ifMissing: "error",
  })
  expect(String(request.body)).not.toContain("replace")
})

test("preflight refuses to create a scratchpad for a missing runtime link", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ code: "RUNTIME_SESSION_NOT_FOUND" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    })
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
  expect(result).toEqual({ status: "inaccessible", reason: "RUNTIME_SESSION_NOT_FOUND" })
})

const REVIVE_ENV_KEYS = [
  "THREA_BASE_URL",
  "THREA_WORKSPACE_ID",
  "THREA_API_KEY",
  "THREA_DISPLAY_NAME",
  "THREA_DEFAULT_LABEL",
  "THREA_INSTANCE_ID",
  "THREA_RUNTIME_SESSION_ID",
  "THREA_HARNESSD_WATCH_INTERVAL_MS",
] as const

function reviveDeps(overrides: Partial<ReviveDeps> = {}): ReviveDeps {
  return {
    claudeConfig: { workspaceId: "ws_1", apiKey: "key" },
    piConfig: { workspaceId: "ws_1", apiKey: "key" },
    windowExists: () => false,
    pathExists: () => true,
    scratchpadStatus: async () => "active",
    preflight: async () => ({ status: "linked", rootStreamId: "stream_01ABCDEF" }),
    restoreWorktree: () => {
      throw new Error("restoreWorktree must not be called")
    },
    restorableWorktree: () => ({ repo: "/tmp/repo" }),
    piLink: () => undefined,
    resumeRuntime: async () => {
      throw new Error("resumeRuntime must not be called")
    },
    persist: () => {},
    killWindow: () => {
      throw new Error("killWindow must not be called")
    },
    ...overrides,
  }
}

function linkedAgent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  return agent({
    scratchpadUrl: "https://app.threa.io/w/ws_1/s/stream_01ABCDEF",
    worktree: "/tmp/worktrees/repair",
    instanceId: "cc-one",
    runtimeSessionId: "ccs-one",
    ...overrides,
  })
}

async function runRevive(
  managed: ManagedAgent,
  options: ResumeOptions,
  deps: ReviveDeps,
  target?: Parameters<typeof reviveAgent>[3]
): Promise<ReviveOutcome | undefined> {
  const saved = REVIVE_ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of REVIVE_ENV_KEYS) delete process.env[key]
  try {
    return await reviveAgent(managed, options, deps, target)
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test("up skips archived and inaccessible scratchpads without launching", async () => {
  expect(await runRevive(linkedAgent(), {}, reviveDeps({ scratchpadStatus: async () => "archived" }))).toEqual({
    status: "skipped archived",
  })
  const inaccessible = await runRevive(linkedAgent(), {}, reviveDeps({ scratchpadStatus: async () => "inaccessible" }))
  expect(inaccessible?.status).toBe("skipped inaccessible")
})

test("an inaccessible scratchpad records an escalating probe backoff", async () => {
  const persisted: ManagedAgent[] = []
  const deps = reviveDeps({
    scratchpadStatus: async () => "inaccessible",
    persist: (managed) => persisted.push(managed),
  })
  await runRevive(linkedAgent(), {}, deps)
  await runRevive(linkedAgent({ probeFailures: 4 }), {}, deps)

  expect(persisted.map((managed) => managed.probeFailures)).toEqual([1, 5])
  const [first, fifth] = persisted.map((managed) => Date.parse(managed.probeBackoffUntil!) - Date.now())
  expect(first).toBeGreaterThan(60_000)
  expect(fifth).toBeGreaterThan(first)
})

test("the watcher sweep does not re-probe a scratchpad inside its backoff window", async () => {
  const probes: string[] = []
  const deps = reviveDeps({
    scratchpadStatus: async () => {
      probes.push("status")
      return "inaccessible"
    },
  })
  const backedOff = linkedAgent({ probeFailures: 3, probeBackoffUntil: new Date(Date.now() + 3_600_000).toISOString() })

  expect(await runRevive(backedOff, { respectProbeBackoff: true }, deps)).toEqual({
    status: "skipped inaccessible",
    detail: `probe suppressed until ${backedOff.probeBackoffUntil}`,
  })
  expect(probes).toEqual([])
})

test("an explicit CLI run and a targeted restore event both probe through the backoff (#1440)", async () => {
  const probes: string[] = []
  const deps = reviveDeps({
    scratchpadStatus: async () => {
      probes.push("status")
      return "inaccessible"
    },
  })
  const backedOff = linkedAgent({ probeFailures: 3, probeBackoffUntil: new Date(Date.now() + 3_600_000).toISOString() })
  const target = { botId: "bot_1", rootStreamId: "stream_01ABCDEF", instanceId: "cc-one", runtimeSessionId: "ccs-one" }

  await runRevive(backedOff, {}, deps)
  await runRevive(backedOff, { respectProbeBackoff: true }, deps, target)
  expect(probes).toEqual(["status", "status"])
})

test("unarchiving revives immediately even when the row carries a probe backoff", async () => {
  const probes: string[] = []
  const deps = reviveDeps({
    scratchpadStatus: async () => {
      probes.push("status")
      return "active"
    },
  })
  const target = { botId: "bot_1", rootStreamId: "stream_01ABCDEF", instanceId: "cc-one", runtimeSessionId: "ccs-one" }
  const backedOff = linkedAgent({
    probeFailures: 9,
    probeBackoffUntil: new Date(Date.now() + 6 * 3_600_000).toISOString(),
  })

  expect(await runRevive(backedOff, { dryRun: true, respectProbeBackoff: true }, deps, target)).toEqual({
    status: "would start",
    detail: "https://app.threa.io/w/ws_1/s/stream_01ABCDEF",
  })
  expect(probes).toEqual(["status"])
})

test("an archived scratchpad answers 200, so it never enters the backoff", async () => {
  const persisted: ManagedAgent[] = []
  const deps = reviveDeps({ scratchpadStatus: async () => "archived", persist: (managed) => persisted.push(managed) })
  const probes: string[] = []
  const counting = reviveDeps({
    ...deps,
    scratchpadStatus: async () => {
      probes.push("status")
      return "archived"
    },
  })

  expect(await runRevive(linkedAgent(), { respectProbeBackoff: true }, counting)).toEqual({
    status: "skipped archived",
  })
  expect(await runRevive(linkedAgent(), { respectProbeBackoff: true }, counting)).toEqual({
    status: "skipped archived",
  })
  expect(probes).toEqual(["status", "status"])
  expect(persisted).toEqual([])
})

test("a scratchpad that answers clears its recorded backoff", async () => {
  for (const status of ["active", "archived"] as const) {
    const persisted: ManagedAgent[] = []
    // pathExists stops an "active" row right after the clear, before any launch.
    const deps = reviveDeps({
      scratchpadStatus: async () => status,
      persist: (managed) => persisted.push(managed),
      pathExists: () => false,
    })
    const backedOff = linkedAgent({ probeFailures: 3, probeBackoffUntil: "2026-07-20T00:00:00.000Z" })
    await runRevive(backedOff, { dryRun: true }, deps)
    await runRevive(backedOff, {}, deps)

    expect(persisted).toEqual([
      { ...backedOff, probeFailures: undefined, probeBackoffUntil: undefined, updatedAt: persisted[0]?.updatedAt },
    ])
    expect(Date.parse(persisted[0]!.updatedAt)).toBeGreaterThan(Date.parse(backedOff.updatedAt))
  }
})

test("an unavailable Threa neither records nor clears a probe backoff", async () => {
  const persisted: ManagedAgent[] = []
  const deps = reviveDeps({
    scratchpadStatus: async () => "unavailable",
    persist: (managed) => persisted.push(managed),
  })
  expect(await runRevive(linkedAgent({ probeFailures: 3 }), {}, deps)).toEqual({ status: "skipped unavailable" })
  expect(persisted).toEqual([])
})

test("probe suppression reads a missing or unparseable instant as due", () => {
  const nowMs = Date.parse("2026-07-20T12:00:00.000Z")
  expect(probeSuppressed(agent(), nowMs)).toBeFalse()
  expect(probeSuppressed(agent({ probeBackoffUntil: "not-a-date" }), nowMs)).toBeFalse()
  expect(probeSuppressed(agent({ probeBackoffUntil: "2026-07-20T11:00:00.000Z" }), nowMs)).toBeFalse()
  expect(probeSuppressed(agent({ probeBackoffUntil: "2026-07-20T13:00:00.000Z" }), nowMs)).toBeTrue()
})

test("inaccessible probes back off for hours where unavailable ones cap at minutes", () => {
  expect(inaccessibleBackoffMs(60_000, 1, () => 0)).toBe(120_000)
  expect(inaccessibleBackoffMs(60_000, 99, () => 0)).toBe(6 * 60 * 60_000)
  expect(unavailableBackoffMs(60_000, 99, () => 0)).toBe(15 * 60_000)
})

test("up skips an already-running agent before touching the network", async () => {
  const calls: string[] = []
  const deps = reviveDeps({
    windowExists: () => true,
    scratchpadStatus: async () => {
      calls.push("status")
      return "active"
    },
  })
  expect(await runRevive(linkedAgent(), {}, deps)).toEqual({ status: "already running" })
  expect(calls).toEqual([])
})

test("up skips an active scratchpad whose worktree is missing unless --recreate-worktree", async () => {
  expect(await runRevive(linkedAgent(), {}, reviveDeps({ pathExists: () => false }))).toEqual({
    status: "skipped missing cwd",
    detail: "/tmp/worktrees/repair",
  })
  expect(
    await runRevive(linkedAgent(), { dryRun: true, recreateWorktree: true }, reviveDeps({ pathExists: () => false }))
  ).toEqual({
    status: "would start",
    detail: "https://app.threa.io/w/ws_1/s/stream_01ABCDEF (recreates worktree)",
  })
})

test("dry-run with --recreate-worktree still skips an unrestorable worktree", async () => {
  const deps = reviveDeps({
    pathExists: () => false,
    restorableWorktree: () => ({ reason: "no branch recorded" }),
  })
  expect(await runRevive(linkedAgent(), { dryRun: true, recreateWorktree: true }, deps)).toEqual({
    status: "skipped missing cwd",
    detail: "no branch recorded",
  })
})

test("targeted restore events only start the matching inventory row", async () => {
  const target = { botId: "bot_1", rootStreamId: "stream_01ABCDEF", instanceId: "cc-one", runtimeSessionId: "ccs-one" }
  expect(
    await runRevive(linkedAgent(), { dryRun: true }, reviveDeps(), { ...target, rootStreamId: "stream_other" })
  ).toBeUndefined()
  expect(await runRevive(linkedAgent({ instanceId: "cc-two" }), { dryRun: true }, reviveDeps(), target)).toEqual({
    status: "skipped identity mismatch",
    detail: "restore event identity does not match inventory",
  })
  expect(await runRevive(linkedAgent(), { dryRun: true }, reviveDeps(), target)).toEqual({
    status: "would start",
    detail: "https://app.threa.io/w/ws_1/s/stream_01ABCDEF",
  })
})

test("up refuses a preflight root stream mismatch", async () => {
  const deps = reviveDeps({
    preflight: async () => ({
      status: "mismatch",
      rootStreamId: "stream_other",
      expectedRootStreamId: "stream_01ABCDEF",
    }),
  })
  expect(await runRevive(linkedAgent(), {}, deps)).toEqual({
    status: "skipped identity mismatch",
    detail: "session link root mismatch: expected stream_01ABCDEF, got stream_other",
  })
})

test("up skips a Pi agent with no recorded session id", async () => {
  const pi = linkedAgent({ runtime: "pi", instanceId: undefined, runtimeSessionId: undefined })
  expect(await runRevive(pi, {}, reviveDeps())).toEqual({
    status: "skipped missing session id",
    detail: "original Pi --session-id is not recorded",
  })
})

test("dry-run reports the plan without preflighting, launching, or persisting", async () => {
  const calls: string[] = []
  const deps = reviveDeps({
    preflight: async () => {
      calls.push("preflight")
      return { status: "linked", rootStreamId: "stream_01ABCDEF" }
    },
    resumeRuntime: async () => {
      calls.push("resume")
      throw new Error("unreachable")
    },
    persist: () => {
      calls.push("persist")
    },
  })
  expect(await runRevive(linkedAgent(), { dryRun: true }, deps)).toEqual({
    status: "would start",
    detail: "https://app.threa.io/w/ws_1/s/stream_01ABCDEF",
  })
  expect(calls).toEqual([])
})

test("up starts an eligible agent and records it online", async () => {
  const persisted: ManagedAgent[] = []
  const deps = reviveDeps({
    resumeRuntime: async (managed) => ({
      worktree: managed.worktree!,
      branch: managed.branch ?? managed.name,
      tmuxSession: "threa-agents",
      tmuxWindow: "repair",
      tmuxWindowId: "@7",
      scratchpadUrl: managed.scratchpadUrl,
      instanceId: managed.instanceId,
      runtimeSessionId: managed.runtimeSessionId,
      output: "ok",
    }),
    persist: (managed) => {
      persisted.push(managed)
    },
  })
  expect(await runRevive(linkedAgent(), {}, deps)).toEqual({ status: "started", detail: "bypass enabled" })
  expect(persisted).toEqual([
    expect.objectContaining({
      status: "online",
      tmuxWindowId: "@7",
      instanceId: "cc-one",
      runtimeSessionId: "ccs-one",
    }),
  ])
})

test("up accepts --recreate-worktree and --dry-run", () => {
  expect(parseResume(["--dry-run", "--recreate-worktree"])).toEqual({
    tmux: undefined,
    dryRun: true,
    recreateWorktree: true,
  })
})

test("a scratchpad archived during launch is killed, not recorded online", async () => {
  let statusCalls = 0
  const killed: string[] = []
  const persisted: ManagedAgent[] = []
  const deps = reviveDeps({
    scratchpadStatus: async () => (++statusCalls === 1 ? "active" : "archived"),
    resumeRuntime: async (managed) => ({
      worktree: managed.worktree!,
      branch: managed.branch ?? managed.name,
      tmuxSession: "threa-agents",
      tmuxWindow: "repair",
      tmuxWindowId: "@7",
      scratchpadUrl: managed.scratchpadUrl,
      instanceId: managed.instanceId,
      runtimeSessionId: managed.runtimeSessionId,
      output: "ok",
    }),
    persist: (managed) => {
      persisted.push(managed)
    },
    killWindow: (windowId) => {
      killed.push(windowId)
    },
  })
  expect(await runRevive(linkedAgent(), {}, deps)).toEqual({
    status: "skipped archived",
    detail: "scratchpad state changed during launch; window killed",
  })
  expect({ killed, persisted: persisted.map((entry) => entry.status) }).toEqual({
    killed: ["@7"],
    persisted: ["error"],
  })
})

test("a persist failure after launch kills the window instead of leaving it untracked", async () => {
  const killed: string[] = []
  const deps = reviveDeps({
    resumeRuntime: async (managed) => ({
      worktree: managed.worktree!,
      branch: managed.branch ?? managed.name,
      tmuxSession: "threa-agents",
      tmuxWindow: "repair",
      tmuxWindowId: "@7",
      scratchpadUrl: managed.scratchpadUrl,
      instanceId: managed.instanceId,
      runtimeSessionId: managed.runtimeSessionId,
      output: "ok",
    }),
    persist: () => {
      throw new Error("SQLITE_BUSY")
    },
    killWindow: (windowId) => {
      killed.push(windowId)
    },
  })
  expect(await runRevive(linkedAgent(), {}, deps)).toEqual({
    status: "failed",
    detail: "inventory write failed after launch; window killed: SQLITE_BUSY",
  })
  expect(killed).toEqual(["@7"])
})

test("process lock steals from a dead holder, times out on a live one, and releases only its own", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "harnessd-lock-")), "resume-active.lock")
  writeFileSync(path, "11111")
  const release = await acquireProcessLock(path, { pid: 22222, isAlive: () => false, sleep: async () => {} })
  expect(readFileSync(path, "utf8")).toBe("22222")
  expect(
    acquireProcessLock(path, { pid: 33333, isAlive: () => true, sleep: async () => {}, timeoutMs: 0 })
  ).rejects.toThrow("held by pid 22222")
  writeFileSync(path, "44444")
  release()
  expect(readFileSync(path, "utf8")).toBe("44444")
})

test("reading a missing inventory creates nothing on disk", () => {
  const previousPath = process.env.THREA_HARNESSD_INVENTORY
  const dir = join(mkdtempSync(join(tmpdir(), "harnessd-fresh-")), "nested")
  const path = join(dir, "inventory.sqlite")
  process.env.THREA_HARNESSD_INVENTORY = path
  try {
    expect(readInventory()).toEqual([])
    expect({ file: existsSync(path), dir: existsSync(dir) }).toEqual({ file: false, dir: false })
  } finally {
    if (previousPath === undefined) delete process.env.THREA_HARNESSD_INVENTORY
    else process.env.THREA_HARNESSD_INVENTORY = previousPath
  }
})
