import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readInventory, upsertAgent } from "./inventory"
import type { ScratchpadStatus } from "./resume"
import { tombstoneAbandonedRows, type TombstoneDeps } from "./tombstone"
import type { ManagedAgent } from "./types"

const WORKTREE = "/repo/threa.feature"
const SCRATCHPAD = "https://app.threa.io/w/ws_01WORKSPACE/s/stream_01ABCDEF"

let root: string
const previousIdentities = process.env.THREA_HARNESSD_IDENTITIES_DIR
const previousLinks = process.env.THREA_HARNESS_LINKS_DIR
const previousInventory = process.env.THREA_HARNESSD_INVENTORY

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnessd-tombstone-"))
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
    worktree: WORKTREE,
    scratchpadUrl: SCRATCHPAD,
    runtimeSessionId: "ccs-row",
    instanceId: "cc-row",
    command: ["threa-harnessd", "spawn", "claude"],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  }
}

/** Writes through the real inventory, so a dry run and a wet run are compared against real state. */
function deps(overrides: Partial<TombstoneDeps> = {}): { deps: TombstoneDeps; persisted: ManagedAgent[] } {
  const persisted: ManagedAgent[] = []
  return {
    persisted,
    deps: {
      inventory: readInventory,
      pathExists: () => false,
      scratchpadStatus: async (): Promise<ScratchpadStatus> => "archived",
      persist: (managed) => {
        persisted.push(managed)
        upsertAgent(managed)
      },
      now: () => new Date("2026-07-29T00:00:00.000Z"),
      ...overrides,
    },
  }
}

test("a row whose worktree is gone and whose scratchpad is archived is tombstoned, never deleted", async () => {
  upsertAgent(agent())
  const context = deps()

  const outcomes = await tombstoneAbandonedRows(context.deps, false)

  expect(outcomes).toEqual([{ subject: "claude-1", disposition: "tombstoned", detail: "feature" }])
  expect(readInventory()).toEqual([
    agent({ tombstonedAt: "2026-07-29T00:00:00.000Z", updatedAt: "2026-07-29T00:00:00.000Z" }),
  ])
})

test("a row whose worktree is gone but whose scratchpad is still active is kept", async () => {
  upsertAgent(agent())
  const context = deps({ scratchpadStatus: async () => "active" })

  const outcomes = await tombstoneAbandonedRows(context.deps, false)

  expect(outcomes).toEqual([{ subject: "claude-1", disposition: "kept scratchpad active", detail: "feature" }])
  expect(readInventory()).toEqual([agent()])
})

test("a row whose scratchpad cannot be read is kept", async () => {
  upsertAgent(agent())
  const context = deps({ scratchpadStatus: async () => "inaccessible" })

  const outcomes = await tombstoneAbandonedRows(context.deps, false)

  expect(outcomes).toEqual([{ subject: "claude-1", disposition: "kept scratchpad unreadable", detail: "inaccessible" }])
  expect(readInventory()).toEqual([agent()])
})

test("a row whose worktree still exists is kept even when the scratchpad is archived", async () => {
  upsertAgent(agent())
  const context = deps({ pathExists: () => true })

  const outcomes = await tombstoneAbandonedRows(context.deps, false)

  expect(outcomes).toEqual([{ subject: "claude-1", disposition: "kept worktree present", detail: WORKTREE }])
  expect(readInventory()).toEqual([agent()])
})

test("an already tombstoned row is reported, not rewritten", async () => {
  upsertAgent(agent({ tombstonedAt: "2026-07-20T00:00:00.000Z" }))
  const context = deps()

  const outcomes = await tombstoneAbandonedRows(context.deps, false)

  expect(outcomes).toEqual([
    { subject: "claude-1", disposition: "already tombstoned", detail: "2026-07-20T00:00:00.000Z" },
  ])
  expect(context.persisted).toEqual([])
})

test("a dry run reports the same dispositions and writes nothing", async () => {
  upsertAgent(agent())
  upsertAgent(agent({ id: "claude-2", name: "other", worktree: "/repo/threa.other" }))
  upsertAgent(agent({ id: "claude-3", name: "live", scratchpadUrl: undefined }))
  const preview = deps()

  const previewed = await tombstoneAbandonedRows(preview.deps, true)
  const before = readInventory()
  const wet = deps()
  const applied = await tombstoneAbandonedRows(wet.deps, false)

  expect(preview.persisted).toEqual([])
  expect(before).toEqual([
    agent(),
    agent({ id: "claude-2", name: "other", worktree: "/repo/threa.other" }),
    agent({ id: "claude-3", name: "live", scratchpadUrl: undefined }),
  ])
  expect(previewed).toEqual(applied)
  expect(wet.persisted.map((managed) => managed.id)).toEqual(["claude-1", "claude-2"])
})

test("a row the revive path is already backing off is not probed again", async () => {
  // Same endpoint, same rows. Re-asking hammers exactly the scratchpads the
  // backoff exists to protect — and because a row is never deleted and an
  // inaccessible one can never be tombstoned, that set only ever grows.
  upsertAgent(agent({ probeFailures: 27, probeBackoffUntil: "2026-07-29T06:00:00.000Z" }))
  let probes = 0
  const context = deps({
    scratchpadStatus: async (): Promise<ScratchpadStatus> => {
      probes += 1
      return "archived"
    },
  })

  const outcomes = await tombstoneAbandonedRows(context.deps, false)

  expect(outcomes).toEqual([
    { subject: "claude-1", disposition: "kept probe suppressed", detail: "2026-07-29T06:00:00.000Z" },
  ])
  expect(probes).toBe(0)
  expect(context.persisted).toEqual([])
})

test("a row whose backoff has expired is probed and tombstoned", async () => {
  upsertAgent(agent({ probeFailures: 27, probeBackoffUntil: "2026-07-28T00:00:00.000Z" }))
  const context = deps()

  const outcomes = await tombstoneAbandonedRows(context.deps, false)

  expect(outcomes.map((outcome) => outcome.disposition)).toEqual(["tombstoned"])
})
