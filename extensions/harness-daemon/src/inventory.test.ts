import { Database } from "bun:sqlite"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultAgentIdentityResolver, type AgentIdentityResolver } from "./discovery"
import { findAgentOrUndefined, readInventory, readInventoryReadonly, upsertAgent } from "./inventory"
import { latestAgentsByIdentity } from "./resume"
import type { ManagedAgent } from "./types"

let root: string
const previousIdentities = process.env.THREA_HARNESSD_IDENTITIES_DIR
const previousLinks = process.env.THREA_HARNESS_LINKS_DIR
const previousInventory = process.env.THREA_HARNESSD_INVENTORY

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnessd-selection-"))
  process.env.THREA_HARNESSD_IDENTITIES_DIR = join(root, "identities")
  process.env.THREA_HARNESS_LINKS_DIR = join(root, "links")
  process.env.THREA_HARNESSD_INVENTORY = join(root, "inventory.sqlite")
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  restore("THREA_HARNESSD_IDENTITIES_DIR", previousIdentities)
  restore("THREA_HARNESS_LINKS_DIR", previousLinks)
  restore("THREA_HARNESSD_INVENTORY", previousInventory)
})

function agent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  return {
    id: "claude-1",
    name: "feature",
    runtime: "claude",
    status: "offline",
    worktree: "/repo/threa.feature",
    command: ["threa-harnessd", "spawn", "claude"],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  }
}

/** The identity each worktree resolves to, standing in for the stores the real resolver reads. */
function resolverFor(byWorktree: Record<string, string>): AgentIdentityResolver {
  return (managed) => (managed.worktree ? byWorktree[managed.worktree] : undefined)
}

test("two rows sharing a name but resolving to different identities are both revival candidates", () => {
  const one = agent({ id: "claude-1", worktree: undefined, runtimeSessionId: "ccs-one" })
  const two = agent({
    id: "claude-2",
    worktree: undefined,
    runtimeSessionId: "ccs-two",
    updatedAt: "2026-07-02T00:00:00.000Z",
  })

  const candidates = latestAgentsByIdentity([one, two], (managed) => managed.runtimeSessionId)

  expect(candidates).toEqual([one, two])
})

test("two rows for one identity collapse to the newest, whatever their names", () => {
  // A rename changes the agent's name, not its directory, so the rows this is
  // meant to merge share a worktree.
  const renamed = agent({
    id: "claude-2",
    name: "renamed",
    updatedAt: "2026-07-02T00:00:00.000Z",
  })

  const candidates = latestAgentsByIdentity([agent(), renamed], resolverFor({ "/repo/threa.feature": "ccs-one" }))

  expect(candidates).toEqual([renamed])
})

test("one identity recorded for two different worktrees does not silently drop one", () => {
  // The live inventory still carries a pair like this, left by the
  // identity-inheritance bug fixed in 647a99978: a spawn inherited the caller's
  // id instead of deriving from its own worktree. Collapsing them means one of
  // two real directories is never revived, and nothing reports it.
  const other = agent({ id: "claude-2", name: "other", worktree: "/repo/threa.other" })

  const candidates = latestAgentsByIdentity(
    [agent(), other],
    resolverFor({ "/repo/threa.feature": "ccs-one", "/repo/threa.other": "ccs-one" })
  )

  expect(candidates.map((candidate) => candidate.id).sort()).toEqual(["claude-1", "claude-2"])
})

test("a tombstoned row is never a revival candidate", () => {
  const live = agent({ id: "claude-2", name: "live", worktree: "/repo/threa.live" })

  const candidates = latestAgentsByIdentity(
    [agent({ tombstonedAt: "2026-07-29T00:00:00.000Z" }), live],
    resolverFor({ "/repo/threa.feature": "ccs-one", "/repo/threa.live": "ccs-two" })
  )

  expect(candidates).toEqual([live])
})

test("a tombstoned row is still findable by explicit id", () => {
  const retired = agent({ tombstonedAt: "2026-07-29T00:00:00.000Z" })

  expect(findAgentOrUndefined("claude-1", [retired], () => "ccs-one")).toEqual(retired)
  expect(findAgentOrUndefined("feature", [retired], () => "ccs-one")).toBeUndefined()
})

test("a ref matching two live identities is refused with both ids named", () => {
  const rows = [
    agent({ id: "claude-1", worktree: "/repo/threa.one" }),
    agent({ id: "claude-2", worktree: "/repo/threa.two" }),
  ]

  expect(() =>
    findAgentOrUndefined("feature", rows, resolverFor({ "/repo/threa.one": "ccs-one", "/repo/threa.two": "ccs-two" }))
  ).toThrow("multiple agents match feature: ccs-one, ccs-two; use id")
})

test("a row with no identity anywhere is still selectable by canonical worktree", () => {
  const rows = [
    agent({ id: "claude-1", worktree: "/repo/threa.one" }),
    agent({ id: "claude-2", worktree: "/repo/threa.two" }),
  ]

  expect(findAgentOrUndefined("/repo/threa.two", rows, () => undefined)).toEqual(rows[1]!)
})

