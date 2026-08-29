import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HarnessLink } from "@threa/harness-client"
import { backfillIdentities, recordedProfile, type BackfillDeps, type BackfillOutcome } from "./backfill"
import type { Profile } from "./profiles"
import type { LocalTmuxPane } from "./discovery"
import { writeMintedIdentity, type MintedIdentity, type WriteMintedIdentityResult } from "./identity-store"
import type { ManagedAgent } from "./types"

const WORKTREE = "/repo/threa.feature"

let root: string
const previousIdentities = process.env.THREA_HARNESSD_IDENTITIES_DIR
const previousLinks = process.env.THREA_HARNESS_LINKS_DIR
const previousInventory = process.env.THREA_HARNESSD_INVENTORY

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnessd-backfill-"))
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
    status: "online",
    worktree: WORKTREE,
    runtimeSessionId: "ccs-row",
    instanceId: "cc-row",
    command: [],
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  }
}

function link(overrides: Partial<HarnessLink> = {}): HarnessLink {
  return {
    runtimeKind: "claude-code-channel",
    runtimeSessionId: "ccs-row",
    instanceId: "cc-ledger",
    rootStreamId: "stream_root",
    worktree: WORKTREE,
    pid: 111,
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  }
}

function pane(overrides: Partial<LocalTmuxPane> = {}): LocalTmuxPane {
  return {
    sessionName: "threa-agents",
    windowName: "feature",
    windowId: "@7",
    paneId: "%8",
    panePid: 999,
    cwd: WORKTREE,
    startCommand:
      "env THREA_RUNTIME_SESSION_ID=ccs-row THREA_INSTANCE_ID=cc-launch claude --name threa.feature --dangerously-load-development-channels server:threa-channel",
    ...overrides,
  }
}

function deps(overrides: Partial<BackfillDeps> = {}): { deps: BackfillDeps; written: MintedIdentity[] } {
  const written: MintedIdentity[] = []
  return {
    written,
    deps: {
      identities: () => [],
      links: () => [],
      panes: () => [],
      inventory: () => [agent()],
      claudeProcessesIn: () => [],
      canonicalPath: (path) => path,
      pathExists: () => true,
      write: (record): WriteMintedIdentityResult => {
        written.push(record)
        return { status: "created", record }
      },
      now: () => new Date("2026-07-29T00:00:00.000Z"),
      log: () => {},
      profileFor: () => undefined,
      ...overrides,
    },
  }
}

function pairs(outcomes: BackfillOutcome[]): Array<{ subject: string; disposition: string }> {
  return outcomes.map(({ subject, disposition }) => ({ subject, disposition }))
}

test("an inventory row corroborated by a link record is recorded", () => {
  const context = deps({ links: () => [link()] })
  const outcomes = backfillIdentities(context.deps, false)

  expect(pairs(outcomes)).toEqual([{ subject: WORKTREE, disposition: "recorded" }])
  expect(context.written).toEqual([
    {
      runtimeSessionId: "ccs-row",
      instanceId: "cc-ledger",
      worktree: WORKTREE,
      runtimeKind: "claude-code-channel",
      mintedAt: "2026-07-29T00:00:00.000Z",
      source: "backfill",
      attestedBy: "ledger",
    },
  ])
})

test("a coexisting Pi's record neither conflicts nor pre-empts the Claude backfill", () => {
  const pi: MintedIdentity = {
    runtimeSessionId: "095ed570-f6ce-4f6d-8096-745bb400e166",
    instanceId: "095ed570-f6ce-4f6d-8096-745bb400e166",
    worktree: WORKTREE,
    runtimeKind: "pi-local",
    mintedAt: "2026-07-29T00:00:00.000Z",
    source: "mint",
  }
  const context = deps({ links: () => [link()], identities: () => [pi] })

  const outcomes = backfillIdentities(context.deps, false)

  expect(pairs(outcomes)).toEqual([{ subject: WORKTREE, disposition: "recorded" }])
  expect(context.written.map((record) => record.runtimeKind)).toEqual(["claude-code-channel"])
})

test("an inventory row nothing else attests is refused as a single source", () => {
  const context = deps()
  const outcomes = backfillIdentities(context.deps, false)

  expect(pairs(outcomes)).toEqual([{ subject: WORKTREE, disposition: "refused single source" }])
  expect(context.written).toEqual([])
})

