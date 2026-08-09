import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HarnessLink } from "@threa/bot-runtime-client"
import type { LocalTmuxPane } from "./discovery"
import type { MintedIdentity, WriteMintedIdentityResult } from "./identity-store"
import { defaultMintDeps, mintRuntimeIdentity, type MintDeps } from "./mint"
import { deriveClaudeRuntimeIdentity } from "./spawners"

const WORKTREE = "/repo/threa.feature"

let root: string
const previousIdentities = process.env.THREA_HARNESSD_IDENTITIES_DIR
const previousLinks = process.env.THREA_HARNESS_LINKS_DIR
const previousInventory = process.env.THREA_HARNESSD_INVENTORY

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnessd-mint-"))
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

function pane(overrides: Partial<LocalTmuxPane> = {}): LocalTmuxPane {
  return {
    sessionName: "threa-agents",
    windowName: "feature",
    windowId: "@7",
    paneId: "%8",
    panePid: 999,
    cwd: WORKTREE,
    startCommand:
      '"claude --name threa.feature --dangerously-load-development-channels server:threa-channel --dangerously-skip-permissions "',
    ...overrides,
  }
}

function link(overrides: Partial<HarnessLink> = {}): HarnessLink {
  return {
    runtimeKind: "claude-code-channel",
    runtimeSessionId: "ccs-ledger",
    instanceId: "cc-ledger",
    rootStreamId: "stream_root",
    worktree: WORKTREE,
    pid: 111,
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  }
}

function identity(overrides: Partial<MintedIdentity> = {}): MintedIdentity {
  return {
    runtimeSessionId: "ccs-stored",
    instanceId: "cc-stored",
    worktree: WORKTREE,
    runtimeKind: "claude-code-channel",
    mintedAt: "2026-07-29T00:00:00.000Z",
    source: "mint",
    ...overrides,
  }
}

function deps(overrides: Partial<MintDeps> = {}): { deps: MintDeps; written: MintedIdentity[] } {
  const written: MintedIdentity[] = []
  return {
    written,
    deps: {
      identities: () => [],
      links: () => [],
      panes: () => [],
      claudeProcessesIn: () => [],
      canonicalPath: (path) => path,
      write: (record): WriteMintedIdentityResult => {
        written.push(record)
        return { status: "created", record }
      },
      newSuffix: () => "abcdef0123456789",
      now: () => new Date("2026-07-29T00:00:00.000Z"),
      warn: () => {},
      ...overrides,
    },
  }
}

test("a fresh worktree mints an identity no hostname reproduces", async () => {
  const { deps: mintDeps } = deps({ newSuffix: () => "f00dfeedbaadc0de" })

  const outcome = await mintRuntimeIdentity({ worktree: WORKTREE, runtimeKind: "claude-code-channel" }, mintDeps)

  expect(outcome).toEqual({
    status: "minted",
    runtimeSessionId: "ccs-f00dfeedbaadc0de",
    instanceId: "cc-f00dfeedbaadc0de",
    worktree: WORKTREE,
  })
})

// The property the feature exists for lives in the PRODUCTION suffix generator,
// not in an injected one. Swapping randomBytes for a hostname-seeded hash leaves
// every other test in this file green while restoring the exact identity drift
// that caused the 2026-07-28 duplicate storm.
test("the production suffix generator is random, not derived from the host", () => {
  const suffixes = [defaultMintDeps().newSuffix(), defaultMintDeps().newSuffix()]

  for (const suffix of suffixes) expect(suffix).toMatch(/^[0-9a-f]{16}$/)
  expect(suffixes[0]).not.toBe(suffixes[1])
  const derived = deriveClaudeRuntimeIdentity(WORKTREE, {}, "host-a").runtimeSessionId
  expect(`ccs-${suffixes[0]}`).not.toBe(derived)
})

test("minting is refused while an unidentified live Claude occupies the directory", async () => {
  const { deps: mintDeps, written } = deps({ claudeProcessesIn: () => [4242] })

  const outcome = await mintRuntimeIdentity({ worktree: WORKTREE, runtimeKind: "claude-code-channel" }, mintDeps)

  expect(outcome.status).toBe("refused")
  expect(outcome.status === "refused" && outcome.reason).toContain("4242")
  expect(written).toEqual([])
})

test("a Claude channel pane in the directory is refusal enough without the process table", async () => {
  const { deps: mintDeps, written } = deps({ claudeProcessesIn: () => [], panes: () => [pane()] })

  const outcome = await mintRuntimeIdentity({ worktree: WORKTREE, runtimeKind: "claude-code-channel" }, mintDeps)

  expect(outcome.status).toBe("refused")
  expect(outcome.status === "refused" && outcome.reason).toContain("%8")
  expect(written).toEqual([])
})