test("opening an inventory created before tombstoned_at adds the column in place", () => {
  const path = join(root, "legacy.sqlite")
  const db = new Database(path)
  db.exec(`
    CREATE TABLE managed_agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, runtime TEXT NOT NULL, status TEXT NOT NULL,
      worktree TEXT, branch TEXT, tmux_session TEXT, tmux_window TEXT, scratchpad_url TEXT,
      command_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_output TEXT
    )
  `)
  db.exec(
    `INSERT INTO managed_agents (id, name, runtime, status, command_json, created_at, updated_at)
     VALUES ('claude-1', 'feature', 'claude', 'offline', '[]', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`
  )
  db.close()
  process.env.THREA_HARNESSD_INVENTORY = path

  expect(readInventory()).toEqual([agent({ command: [], worktree: undefined })])
  upsertAgent(agent({ command: [], worktree: undefined, tombstonedAt: "2026-07-29T00:00:00.000Z" }))
  expect(readInventory()).toEqual([
    agent({ command: [], worktree: undefined, tombstonedAt: "2026-07-29T00:00:00.000Z" }),
  ])
})

test("the readonly reader projects NULL for a column the file predates", () => {
  const path = join(root, "old.sqlite")
  const db = new Database(path)
  db.exec(`
    CREATE TABLE managed_agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, runtime TEXT NOT NULL, status TEXT NOT NULL,
      worktree TEXT, branch TEXT, tmux_session TEXT, tmux_window TEXT, scratchpad_url TEXT,
      command_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_output TEXT
    )
  `)
  db.exec(
    `INSERT INTO managed_agents (id, name, runtime, status, command_json, created_at, updated_at)
     VALUES ('claude-1', 'feature', 'claude', 'offline', '[]', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`
  )
  db.close()
  process.env.THREA_HARNESSD_INVENTORY = path

  expect(readInventoryReadonly()).toEqual([agent({ command: [], worktree: undefined })])

  process.env.THREA_HARNESSD_INVENTORY = join(root, "current.sqlite")
  upsertAgent(agent({ tombstonedAt: "2026-07-29T00:00:00.000Z" }))
  expect(readInventoryReadonly()).toEqual([agent({ tombstonedAt: "2026-07-29T00:00:00.000Z" })])
})

test("a ref names a row by the identity a store attests, not only the one it recorded", () => {
  // The rung that distinguishes identity-based selection from a recorded-id plus
  // path lookup: a row the backfill has not reached records nothing, but the
  // minted or link store attests its worktree, so `stop`/`kick`/`resolve` on
  // that id still find it.
  const unrecorded = agent({ runtimeSessionId: undefined })

  const found = findAgentOrUndefined(
    "ccs-attested",
    [unrecorded],
    resolverFor({ "/repo/threa.feature": "ccs-attested" })
  )

  expect(found?.id).toBe("claude-1")
})

test("a ref whose identity names two worktrees is refused, not resolved to the newest", () => {
  // stopAgent kills the pane the ref resolves to. Picking the newest here points
  // it at a directory the operator never named.
  const other = agent({ id: "claude-2", name: "other", worktree: "/repo/threa.other" })
  const resolver = resolverFor({ "/repo/threa.feature": "ccs-one", "/repo/threa.other": "ccs-one" })

  expect(() => findAgentOrUndefined("ccs-one", [agent(), other], resolver)).toThrow(/two worktrees|2 worktrees/)
})

test("a targeted restore considers a tombstoned row; an untargeted sweep does not", () => {
  const dead = agent({ tombstonedAt: "2026-07-29T00:00:00.000Z" })

  expect(latestAgentsByIdentity([dead], resolverFor({}))).toEqual([])
  expect(latestAgentsByIdentity([dead], resolverFor({}), true)).toEqual([dead])
})

test("a Pi row is never resolved through the Claude identity stack", () => {
  // The live regression (2026-08-10): a Pi and a Claude sharing one cwd, with
  // a Claude record minted for it — the Pi row resolved to the CLAUDE minted
  // id, collided with the real Claude row in latestAgentsByIdentity, and
  // silently dropped out of every `up` sweep.
  const resolver = defaultAgentIdentityResolver(
    [
      {
        runtimeSessionId: "ccs-claude",
        instanceId: "cc-claude",
        worktree: "/home/user",
        runtimeKind: "claude-code-channel",
        mintedAt: "2026-08-10T00:00:00.000Z",
        source: "mint",
      },
    ],
    []
  )
  const pi = agent({ id: "pi-1", runtime: "pi", worktree: "/home/user", runtimeSessionId: "pi-uuid" })
  const claude = agent({ id: "claude-1", worktree: "/home/user", runtimeSessionId: "ccs-claude" })

  expect(resolver(pi)).toBe("pi-uuid")
  expect(
    latestAgentsByIdentity([pi, claude], resolver)
      .map((row) => row.id)
      .sort()
  ).toEqual(["claude-1", "pi-1"])
})
