import { describe, expect, test } from "bun:test"
import { output } from "./shell"
import { parseClaudeLaunch, type LocalTmuxPane } from "./discovery"
import { defaultClaudeRegistryDeps, resolveClaudeNativeSession, type ClaudeRegistryDeps } from "./claude-registry"
import { reconnectClaude, type ReconnectDeps } from "./reconnect"
import { deriveClaudeRuntimeIdentity } from "./spawners"
import type { ManagedAgent } from "./types"

const RUNTIME = "ccs-runtime"
const NATIVE = "123e4567-e89b-42d3-a456-426614174000"
const CWD = "/work/feature"
const START = "Wed Jul 22 18:13:08 2026"
const COMMAND = `env THREA_INSTANCE_ID=cc-one THREA_RUNTIME_SESSION_ID=${RUNTIME} THREA_DISPLAY_NAME=Claude THREA_COLD_START_IF_ARCHIVED=create THREA_COLD_START_IF_MISSING=replace THREA_EXPECTED_ROOT_STREAM_ID=stream_one /opt/claude --name threa.feature --mcp-config /tmp/threa.json --dangerously-load-development-channels server:threa-channel --dangerously-skip-permissions`

function pane(overrides: Partial<LocalTmuxPane> = {}): LocalTmuxPane {
  return {
    sessionName: "agents",
    windowName: "feature",
    windowId: "@7",
    paneId: "%8",
    panePid: 1234,
    cwd: CWD,
    startCommand: COMMAND,
    ...overrides,
  }
}

function registry(overrides: Record<string, unknown> = {}, exists = true): ClaudeRegistryDeps {
  const row = {
    pid: 1234,
    sessionId: NATIVE,
    cwd: CWD,
    procStart: START,
    name: "threa.feature",
    status: "idle",
    ...overrides,
  }
  return {
    home: "/home/test",
    read: () => JSON.stringify(row),
    exists: () => exists,
    canonical: (path) => path,
    processStart: () => START,
  }
}

function agent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  return {
    id: "claude-1",
    name: "feature",
    runtime: "claude",
    status: "online",
    worktree: CWD,
    tmuxPaneId: "%8",
    instanceId: "cc-one",
    runtimeSessionId: RUNTIME,
    command: [],
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  }
}

function deps(overrides: Partial<ReconnectDeps> = {}): ReconnectDeps & { calls: string[][] } {
  const calls: string[][] = []
  let paneReads = 0
  return {
    calls,
    inventory: () => [agent()],
    panes: () => (++paneReads < 3 ? [pane()] : [pane({ panePid: 5678, startCommand: "claude --resume native" })]),
    piConfig: () => ({}),
    piLink: () => undefined,
    claudeConfig: () => ({ workspaceId: "ws", apiKey: "key" }),
    claudeRegistry: {
      ...registry(),
      read: (path) =>
        JSON.stringify({
          pid: path.endsWith("5678.json") ? 5678 : 1234,
          sessionId: NATIVE,
          cwd: CWD,
          procStart: START,
          name: "threa.feature",
          status: "idle",
        }),
    },
    preflight: async () => ({ status: "linked", rootStreamId: "stream_one" }),
    mcpFile: () => true,
    respawn: (target, cwd, command) => calls.push([target, cwd, command]),
    sleep: async () => undefined,
    ...overrides,
  }
}

describe("parseClaudeLaunch", () => {
  test("accepts managed, standalone, and named global-channel forms", () => {
    expect(parseClaudeLaunch(COMMAND)).toMatchObject({
      executable: "/opt/claude",
      name: "threa.feature",
      channel: "threa-channel",
      mcpConfig: "/tmp/threa.json",
      skipPermissions: true,
    })
    expect(
      parseClaudeLaunch("claude --name threa.feature --dangerously-load-development-channels server:threa-channel")
    ).toMatchObject({
      name: "threa.feature",
      channel: "threa-channel",
      mcpConfig: undefined,
    })
  })

  test("rejects unsupported policy and shell forms", () => {
    for (const command of [
      "claude --dangerously-load-development-channels server:x --unknown",
      "claude --dangerously-load-development-channels server:x --dangerously-load-development-channels server:x",
      "env HOME=/tmp claude --dangerously-load-development-channels server:x",
      "env CLAUDE_CONFIG_DIR=/tmp claude --dangerously-load-development-channels server:x",
      "claude --mcp-config={} --dangerously-load-development-channels server:x",
      "claude --mcp-config '[]' --dangerously-load-development-channels server:x",
      "claude --mcp-config /a --mcp-config /b --dangerously-load-development-channels server:x",
      "claude prompt --dangerously-load-development-channels server:x",
      `claude --resume ${NATIVE} --dangerously-load-development-channels server:x`,
      "claude --dangerously-load-development-channels server:x -- tail",
    ])
      expect(parseClaudeLaunch(command.replace("\u0000", ""))).toBeUndefined()
  })
})

