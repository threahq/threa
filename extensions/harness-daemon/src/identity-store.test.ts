import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  identityStoreDir,
  readMintedIdentities,
  readMintedIdentity,
  writeMintedIdentity,
  type MintedIdentity,
  identityRecordsFor,
  profileForWorktree,
  recordProfileSnapshot,
} from "./identity-store"
import { DEFAULT_PROFILE, UNKNOWN_PROFILE, type Profile } from "./profiles"

let dir: string
const previous = process.env.THREA_HARNESSD_IDENTITIES_DIR

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "harnessd-identities-")), "identities")
  process.env.THREA_HARNESSD_IDENTITIES_DIR = dir
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (previous === undefined) delete process.env.THREA_HARNESSD_IDENTITIES_DIR
  else process.env.THREA_HARNESSD_IDENTITIES_DIR = previous
})

function record(overrides: Partial<MintedIdentity> = {}): MintedIdentity {
  return {
    runtimeSessionId: "ccs-0123456789abcdef",
    instanceId: "cc-0123456789abcdef",
    worktree: "/repo/threa.feature",
    runtimeKind: "claude-code-channel",
    mintedAt: "2026-07-29T00:00:00.000Z",
    source: "mint",
    ...overrides,
  }
}

test("a created record reads back with the fields that were written", () => {
  const written = record()

  const result = writeMintedIdentity(written)

  expect(result).toEqual({ status: "created", record: written })
  expect(readMintedIdentity(written.runtimeSessionId)).toEqual(written)
})

test("a second create for one runtime session id reports exists and returns the stored record", () => {
  const first = record()
  writeMintedIdentity(first)

  const result = writeMintedIdentity(record({ instanceId: "cc-second", worktree: "/repo/other" }))

  expect(result).toEqual({ status: "exists", existing: first })
})

test("a runtime session id that is not a safe filename is refused, never sanitized", () => {
  mkdirSync(dir, { recursive: true })

  const escape = writeMintedIdentity(record({ runtimeSessionId: "../escape" }))
  const empty = writeMintedIdentity(record({ runtimeSessionId: "" }))

  expect([escape.status, empty.status]).toEqual(["refused", "refused"])
  expect(readdirSync(dir)).toEqual([])
  expect(existsSync(join(dir, "..", "escape.json"))).toBe(false)
})

test("a malformed record file is skipped rather than aborting the sweep", () => {
  const good = record()
  writeMintedIdentity(good)
  writeFileSync(join(dir, "ccs-broken.json"), "{ not json")

  expect(readMintedIdentities()).toEqual([good])
})

test("the store honours THREA_HARNESSD_IDENTITIES_DIR and defaults under ~/.threa/harnessd", () => {
  expect(identityStoreDir()).toBe(dir)

  delete process.env.THREA_HARNESSD_IDENTITIES_DIR
  expect(identityStoreDir()).toBe(join(homedir(), ".threa", "harnessd", "identities"))
  process.env.THREA_HARNESSD_IDENTITIES_DIR = dir
})

test("an ambiguous or unreadable profile resolves to nothing-destructive, never to the default", () => {
  // The default commits, pushes and reclaims, so failing open to it escalates
  // "I do not know" into the most destructive policy there is.
  const base = {
    instanceId: "cc-a",
    worktree: "/repo/threa.x",
    runtimeKind: "claude-code-channel",
    mintedAt: "2026-07-29T00:00:00.000Z",
    source: "mint" as const,
  }
  const quiet: Profile = { name: "quiet", provision: "existing", preserve: "none", setup: [], teardown: [] }

  expect(profileForWorktree("/repo/threa.x", [], (path) => path)).toEqual(DEFAULT_PROFILE)
  expect(
    profileForWorktree("/repo/threa.x", [{ ...base, runtimeSessionId: "ccs-a", profile: quiet }], (p) => p)
  ).toEqual(quiet)
  expect(
    profileForWorktree(
      "/repo/threa.x",
      [
        { ...base, runtimeSessionId: "ccs-a", profile: quiet },
        { ...base, runtimeSessionId: "ccs-b", profile: quiet },
      ],
      (path) => path
    )
  ).toEqual(UNKNOWN_PROFILE)
  expect(
    profileForWorktree("/repo/threa.x", [{ ...base, runtimeSessionId: "ccs-a", profileUnreadable: true }], (p) => p)
  ).toEqual(UNKNOWN_PROFILE)
})

test("a respawn supersedes the directory's record instead of adding a second", () => {
  recordProfileSnapshot({
    worktree: "/repo/threa.y",
    runtimeSessionId: "pi-one",
    runtimeKind: "pi-local",
    profile: { name: "q", provision: "existing", preserve: "none", setup: [], teardown: [] },
  })
  recordProfileSnapshot({
    worktree: "/repo/threa.y",
    runtimeSessionId: "pi-two",
    runtimeKind: "pi-local",
    profile: { name: "q", provision: "existing", preserve: "none", setup: [], teardown: [] },
  })

  expect(identityRecordsFor("/repo/threa.y").map((record) => record.runtimeSessionId)).toEqual(["pi-two"])
  expect(profileForWorktree("/repo/threa.y").preserve).toBe("none")
})
