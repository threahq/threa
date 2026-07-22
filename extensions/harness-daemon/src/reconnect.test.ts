import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseReconnect } from "./cli"
import { findLocalPiPane, parsePiLaunch, type LocalTmuxPane } from "./discovery"
import { reconnectPi, type ReconnectDeps } from "./reconnect"
import { readInventoryReadonly } from "./inventory"
import type { ManagedAgent } from "./types"

const SESSION = "123e4567-e89b-42d3-a456-426614174000"

function pane(overrides: Partial<LocalTmuxPane> = {}): LocalTmuxPane {
  return {
    sessionName: "agents",
    windowName: "feature",
    windowId: "@7",
    paneId: "%8",
    panePid: 1234,
    cwd: "/work/feature",
    startCommand: `env THREA_HARNESSD_ENTRYPOINT=/h/index.ts THREA_HARNESSD_BUN_BIN=/bin/bun THREA_INSTANCE_ID=pi-one THREA_RUNTIME_SESSION_ID=${SESSION} /opt/bin/pi --session-id ${SESSION}`,
    ...overrides,
  }
}

function agent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  return {
    id: "pi-1",
    name: "feature",
    runtime: "pi",
    status: "online",
    tmuxPaneId: "%8",
    instanceId: "pi-one",
    runtimeSessionId: SESSION,
    command: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

function deps(overrides: Partial<ReconnectDeps> = {}): ReconnectDeps & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    inventory: () => [agent()],
    panes: () => [pane()],
    piConfig: () => ({ baseUrl: "https://app.threa.io", workspaceId: "ws_one", apiKey: "key" }),
    piLink: () => ({ instanceId: "pi-one", rootStreamId: "stream_one", scratchpadUrl: "unused" }),
    preflight: async () => ({ status: "linked", rootStreamId: "stream_one" }),
    respawn: (target, cwd, command) => calls.push([target, cwd, command]),
    ...overrides,
  }
}

describe("parsePiLaunch", () => {
  test("accepts exact standalone and managed launch forms", () => {
    expect(parsePiLaunch(`/usr/local/bin/pi --session-id ${SESSION}`)).toEqual({
      executable: "/usr/local/bin/pi",
      sessionId: SESSION,
      environment: [],
    })
    expect(parsePiLaunch(pane().startCommand)?.environment).toEqual([
      { name: "THREA_HARNESSD_ENTRYPOINT", value: "/h/index.ts" },
      { name: "THREA_HARNESSD_BUN_BIN", value: "/bin/bun" },
      { name: "THREA_INSTANCE_ID", value: "pi-one" },
      { name: "THREA_RUNTIME_SESSION_ID", value: SESSION },
    ])
  })

  test("preserves safely quoted words and double-quoted literal backslashes", () => {
    expect(parsePiLaunch(`env THREA_INSTANCE_ID="pi\\one" '/opt/my pi/pi' --session-id ${SESSION}`)).toMatchObject({
      executable: "/opt/my pi/pi",
      environment: [{ name: "THREA_INSTANCE_ID", value: "pi\\one" }],
    })
  })

  test("rejects malformed, duplicate, expansion-dependent, and empty identity forms", () => {
    for (const command of [
      "pi --session-id nope",
      `pi --session-id ${SESSION} --session-id ${SESSION}`,
      `pi --unknown --session-id ${SESSION}`,
      `pi hello --session-id ${SESSION}`,
      `pi --session-id ${SESSION} -- tail`,
      `env HOME=/tmp pi --session-id ${SESSION}`,
      `env THREA_INSTANCE_ID=one THREA_INSTANCE_ID=two pi --session-id ${SESSION}`,
      `env THREA_INSTANCE_ID= pi --session-id ${SESSION}`,
      `env THREA_RUNTIME_SESSION_ID='' pi --session-id ${SESSION}`,
      `env THREA_RUNTIME_SESSION_ID=other pi --session-id ${SESSION}`,
      `~/bin/pi --session-id ${SESSION}`,
      `/opt/*/pi --session-id ${SESSION}`,
      `env THREA_INSTANCE_ID=$USER pi --session-id ${SESSION}`,
      `env THREA_INSTANCE_ID="$(whoami)" pi --session-id ${SESSION}`,
      `env THREA_HARNESSD_ENTRYPOINT='a\`b' pi --session-id ${SESSION}`,
    ])
      expect(parsePiLaunch(command)).toBeUndefined()
  })
})

test("standalone pane resolution rejects missing and ambiguous matches", () => {
  expect(findLocalPiPane(SESSION, [])).toBeUndefined()
  expect(() => findLocalPiPane(SESSION, [pane(), pane({ paneId: "%9" })])).toThrow("multiple live standalone")
})

