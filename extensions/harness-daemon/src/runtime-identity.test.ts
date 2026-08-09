import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HarnessLink } from "@threa/bot-runtime-client"
import { attestedRuntimes, resolveRuntimeIdentity, runtimeIdentityFor, type LocalTmuxPane } from "./discovery"
import type { MintedIdentity, WriteMintedIdentityResult } from "./identity-store"
import { mintRuntimeIdentity, type MintDeps } from "./mint"
import { deriveClaudeRuntimeIdentity, sanitizeId } from "./spawners"

const CWD = "/repo/threa.feature"
const HOST = "resolver-test-host"
const raw = (path: string) => path

let root: string
const saved = ["THREA_HARNESSD_IDENTITIES_DIR", "THREA_HARNESS_LINKS_DIR", "THREA_HARNESSD_INVENTORY"].map(
  (name) => [name, process.env[name]] as const
)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnessd-resolver-"))
  process.env.THREA_HARNESSD_IDENTITIES_DIR = join(root, "identities")
  process.env.THREA_HARNESS_LINKS_DIR = join(root, "links")
  process.env.THREA_HARNESSD_INVENTORY = join(root, "inventory.sqlite")
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

function pane(overrides: Partial<LocalTmuxPane> = {}): LocalTmuxPane {
  return {
    sessionName: "threa-agents",
    windowName: "feature",
    windowId: "@7",
    paneId: "%8",
    panePid: 4242,
    cwd: CWD,
    startCommand:
      "env THREA_INSTANCE_ID=cc-declared THREA_RUNTIME_SESSION_ID=ccs-declared claude --dangerously-load-development-channels server:threa-channel",
    ...overrides,
  }
}

function link(overrides: Partial<HarnessLink> = {}): HarnessLink {
  return {
    runtimeKind: "claude-code-channel",
    runtimeSessionId: "ccs-ledger",
    instanceId: "cc-ledger",
    rootStreamId: "stream_root",
    worktree: CWD,
    pid: 4242,
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  }
}

function identity(overrides: Partial<MintedIdentity> = {}): MintedIdentity {
  return {
    runtimeSessionId: "ccs-minted",
    instanceId: "cc-minted",
    worktree: CWD,
    runtimeKind: "claude-code-channel",
    mintedAt: "2026-07-29T00:00:00.000Z",
    source: "mint",
    ...overrides,
  }
}

function resolve(evidence: Parameters<typeof resolveRuntimeIdentity>[1]) {
  return resolveRuntimeIdentity(CWD, { canonical: raw, ...evidence }, {}, HOST)
}

test("a pane's own declared environment beats every other source", () => {
  expect(
    runtimeIdentityFor({
      cwd: CWD,
      pane: pane(),
      agent: { instanceId: "cc-row", runtimeSessionId: "ccs-row" },
      identities: [identity()],
      attested: attestedRuntimes([link()], raw),
      host: HOST,
      canonical: raw,
    })
  ).toEqual({ instanceId: "cc-declared", runtimeSessionId: "ccs-declared", source: "declared" })
})

test("a minted record beats the ledger for the same directory", () => {
  expect(resolve({ identities: [identity()], attested: attestedRuntimes([link()], raw) })).toEqual({
    instanceId: "cc-minted",
    runtimeSessionId: "ccs-minted",
    source: "minted",
  })
})

test("a coexisting Pi's record does not make the Claude namespace ambiguous", () => {
  // Kind-blind, the two records read as a conflicted directory and the
  // resolver falls through — past the minted rung this store exists to serve.
  const pi = identity({ runtimeSessionId: "pi-uuid", instanceId: "pi-uuid", runtimeKind: "pi-local" })

  expect(resolve({ identities: [pi, identity()] })).toEqual({
    instanceId: "cc-minted",
    runtimeSessionId: "ccs-minted",
    source: "minted",
  })
})

