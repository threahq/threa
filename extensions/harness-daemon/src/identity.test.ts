import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { HarnessLink } from "@threa/bot-runtime-client"
import {
  buildIdentityRows,
  identityConsistency,
  rowMatchesRef,
  summarizeIdentityRows,
  type IdentityRow,
} from "./identity"
import { deriveClaudeRuntimeIdentity } from "./spawners"
import type { LocalTmuxPane } from "./discovery"
import type { MintedIdentity } from "./identity-store"
import type { ManagedAgent } from "./types"

const HOST = "identity-test-host"
const WORKTREE = "/tmp/worktrees/feature"

function derived(worktree = WORKTREE): string {
  return deriveClaudeRuntimeIdentity(worktree, {}, HOST).runtimeSessionId
}

function agent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  return {
    id: "claude-1",
    name: "feature",
    runtime: "claude",
    status: "online",
    worktree: WORKTREE,
    command: ["threa-harnessd", "spawn", "claude"],
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  }
}

function pane(overrides: Partial<LocalTmuxPane> = {}): LocalTmuxPane {
  return {
    sessionName: "threa-agents",
    windowName: "feature",
    windowId: "@7",
    paneId: "%8",
    panePid: 4242,
    cwd: WORKTREE,
    startCommand:
      '"claude --name threa.feature --dangerously-load-development-channels server:threa-channel --dangerously-skip-permissions "',
    ...overrides,
  }
}

function declaring(runtimeSessionId: string, overrides: Partial<LocalTmuxPane> = {}): LocalTmuxPane {
  return pane({
    startCommand: `"env THREA_RUNTIME_SESSION_ID=${runtimeSessionId} claude --dangerously-load-development-channels server:threa-channel "`,
    ...overrides,
  })
}

function link(overrides: Partial<HarnessLink> = {}): HarnessLink {
  return {
    runtimeKind: "claude-code-channel",
    runtimeSessionId: "ccs-ledger",
    instanceId: "cc-ledger",
    rootStreamId: "stream_1",
    worktree: WORKTREE,
    pid: 4242,
    updatedAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  }
}

const originalLinksDir = process.env.THREA_HARNESS_LINKS_DIR
const originalIdentitiesDir = process.env.THREA_HARNESSD_IDENTITIES_DIR
let storeRoot: string

beforeEach(() => {
  storeRoot = mkdtempSync(join(tmpdir(), "harnessd-identity-"))
  process.env.THREA_HARNESSD_IDENTITIES_DIR = join(storeRoot, "identities")
})

afterEach(() => {
  rmSync(storeRoot, { recursive: true, force: true })
  if (originalLinksDir === undefined) delete process.env.THREA_HARNESS_LINKS_DIR
  else process.env.THREA_HARNESS_LINKS_DIR = originalLinksDir
  if (originalIdentitiesDir === undefined) delete process.env.THREA_HARNESSD_IDENTITIES_DIR
  else process.env.THREA_HARNESSD_IDENTITIES_DIR = originalIdentitiesDir
})

test("a recorded identity today's derivation no longer reproduces reports drifted", () => {
  const rows = buildIdentityRows({
    agents: [agent({ runtimeSessionId: "ccs-recorded" })],
    panes: [],
    links: [],
    host: HOST,
  })

  expect(rows).toEqual([
    {
      kind: "row",
      name: "feature",
      recorded: "ccs-recorded",
      minted: "-",
      ledger: "-",
      derived: derived(),
      source: "inventory",
      pane: "-",
      verdict: "missing,drifted",
    },
  ])
})

test("a drifted row that still resolves reports both statuses", () => {
  const rows = buildIdentityRows({
    agents: [agent({ runtimeSessionId: "ccs-recorded" })],
    panes: [declaring("ccs-recorded")],
    links: [],
    host: HOST,
  })

  expect(rows).toEqual([
    {
      kind: "row",
      name: "feature",
      recorded: "ccs-recorded",
      minted: "-",
      ledger: "-",
      derived: derived(),
      source: "inventory",
      pane: "%8",
      verdict: "found,drifted",
    },
  ])
})