describe("resolveClaudeNativeSession", () => {
  test("default process generation uses the registry's UTC ps shape", () => {
    const expected = output(["env", "TZ=UTC", "ps", "-p", String(process.pid), "-o", "lstart="]).stdout.trim()
    expect(defaultClaudeRegistryDeps().processStart(process.pid)).toBe(expected)
  })

  test("validates exact live registry and force policy", () => {
    expect(resolveClaudeNativeSession(1234, CWD, "threa.feature", false, registry()).sessionId).toBe(NATIVE)
    expect(() => resolveClaudeNativeSession(1234, CWD, "threa.feature", false, registry({ status: "busy" }))).toThrow(
      "use --force"
    )
    expect(resolveClaudeNativeSession(1234, CWD, "threa.feature", true, registry({ status: "busy" })).status).toBe(
      "busy"
    )
  })

  test("rejects malformed identity, generation, cwd, name, and transcript", () => {
    const cases: Array<[ClaudeRegistryDeps, string]> = [
      [{ ...registry(), read: () => "{" }, "invalid Claude live registry"],
      [registry({ sessionId: "bad" }), "invalid Claude registry shape"],
      [registry({ pid: 9 }), "invalid Claude registry shape"],
      [{ ...registry(), processStart: () => "other" }, "generation"],
      [registry({ cwd: "/other" }), "cwd"],
      [registry({ name: "threa.other" }), "name"],
      [registry({}, false), "transcript"],
    ] as Array<[ClaudeRegistryDeps, string]>
    for (const [source, message] of cases) {
      expect(() => resolveClaudeNativeSession(1234, CWD, "threa.feature", false, source)).toThrow(message)
    }
  })
})