test("a live pane's declared launch corroborates an inventory row", () => {
  // The pane's own Claude is registered in ~/.claude/sessions, so a veto whose
  // pid arm cannot tell it from a stranger refuses every subject this arm
  // exists for — measured on the real fleet as 0 recorded via launch. The pid
  // is supplied here so the test pins a state production can actually reach.
  const context = deps({ panes: () => [pane()], claudeProcessesIn: () => [pane().panePid] })
  const outcomes = backfillIdentities(context.deps, false)

  expect(pairs(outcomes)).toEqual([{ subject: WORKTREE, disposition: "recorded" }])
  expect(context.written).toEqual([
    {
      runtimeSessionId: "ccs-row",
      instanceId: "cc-launch",
      worktree: WORKTREE,
      runtimeKind: "claude-code-channel",
      mintedAt: "2026-07-29T00:00:00.000Z",
      source: "backfill",
      attestedBy: "launch",
    },
  ])
})

test("a directory with an unidentified live Claude is refused, not recorded", () => {
  const context = deps({ links: () => [link()], claudeProcessesIn: () => [4242, 4243] })
  const outcomes = backfillIdentities(context.deps, false)

  expect(outcomes).toEqual([
    {
      subject: WORKTREE,
      disposition: "refused occupied",
      detail: `an unidentified live Claude occupies ${WORKTREE} (pid 4242, 4243)`,
    },
  ])
  expect(context.written).toEqual([])
})

test("sources that disagree on one worktree are refused, never merged", () => {
  const context = deps({ links: () => [link({ runtimeSessionId: "ccs-ledger" })] })
  const outcomes = backfillIdentities(context.deps, false)

  expect(outcomes).toEqual([
    {
      subject: WORKTREE,
      disposition: "refused conflicting",
      detail: `sources disagree on ${WORKTREE}: ccs-ledger, ccs-row`,
    },
  ])
  expect(context.written).toEqual([])
})

test("a row whose worktree no longer exists is refused, not recorded", () => {
  const context = deps({ links: () => [link()], pathExists: () => false })
  const outcomes = backfillIdentities(context.deps, false)

  expect(pairs(outcomes)).toEqual([{ subject: WORKTREE, disposition: "refused worktree missing" }])
  expect(context.written).toEqual([])
})

test("a dry run reports the same dispositions and writes nothing", () => {
  // Both passes run against the REAL store, in separate directories, over two
  // subjects whose evidence resolves to ONE id. A stubbed `write` cannot catch
  // this: with nothing persisted, the wet run's later subjects see exactly the
  // store the dry run sees, so the equality holds for any divergence.
  const two = {
    inventory: () => [agent(), agent({ id: "claude-2", name: "other", worktree: "/repo/threa.other" })],
    links: () => [link(), link({ worktree: "/repo/threa.other" })],
    pathExists: () => true,
  }
  const wetDir = join(root, "wet")
  const dryDir = join(root, "dry")

  process.env.THREA_HARNESSD_IDENTITIES_DIR = wetDir
  const wet = backfillIdentities({ ...deps(two).deps, write: writeMintedIdentity }, false)
  process.env.THREA_HARNESSD_IDENTITIES_DIR = dryDir
  const preview = backfillIdentities({ ...deps(two).deps, write: writeMintedIdentity }, true)

  expect(preview).toEqual(wet)
  expect(wet.map((outcome) => outcome.disposition)).toEqual(["recorded", "refused conflicting"])
  expect(existsSync(dryDir)).toBe(false)
})

test("the backfill never writes a harness link record", () => {
  const linksDir = process.env.THREA_HARNESS_LINKS_DIR!
  mkdirSync(linksDir, { recursive: true })
  const before = readdirSync(linksDir)

  const outcomes = backfillIdentities(deps({ links: () => [link()], write: writeMintedIdentity }).deps, false)

  expect(pairs(outcomes)).toEqual([{ subject: WORKTREE, disposition: "recorded" }])
  expect(readdirSync(linksDir)).toEqual(before)
})