test("a row identified through the ledger shows recorded, ledger and derived separately and resolves", () => {
  const rows = buildIdentityRows({
    agents: [agent({ runtimeSessionId: "ccs-ledger" })],
    panes: [pane()],
    links: [link()],
    host: HOST,
  })

  expect(rows).toEqual([
    {
      kind: "row",
      name: "feature",
      recorded: "ccs-ledger",
      minted: "-",
      ledger: "ccs-ledger",
      derived: derived(),
      source: "ledger",
      pane: "%8",
      verdict: "found,drifted",
    },
  ])
  expect(rows[0]!.derived).not.toBe(rows[0]!.ledger)
})

test("a live unmanaged pane with no inventory row is covered under its own identity", () => {
  const rows = buildIdentityRows({
    agents: [],
    panes: [declaring("ccs-unmanaged", { windowName: "slopenv", paneId: "%12", cwd: "/tmp/worktrees/slopenv" })],
    links: [],
    host: HOST,
  })

  expect(rows).toEqual([
    {
      kind: "pane",
      name: "slopenv",
      recorded: "ccs-unmanaged",
      minted: "-",
      ledger: "-",
      derived: derived("/tmp/worktrees/slopenv"),
      source: "declared",
      pane: "%12",
      verdict: "found,drifted",
    },
  ])
})

test("a row whose recorded identity matches today's derivation is not reported as drifted", () => {
  const rows = buildIdentityRows({
    agents: [agent({ runtimeSessionId: derived() })],
    panes: [declaring(derived())],
    links: [],
    host: HOST,
  })

  expect(rows).toEqual([
    {
      kind: "row",
      name: "feature",
      recorded: derived(),
      minted: "-",
      ledger: "-",
      derived: derived(),
      source: "inventory",
      pane: "%8",
      verdict: "found",
    },
  ])
})

test("an unmanaged pane identified only by the ledger reports the attested identity", () => {
  const rows = buildIdentityRows({
    agents: [],
    panes: [pane({ windowName: "slopenv", paneId: "%12", cwd: "/tmp/worktrees/slopenv" })],
    links: [link({ runtimeSessionId: "ccs-attested", worktree: "/tmp/worktrees/slopenv" })],
    host: HOST,
  })

  expect(rows).toEqual([
    {
      kind: "pane",
      name: "slopenv",
      recorded: "-",
      minted: "-",
      ledger: "ccs-attested",
      derived: derived("/tmp/worktrees/slopenv"),
      source: "ledger",
      pane: "%12",
      verdict: "found",
    },
  ])
})

test("a live unmanaged Pi pane is covered under its session id", () => {
  const rows = buildIdentityRows({
    agents: [],
    panes: [
      pane({
        windowName: "pi-sol",
        paneId: "%14",
        cwd: "/tmp/worktrees/sol",
        startCommand: '"pi --session-id 3f9a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b "',
      }),
    ],
    links: [],
    host: HOST,
  })

  expect(rows).toEqual([
    {
      kind: "pane",
      name: "pi-sol",
      recorded: "3f9a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
      minted: "-",
      ledger: "-",
      derived: "-",
      source: "-",
      pane: "%14",
      verdict: "found",
    },
  ])
  expect(summarizeIdentityRows(rows)).toEqual({ total: 1, counts: [["found", 1]] })
})

test("the summary counts every emitted row under its own verdict", () => {
  const rows = buildIdentityRows({
    agents: [
      agent({ runtimeSessionId: "ccs-recorded" }),
      agent({ id: "claude-2", name: "other", worktree: "/tmp/worktrees/other" }),
    ],
    panes: [declaring("ccs-recorded"), declaring("ccs-unmanaged", { paneId: "%12", cwd: "/tmp/worktrees/loose" })],
    links: [],
    host: HOST,
  })

  const summary = summarizeIdentityRows(rows)
  expect(rows).toHaveLength(3)
  expect(summary).toEqual({
    total: 3,
    counts: [
      ["found,drifted", 2],
      ["missing", 1],
    ],
  })
})