test("the ledger beats a stale inventory row", () => {
  // Inventory rows are immutable per launch, so the row is stale by
  // construction the moment anything re-identifies the directory.
  expect(
    resolve({
      identities: [],
      attested: attestedRuntimes([link()], raw),
      inventory: { instanceId: "cc-row", runtimeSessionId: "ccs-row" },
    })
  ).toEqual({ instanceId: "cc-ledger", runtimeSessionId: "ccs-ledger", source: "ledger" })
})

test("derivation is the last rung and is reported as such", () => {
  const derived = deriveClaudeRuntimeIdentity(CWD, {}, HOST)

  expect(resolve({ identities: [], attested: [] })).toEqual({ ...derived, source: "derived" })
})

test("two ledger records naming one worktree fall through instead of picking one", () => {
  const derived = deriveClaudeRuntimeIdentity(CWD, {}, HOST)
  const rivals = attestedRuntimes([link(), link({ runtimeSessionId: "ccs-rival", instanceId: "cc-rival" })], raw)

  expect(resolve({ identities: [], attested: rivals })).toEqual({ ...derived, source: "derived" })
})

test("the resolver answers for a directory a mint would refuse", async () => {
  // Occupancy is the mint's veto and belongs to the write side. A read path
  // that could refuse would make "what identity does this directory have"
  // answerable only when a new process is allowed to start there.
  const mintDeps: MintDeps = {
    identities: () => [],
    links: () => [],
    panes: () => [],
    claudeProcessesIn: () => [4242],
    canonicalPath: raw,
    write: (record): WriteMintedIdentityResult => ({ status: "created", record }),
    newSuffix: () => "f00dfeedbaadc0de",
    now: () => new Date("2026-07-29T00:00:00.000Z"),
    warn: () => {},
  }

  const minted = await mintRuntimeIdentity({ worktree: CWD, runtimeKind: "claude-code-channel" }, mintDeps)

  expect(minted.status).toBe("refused")
  expect(resolve({ identities: [], attested: [] })).toMatchObject({
    runtimeSessionId: deriveClaudeRuntimeIdentity(CWD, {}, HOST).runtimeSessionId,
    source: "derived",
  })
})

test("identity ids are sanitized and truncated once, at the resolver", () => {
  const declared = ["ccs", "x".repeat(33), "y".repeat(32)].join(" ")
  expect(declared).toHaveLength(70)

  // Exactly what `reconnect` produced before it delegated: sanitize, then cut.
  const normalized = `ccs-${"x".repeat(33)}-${"y".repeat(26)}`
  expect(normalized).toBe(sanitizeId(declared).slice(0, 64))

  expect(resolve({ declared: { instanceId: declared, runtimeSessionId: declared } })).toEqual({
    instanceId: normalized,
    runtimeSessionId: normalized,
    source: "declared",
  })
})

test("a recorded id is returned verbatim, never rewritten to fit the sanitizer", () => {
  // The link and identity stores allow dots and impose no length cap, and both
  // key their files by this id. Normalizing it on the way out maps two distinct
  // sessions onto one — the failure `isSafeSessionFileName` refuses by design.
  const dotted = resolveRuntimeIdentity(CWD, {
    attested: [{ worktree: CWD, runtimeSessionId: "ccs.abc", instanceId: "cc.abc" }],
  })

  expect(dotted).toEqual({ runtimeSessionId: "ccs.abc", instanceId: "cc.abc", source: "ledger" })

  const long = "ccs-" + "a".repeat(80)
  const untruncated = resolveRuntimeIdentity(CWD, {
    identities: [
      {
        runtimeSessionId: long,
        instanceId: "cc-long",
        worktree: CWD,
        runtimeKind: "claude-code-channel",
        mintedAt: "2026-07-29T00:00:00.000Z",
        source: "mint",
      },
    ],
  })

  expect(untruncated.runtimeSessionId).toBe(long)
})