test("every subject appears in the disposition list exactly once", () => {
  const rows: ManagedAgent[] = [
    agent({ id: "a", worktree: "/repo/a", runtimeSessionId: "ccs-a" }),
    agent({ id: "b", worktree: "/repo/b", runtimeSessionId: "ccs-b" }),
    agent({ id: "c", worktree: "/repo/c", runtimeSessionId: "ccs-c" }),
    agent({ id: "d", worktree: "/repo/d", runtimeSessionId: "ccs-d" }),
    agent({ id: "e", worktree: "/repo/e", runtimeSessionId: "ccs-e" }),
    agent({ id: "f", worktree: "/repo/f", runtimeSessionId: "ccs-f" }),
    agent({ id: "f-twin", worktree: "/repo/f", runtimeSessionId: "ccs-f" }),
  ]
  const context = deps({
    inventory: () => rows,
    links: () => [
      link({ worktree: "/repo/a", runtimeSessionId: "ccs-a" }),
      link({ worktree: "/repo/c", runtimeSessionId: "ccs-other" }),
      link({ worktree: "/repo/d", runtimeSessionId: "ccs-d" }),
      link({ worktree: "/repo/f", runtimeSessionId: "ccs-f" }),
    ],
    identities: () => [
      {
        runtimeSessionId: "ccs-e",
        instanceId: "cc-e",
        worktree: "/repo/e",
        runtimeKind: "claude-code-channel",
        mintedAt: "2026-07-29T00:00:00.000Z",
        source: "mint",
      },
    ],
    pathExists: (path) => path !== "/repo/b",
    claudeProcessesIn: (worktree) => (worktree === "/repo/d" ? [77] : []),
  })

  expect(pairs(backfillIdentities(context.deps, false))).toEqual([
    { subject: "/repo/a", disposition: "recorded" },
    { subject: "/repo/b", disposition: "refused worktree missing" },
    { subject: "/repo/c", disposition: "refused conflicting" },
    { subject: "/repo/d", disposition: "refused occupied" },
    { subject: "/repo/e", disposition: "already recorded" },
    { subject: "/repo/f", disposition: "recorded" },
  ])
})

test("each source is read once per pass, not once per subject", () => {
  // Two tmux subprocesses and two full directory scans per subject, all while
  // the startup path holds the shared lock.
  let paneReads = 0
  let linkReads = 0
  const context = deps({
    inventory: () => [agent(), agent({ id: "claude-2", name: "other", worktree: "/repo/threa.other" })],
    links: () => {
      linkReads += 1
      return [link()]
    },
    panes: () => {
      paneReads += 1
      return []
    },
  })

  backfillIdentities(context.deps, true)

  expect({ paneReads, linkReads }).toEqual({ paneReads: 1, linkReads: 1 })
})

test("a corroborated subject with no instance id is not counted as a single source", () => {
  const context = deps({
    inventory: () => [agent({ instanceId: undefined })],
    links: () => [link({ instanceId: "" })],
  })

  const outcomes = backfillIdentities(context.deps, false)

  expect(pairs(outcomes)).toEqual([{ subject: WORKTREE, disposition: "refused no instance id" }])
  expect(context.written).toEqual([])
})

test("a row's recorded profile is carried onto the record the backfill writes", () => {
  // A reap deletes the snapshot with the worktree, so a directory that comes
  // back through an unarchive is re-recorded here. Without this it is
  // re-recorded with NO profile, which resolves to the built-in default and
  // silently stops running the teardown the operator declared.
  const quiet: Profile = { name: "quiet", provision: "existing", preserve: "none", setup: [], teardown: [] }
  const context = deps({ links: () => [link()], profileFor: () => quiet })

  const outcomes = backfillIdentities(context.deps, false)

  expect(pairs(outcomes)).toEqual([{ subject: WORKTREE, disposition: "recorded" }])
  expect(context.written[0]?.profile).toEqual(quiet)
})

test("recordedProfile reads the profile off the row's own spawn command", () => {
  expect(recordedProfile([agent({ command: ["threa-harnessd", "spawn", "claude", "--name", "x"] })])).toBeUndefined()
  expect(
    recordedProfile([agent({ command: ["threa-harnessd", "spawn", "claude", "--cwd", "/repo/x"] })])
  ).toMatchObject({ provision: "existing", preserve: "none" })
})