test("the consistency check counts drifted records and survives an absent links directory", () => {
  process.env.THREA_HARNESS_LINKS_DIR = join(tmpdir(), "harnessd-identity-test-absent")

  expect(
    identityConsistency({
      agents: [agent({ runtimeSessionId: "ccs-recorded" }), agent({ id: "claude-2", runtimeSessionId: derived() })],
      panes: [declaring("ccs-recorded"), declaring(derived(), { paneId: "%12" })],
      host: HOST,
    })
  ).toEqual({ inventoryRows: 1, linkRecords: 0, livePanes: 1, identityless: 0 })

  expect(
    identityConsistency({ agents: [], panes: [], links: [link({ runtimeSessionId: "ccs-drifted" })], host: HOST })
  ).toEqual({ inventoryRows: 0, linkRecords: 1, livePanes: 0, identityless: 0 })
})

test("a by-id lookup finds a pane whose identity only the ledger attests", () => {
  // The pane worth looking up is exactly the one that declares nothing, so its
  // `recorded` column is "-" and the id lives in `ledger`. Matching on
  // `recorded` alone returned a definitive false negative for the drifted case
  // and succeeded only for panes that were never broken.
  const attested: IdentityRow = {
    kind: "pane",
    name: "claude-slopenv",
    recorded: "-",
    minted: "ccs-minted",
    ledger: "ccs-attested",
    derived: "ccs-derived",
    source: "ledger",
    pane: "%12",
    verdict: "found",
  }

  expect(rowMatchesRef(attested, "ccs-minted")).toBe(true)
  expect(rowMatchesRef(attested, "ccs-attested")).toBe(true)
  expect(rowMatchesRef(attested, "ccs-derived")).toBe(true)
  expect(rowMatchesRef(attested, "ccs-somebody-else")).toBe(false)
  expect(rowMatchesRef({ ...attested, recorded: "ccs-declared" }, "ccs-declared")).toBe(true)
})

function minted(overrides: Partial<MintedIdentity> = {}): MintedIdentity {
  return {
    runtimeSessionId: "ccs-minted",
    instanceId: "cc-minted",
    worktree: WORKTREE,
    runtimeKind: "claude-code-channel",
    mintedAt: "2026-07-29T00:00:00.000Z",
    source: "mint",
    ...overrides,
  }
}

test("resolve prints the minted column and the winning source", () => {
  const rows = buildIdentityRows({
    agents: [agent({ runtimeSessionId: "ccs-minted" })],
    panes: [pane()],
    links: [link()],
    identities: [minted()],
    host: HOST,
  })

  expect(rows).toEqual([
    {
      kind: "row",
      name: "feature",
      recorded: "ccs-minted",
      minted: "ccs-minted",
      ledger: "ccs-ledger",
      derived: derived(),
      source: "minted",
      pane: "%8",
      verdict: "found,drifted",
    },
  ])
  expect(rowMatchesRef(rows[0]!, "ccs-minted")).toBe(true)
})

test("doctor counts rows that carry no identity from any source", () => {
  // The number that has to fall before the hostname derivation can go: these
  // rows resolve only by hashing a name the wifi network supplies.
  const identityless = agent({ id: "claude-2", worktree: "/tmp/worktrees/nameless", instanceId: undefined })

  expect(
    identityConsistency({
      agents: [agent({ runtimeSessionId: "ccs-minted" }), identityless],
      panes: [],
      links: [],
      identities: [minted()],
      host: HOST,
    })
  ).toEqual({ inventoryRows: 1, linkRecords: 0, livePanes: 0, identityless: 1 })
})