describe("reconnectClaude", () => {
  test("preflights and resumes exact native UUID with supported policy", async () => {
    const d = deps()
    await reconnectClaude({ runtimeSessionId: RUNTIME, rootStreamId: "stream_one" }, d)
    expect(d.calls).toHaveLength(1)
    expect(d.calls[0]).toEqual([
      "%8",
      CWD,
      `'env' 'THREA_DISPLAY_NAME=Claude' 'THREA_INSTANCE_ID=cc-one' 'THREA_RUNTIME_SESSION_ID=${RUNTIME}' 'THREA_COLD_START_IF_ARCHIVED=wait' 'THREA_COLD_START_IF_MISSING=error' 'THREA_EXPECTED_ROOT_STREAM_ID=stream_one' '/opt/claude' '--resume' '${NATIVE}' '--name' 'threa.feature' '--mcp-config' '/tmp/threa.json' '--dangerously-load-development-channels' 'server:threa-channel' '--dangerously-skip-permissions'`,
    ])
  })

  test("validates MCP config type, relative resolution, and pre-respawn existence", async () => {
    const checked: string[] = []
    const relative = deps({
      panes: (() => {
        let reads = 0
        return () =>
          ++reads < 3 ? [pane({ startCommand: COMMAND.replace("/tmp/threa.json", "config/mcp.json") })] : []
      })(),
      mcpFile: (path) => (checked.push(path), true),
    })
    await expect(reconnectClaude({ runtimeSessionId: RUNTIME, rootStreamId: "stream_one" }, relative)).rejects.toThrow(
      "did not verify"
    )
    expect(checked).toEqual([`${CWD}/config/mcp.json`, `${CWD}/config/mcp.json`])
    expect(relative.calls[0]?.[2]).toContain(`'--mcp-config' '${CWD}/config/mcp.json'`)

    for (const value of ["/missing.json", "/config-dir"]) {
      const invalid = deps({
        panes: () => [pane({ startCommand: COMMAND.replace("/tmp/threa.json", value) })],
        mcpFile: () => false,
      })
      await expect(reconnectClaude({ runtimeSessionId: RUNTIME, rootStreamId: "stream_one" }, invalid)).rejects.toThrow(
        "not an existing regular file"
      )
      expect(invalid.calls).toEqual([])
    }

    let checks = 0
    const disappeared = deps({ mcpFile: () => ++checks === 1 })
    await expect(
      reconnectClaude({ runtimeSessionId: RUNTIME, rootStreamId: "stream_one" }, disappeared)
    ).rejects.toThrow("changed before respawn")
    expect(disappeared.calls).toEqual([])
  })

  test("rejects a stale managed row pointing at a valid no-env Claude pane before preflight", async () => {
    const launch = "claude --name threa.feature --dangerously-load-development-channels server:threa-channel"
    let preflights = 0
    const d = deps({
      panes: () => [pane({ startCommand: launch })],
      preflight: async () => {
        preflights += 1
        return { status: "linked", rootStreamId: "stream_one" }
      },
    })
    await expect(reconnectClaude({ runtimeSessionId: RUNTIME, rootStreamId: "stream_one" }, d)).rejects.toThrow(
      "Claude runtime identity mismatch"
    )
    expect({ preflights, respawns: d.calls.length }).toEqual({ preflights: 0, respawns: 0 })
  })

  test("normalizes explicit launch identities exactly like channel discovery", async () => {
    const launch = COMMAND.replace("THREA_INSTANCE_ID=cc-one", "THREA_INSTANCE_ID=cc.one").replace(
      `THREA_RUNTIME_SESSION_ID=${RUNTIME}`,
      "THREA_RUNTIME_SESSION_ID=ccs.explicit"
    )
    const d = deps({
      inventory: () => [agent({ instanceId: "cc-one", runtimeSessionId: "ccs-explicit" })],
      panes: (() => {
        let reads = 0
        return () => (++reads < 3 ? [pane({ startCommand: launch })] : [pane({ panePid: 5678 })])
      })(),
    })
    await reconnectClaude({ runtimeSessionId: "ccs-explicit", rootStreamId: "stream_one" }, d)
    expect(d.calls[0]?.[2]).toContain("'THREA_INSTANCE_ID=cc-one' 'THREA_RUNTIME_SESSION_ID=ccs-explicit'")
  })

  test("accepts managed no-env launch when config-derived identity exactly matches the row", async () => {
    const launch = "claude --name threa.feature --dangerously-load-development-channels server:threa-channel"
    const identity = deriveClaudeRuntimeIdentity(CWD, { instanceId: "cc-derived", runtimeSessionId: "ccs-derived" })
    const d = deps({
      inventory: () => [agent({ instanceId: identity.instanceId, runtimeSessionId: identity.runtimeSessionId })],
      claudeConfig: () => ({
        workspaceId: "ws",
        apiKey: "key",
        instanceId: identity.instanceId,
        runtimeSessionId: identity.runtimeSessionId,
      }),
      panes: (() => {
        let reads = 0
        return () => (++reads < 3 ? [pane({ startCommand: launch })] : [pane({ panePid: 5678 })])
      })(),
    })
    await reconnectClaude({ runtimeSessionId: identity.runtimeSessionId, rootStreamId: "stream_one" }, d)
    expect(d.calls[0]?.[2]).toContain(`'THREA_INSTANCE_ID=${identity.instanceId}'`)
  })

  test("standalone discovery does not adopt inventory", async () => {
    let writes = 0
    const d = deps({
      inventory: () => [],
      panes: (() => {
        let reads = 0
        return () => (++reads < 4 ? [pane()] : [pane({ panePid: 5678 })])
      })(),
    })
    await reconnectClaude({ runtimeSessionId: RUNTIME, rootStreamId: "stream_one" }, d)
    expect({ writes, respawns: d.calls.length }).toEqual({ writes: 0, respawns: 1 })
  })

  test("preflight and generation races leave pane untouched", async () => {
    const failed = deps({ preflight: async () => ({ status: "archived", reason: "archived" }) })
    await expect(reconnectClaude({ runtimeSessionId: RUNTIME, rootStreamId: "stream_one" }, failed)).rejects.toThrow(
      "preflight failed"
    )
    expect(failed.calls).toEqual([])

    let reads = 0
    const raced = deps({ panes: () => (++reads === 1 ? [pane()] : [pane({ panePid: 9 })]) })
    await expect(reconnectClaude({ runtimeSessionId: RUNTIME, rootStreamId: "stream_one" }, raced)).rejects.toThrow(
      "changed during reconnect"
    )
    expect(raced.calls).toEqual([])
  })

  test("post-respawn verification requires same UUID and never fresh-falls back", async () => {
    const d = deps({
      claudeRegistry: {
        ...registry(),
        read: (path) =>
          JSON.stringify({
            pid: path.endsWith("5678.json") ? 5678 : 1234,
            sessionId: path.endsWith("5678.json") ? "223e4567-e89b-42d3-a456-426614174000" : NATIVE,
            cwd: CWD,
            procStart: START,
            name: "threa.feature",
            status: "idle",
          }),
      },
    })
    await expect(reconnectClaude({ runtimeSessionId: RUNTIME, rootStreamId: "stream_one" }, d)).rejects.toThrow(
      "did not verify"
    )
    expect(d.calls).toHaveLength(1)
  })
})