test("a directory the ledger already attests reuses that identity", async () => {
  const { deps: mintDeps, written } = deps({ links: () => [link()] })

  const outcome = await mintRuntimeIdentity({ worktree: WORKTREE, runtimeKind: "claude-code-channel" }, mintDeps)

  expect(outcome).toEqual({
    status: "reused",
    runtimeSessionId: "ccs-ledger",
    instanceId: "cc-ledger",
    worktree: WORKTREE,
    source: "ledger",
  })
  expect(written).toEqual([])
})

test("a directory the identity store records is reused even while a live Claude occupies it", async () => {
  const { deps: mintDeps, written } = deps({
    identities: () => [identity()],
    claudeProcessesIn: () => [4242],
    panes: () => [pane()],
  })

  const outcome = await mintRuntimeIdentity({ worktree: WORKTREE, runtimeKind: "claude-code-channel" }, mintDeps)

  expect(outcome).toEqual({
    status: "reused",
    runtimeSessionId: "ccs-stored",
    instanceId: "cc-stored",
    worktree: WORKTREE,
    source: "store",
  })
  expect(written).toEqual([])
})

test("a mint that lost the create race adopts the winner's identity", async () => {
  const winner = identity({ runtimeSessionId: "ccs-winner", instanceId: "cc-winner" })
  const { deps: mintDeps } = deps({ write: () => ({ status: "exists", existing: winner }) })

  const outcome = await mintRuntimeIdentity({ worktree: WORKTREE, runtimeKind: "claude-code-channel" }, mintDeps)

  expect(outcome).toEqual({
    status: "reused",
    runtimeSessionId: "ccs-winner",
    instanceId: "cc-winner",
    worktree: WORKTREE,
    source: "store",
  })
})

test("a path differing only by symlink resolves to the same record", async () => {
  // The RECORD holds the uncanonical path and the REQUEST the resolved one, so
  // a canonicalizer applied to only the request side cannot pass this.
  const { deps: mintDeps, written } = deps({
    identities: () => [identity({ worktree: "/tmp/x" })],
    canonicalPath: (path) => (path === "/tmp/x" ? "/private/tmp/x" : path),
  })

  const outcome = await mintRuntimeIdentity(
    { worktree: "/private/tmp/x", runtimeKind: "claude-code-channel" },
    mintDeps
  )

  expect(outcome).toEqual({
    status: "reused",
    runtimeSessionId: "ccs-stored",
    instanceId: "cc-stored",
    worktree: "/private/tmp/x",
    source: "store",
  })
  expect(written).toEqual([])
})

test("two mints in unrelated directories do not collide", async () => {
  const suffixes = ["1111111111111111", "2222222222222222"]
  const { deps: mintDeps, written } = deps({ newSuffix: () => suffixes.shift()! })

  const first = await mintRuntimeIdentity({ worktree: "/repo/a", runtimeKind: "claude-code-channel" }, mintDeps)
  const second = await mintRuntimeIdentity({ worktree: "/repo/b", runtimeKind: "claude-code-channel" }, mintDeps)

  expect([first, second]).toEqual([
    {
      status: "minted",
      runtimeSessionId: "ccs-1111111111111111",
      instanceId: "cc-1111111111111111",
      worktree: "/repo/a",
    },
    {
      status: "minted",
      runtimeSessionId: "ccs-2222222222222222",
      instanceId: "cc-2222222222222222",
      worktree: "/repo/b",
    },
  ])
  expect(written.map((record) => record.worktree)).toEqual(["/repo/a", "/repo/b"])
})

test("two identity records naming one worktree refuse instead of minting a third", async () => {
  const { deps: mintDeps, written } = deps({
    identities: () => [identity({ runtimeSessionId: "ccs-one" }), identity({ runtimeSessionId: "ccs-two" })],
  })

  const outcome = await mintRuntimeIdentity({ worktree: WORKTREE, runtimeKind: "claude-code-channel" }, mintDeps)

  expect(outcome).toEqual({
    status: "refused",
    reason: `2 claude-code-channel identity records name ${WORKTREE}: ccs-one, ccs-two`,
  })
  expect(written).toEqual([])
})

test("two harness link records naming one worktree refuse instead of minting a third", async () => {
  const { deps: mintDeps, written } = deps({
    links: () => [link({ runtimeSessionId: "ccs-a" }), link({ runtimeSessionId: "ccs-b" })],
  })

  const outcome = await mintRuntimeIdentity({ worktree: WORKTREE, runtimeKind: "claude-code-channel" }, mintDeps)

  expect(outcome.status).toBe("refused")
  expect(outcome).toMatchObject({ reason: expect.stringContaining("2 harness link records") })
  expect(written).toEqual([])
})