describe("reconnectPi", () => {
  test("uses managed pane first and respawns with exact preserved identity", async () => {
    let preflight: unknown
    const d = deps({
      panes: () => [pane(), pane({ paneId: "%standalone" })],
      preflight: async (params) => {
        preflight = params
        return { status: "linked", rootStreamId: "stream_one" }
      },
    })
    await reconnectPi({ runtimeSessionId: SESSION, rootStreamId: "stream_one" }, d)
    expect(preflight).toMatchObject({
      runtimeKind: "pi-local",
      instanceId: "pi-one",
      runtimeSessionId: SESSION,
      expectedRootStreamId: "stream_one",
    })
    expect(d.calls).toEqual([
      [
        "%8",
        "/work/feature",
        `'env' 'THREA_HARNESSD_ENTRYPOINT=/h/index.ts' 'THREA_HARNESSD_BUN_BIN=/bin/bun' 'THREA_INSTANCE_ID=pi-one' 'THREA_RUNTIME_SESSION_ID=${SESSION}' '/opt/bin/pi' '--session-id' '${SESSION}'`,
      ],
    ])
  })

  test("supports standalone without adopting inventory", async () => {
    let inventoryReads = 0
    const d = deps({ inventory: () => (inventoryReads++, []), panes: () => [pane()] })
    await reconnectPi({ runtimeSessionId: SESSION, rootStreamId: "stream_one" }, d)
    expect({ inventoryReads, respawns: d.calls.length }).toEqual({ inventoryReads: 1, respawns: 1 })
  })

  test("fails closed on duplicate exact managed inventory matches", async () => {
    const d = deps({ inventory: () => [agent(), agent({ id: "pi-2", updatedAt: "2027-01-01T00:00:00Z" })] })
    await expect(reconnectPi({ runtimeSessionId: SESSION, rootStreamId: "stream_one" }, d)).rejects.toThrow(
      "multiple managed agents match"
    )
    expect(d.calls).toEqual([])
  })

  test("preflight failure leaves pane untouched", async () => {
    const d = deps({ preflight: async () => ({ status: "archived", reason: "archived" }) })
    await expect(reconnectPi({ runtimeSessionId: SESSION, rootStreamId: "stream_one" }, d)).rejects.toThrow(
      "preflight failed"
    )
    expect(d.calls).toEqual([])
  })

  test("pane generation changes leave pane untouched", async () => {
    for (const changed of [
      { panePid: 9999 },
      { cwd: "/work/other" },
      { startCommand: `/opt/bin/pi --session-id ${SESSION}` },
    ]) {
      let reads = 0
      const d = deps({ panes: () => (++reads === 1 ? [pane()] : [pane(changed)]) })
      await expect(reconnectPi({ runtimeSessionId: SESSION, rootStreamId: "stream_one" }, d)).rejects.toThrow(
        "changed during reconnect preflight"
      )
      expect(d.calls).toEqual([])
    }
  })

  test("missing managed pane and tmux/preflight failures never launch fresh", async () => {
    const missing = deps({ panes: () => [] })
    await expect(reconnectPi({ runtimeSessionId: SESSION, rootStreamId: "stream_one" }, missing)).rejects.toThrow(
      "missing or ambiguous"
    )
    const failed = deps({
      respawn: () => {
        throw new Error("tmux failed")
      },
    })
    await expect(reconnectPi({ runtimeSessionId: SESSION, rootStreamId: "stream_one" }, failed)).rejects.toThrow(
      "tmux failed"
    )
    expect(missing.calls).toEqual([])
  })
})

describe("readInventoryReadonly", () => {
  test("does not create a missing inventory", () => {
    const previous = process.env.THREA_HARNESSD_INVENTORY
    const path = join(mkdtempSync(join(tmpdir(), "harnessd-reconnect-missing-")), "inventory.sqlite")
    process.env.THREA_HARNESSD_INVENTORY = path
    try {
      expect(readInventoryReadonly()).toEqual([])
      expect(existsSync(path)).toBeFalse()
    } finally {
      if (previous === undefined) delete process.env.THREA_HARNESSD_INVENTORY
      else process.env.THREA_HARNESSD_INVENTORY = previous
    }
  })

  test("reads a legacy schema without migrating it", () => {
    const previous = process.env.THREA_HARNESSD_INVENTORY
    const path = join(mkdtempSync(join(tmpdir(), "harnessd-reconnect-legacy-")), "inventory.sqlite")
    const db = new Database(path)
    db.exec(`CREATE TABLE managed_agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, runtime TEXT NOT NULL, status TEXT NOT NULL,
      worktree TEXT, branch TEXT, tmux_session TEXT, tmux_window TEXT, scratchpad_url TEXT,
      command_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_output TEXT
    )`)
    db.query("INSERT INTO managed_agents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "old",
      "legacy",
      "pi",
      "online",
      null,
      null,
      null,
      null,
      null,
      "[]",
      "2026-01-01",
      "2026-01-01",
      null
    )
    const before = db.query("PRAGMA table_info(managed_agents)").all()
    db.close()
    process.env.THREA_HARNESSD_INVENTORY = path
    try {
      expect(readInventoryReadonly()).toEqual([
        expect.objectContaining({ id: "old", runtimeSessionId: undefined, tmuxPaneId: undefined }),
      ])
      const check = new Database(path, { readonly: true })
      expect(check.query("PRAGMA table_info(managed_agents)").all()).toEqual(before)
      check.close()
    } finally {
      if (previous === undefined) delete process.env.THREA_HARNESSD_INVENTORY
      else process.env.THREA_HARNESSD_INVENTORY = previous
    }
  })
})

describe("parseReconnect", () => {
  test("requires exact root and accepts force once", () => {
    expect(parseReconnect([SESSION, "--root-stream-id", "stream_one", "--force"])).toEqual({
      runtimeSessionId: SESSION,
      rootStreamId: "stream_one",
      force: true,
    })
    expect(() => parseReconnect([SESSION])).toThrow("requires --root-stream-id")
    expect(() => parseReconnect([SESSION, "--root-stream-id", "stream_one", "--force", "--force"])).toThrow(
      "exactly once"
    )
    expect(() => parseReconnect([SESSION, "--root-stream-id", "stream_one", "--extra"])).toThrow("unexpected")
  })
})