test("a declared id already recorded for another worktree is refused, never rebound", async () => {
  const other = identity({ runtimeSessionId: "ccs-fixed", instanceId: "cc-fixed", worktree: "/repo/threa.other" })
  const { deps: mintDeps } = deps({
    write: () => ({ status: "exists", existing: other }),
  })

  const outcome = await mintRuntimeIdentity(
    {
      worktree: WORKTREE,
      runtimeKind: "claude-code-channel",
      declared: { instanceId: "cc-fixed", runtimeSessionId: "ccs-fixed" },
    },
    mintDeps
  )

  expect(outcome).toEqual({
    status: "refused",
    reason: `ccs-fixed is already recorded for /repo/threa.other, not ${WORKTREE}`,
  })
})

test("a mint whose pane listing fails still refuses on the process table", async () => {
  const warnings: string[] = []
  const { deps: mintDeps, written } = deps({
    panes: () => {
      throw new Error("no server running on /private/tmp/tmux-501/default")
    },
    claudeProcessesIn: () => [4242],
    warn: (message) => void warnings.push(message),
  })

  const outcome = await mintRuntimeIdentity({ worktree: WORKTREE, runtimeKind: "claude-code-channel" }, mintDeps)

  expect(outcome.status).toBe("refused")
  expect(outcome.status === "refused" && outcome.reason).toContain("4242")
  expect(written).toEqual([])
})

test("no tmux server does not block a cold-start mint, but is reported", async () => {
  const warnings: string[] = []
  const { deps: mintDeps, written } = deps({
    panes: () => {
      throw new Error("no server running on /private/tmp/tmux-501/default")
    },
    warn: (message) => void warnings.push(message),
  })

  const outcome = await mintRuntimeIdentity({ worktree: WORKTREE, runtimeKind: "claude-code-channel" }, mintDeps)

  expect(outcome.status).toBe("minted")
  expect(written).toHaveLength(1)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain("process table only")
})

test("a spawn refuses a directory a live Claude already occupies, even an identified one", async () => {
  // The reuse rungs answer "what identity does this directory have", which is
  // right for a backfill and wrong for a launch: reusing an identified live
  // session's id starts a SECOND runtime under it.
  const { deps: mintDeps, written } = deps({
    identities: () => [identity()],
    claudeProcessesIn: () => [4242],
  })

  const outcome = await mintRuntimeIdentity(
    { worktree: WORKTREE, runtimeKind: "claude-code-channel", requireVacant: true },
    mintDeps
  )

  expect(outcome.status).toBe("refused")
  expect(outcome.status === "refused" && outcome.reason).toContain("4242")
  expect(written).toEqual([])
})

test("a live Pi in the directory does not make a Claude spawn non-vacant", async () => {
  // The refusal that motivated per-kind identity: a reusable Pi living in the
  // operator's home directory must not block spawning a Claude there.
  const pi = identity({ runtimeSessionId: "pi-uuid", instanceId: "pi-uuid", runtimeKind: "pi-local" })
  const piPane = pane({
    paneId: "%9",
    panePid: 5151,
    startCommand: "pi --session-id 095ed570-f6ce-4fd6-a33e-ac0d71c4625f",
  })
  const { deps: mintDeps, written } = deps({ identities: () => [pi], panes: () => [piPane] })

  const outcome = await mintRuntimeIdentity(
    { worktree: WORKTREE, runtimeKind: "claude-code-channel", requireVacant: true },
    mintDeps
  )

  expect(outcome).toMatchObject({ status: "minted" })
  expect(written.map((record) => record.runtimeKind)).toEqual(["claude-code-channel"])
})

test("a coexisting runtime's record is neither reused nor grounds to refuse", async () => {
  // Identity is per (directory, runtime kind): a Pi already recorded in the
  // cwd must not block a Claude spawn there, and vice versa — but its id must
  // never be reused, or both pane finders match one session.
  const pi = identity({ runtimeSessionId: "pi-uuid", instanceId: "pi-uuid", runtimeKind: "pi-local" })
  const { deps: mintDeps, written } = deps({ identities: () => [pi] })

  const outcome = await mintRuntimeIdentity({ worktree: WORKTREE, runtimeKind: "claude-code-channel" }, mintDeps)

  expect(outcome).toEqual({
    status: "minted",
    runtimeSessionId: "ccs-abcdef0123456789",
    instanceId: "cc-abcdef0123456789",
    worktree: WORKTREE,
  })
  expect(written.map((record) => record.runtimeKind)).toEqual(["claude-code-channel"])
})

test("a coexisting Pi record does not stop the Claude record from being reused", async () => {
  const pi = identity({ runtimeSessionId: "pi-uuid", instanceId: "pi-uuid", runtimeKind: "pi-local" })
  const { deps: mintDeps } = deps({ identities: () => [pi, identity()] })

  const outcome = await mintRuntimeIdentity({ worktree: WORKTREE, runtimeKind: "claude-code-channel" }, mintDeps)

  expect(outcome).toEqual({
    status: "reused",
    runtimeSessionId: "ccs-stored",
    instanceId: "cc-stored",
    worktree: WORKTREE,
    source: "store",
  })
})
