import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CWD_PROFILE,
  DEFAULT_PROFILE,
  parseProfiles,
  profilesPath,
  readProfiles,
  selectProfile,
  windDownPolicyFor,
  type Profile,
} from "./profiles"

let root: string
let savedProfilesEnv: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnessd-profiles-"))
  savedProfilesEnv = process.env.THREA_HARNESSD_PROFILES
  process.env.THREA_HARNESSD_PROFILES = join(root, "profiles.json")
})

afterEach(() => {
  if (savedProfilesEnv === undefined) delete process.env.THREA_HARNESSD_PROFILES
  else process.env.THREA_HARNESSD_PROFILES = savedProfilesEnv
  rmSync(root, { recursive: true, force: true })
})

function errorsFor(value: unknown): string[] {
  const result = parseProfiles(value)
  if (result.status === "ok") throw new Error(`expected invalid, got ${JSON.stringify(result.profiles)}`)
  return result.errors
}

function okProfiles(value: unknown): Record<string, Profile> {
  const result = parseProfiles(value)
  if (result.status === "invalid") throw new Error(`expected ok, got ${result.errors.join("; ")}`)
  return result.profiles
}

describe("parseProfiles", () => {
  test("reclaim under provision: existing is rejected at config time with a named error", () => {
    const errors = errorsFor({ pi: { provision: "existing", preserve: "commit+push", reclaim: true } })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("profile 'pi'")
    expect(errors[0]).toContain("reclaim is not available under provision 'existing'")
    expect(errors[0]).toContain("cleanup may only destroy what setup created")
  })

  test("reclaim: false under provision: existing is rejected too — not offered is not defaulted to false", () => {
    const errors = errorsFor({ pi: { provision: "existing", preserve: "commit+push", reclaim: false } })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("reclaim is not available under provision 'existing'")
  })

  test("reclaim: true below the commit+push rung is rejected", () => {
    // The shape two adversarial reviewers found: it satisfies "no removal
    // without a successful push" while destroying the uncommitted work.
    const errors = errorsFor({
      wt: { provision: "worktree", layout: "threa.${name}", base: "origin/main", preserve: "commit", reclaim: true },
    })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("reclaim is not available below the 'commit+push' rung")
  })

  test("an unknown preserve rung is rejected, never coerced", () => {
    const errors = errorsFor({
      wt: { provision: "worktree", layout: "threa.${name}", base: "origin/main", preserve: "push" },
    })
    expect(errors[0]).toContain("preserve must be one of none, commit, commit+push")
  })

  test("a worktree profile missing layout or base is rejected", () => {
    expect(errorsFor({ a: { provision: "worktree", base: "origin/main", preserve: "none" } })[0]).toContain(
      "requires a layout template"
    )
    expect(errorsFor({ a: { provision: "worktree", layout: "x.${name}", preserve: "none" } })[0]).toContain(
      "requires a base ref"
    )
  })

  test("a layout escaping the repo's parent directory is rejected", () => {
    const errors = errorsFor({
      esc: { provision: "worktree", layout: "../../${name}", base: "origin/main", preserve: "none" },
    })
    expect(errors[0]).toContain("resolves outside the repo's parent directory")
    expect(
      errorsFor({ abs: { provision: "worktree", layout: "/tmp/${name}", base: "origin/main", preserve: "none" } })[0]
    ).toContain("resolves outside")
  })

  test("an invalid profiles file dies with every error, not the first", () => {
    const errors = errorsFor({
      one: { provision: "existing", preserve: "commit+push", reclaim: true },
      two: { provision: "worktree", layout: "x.${name}", base: "origin/main", preserve: "commit", reclaim: true },
      three: { provision: "nonsense" },
    })
    expect(errors).toHaveLength(3)
    expect(errors.map((error) => error.split(":")[0])).toEqual(["profile 'one'", "profile 'two'", "profile 'three'"])
  })

  test("setup and teardown accept arbitrary commands", () => {
    const profiles = okProfiles({
      dev: {
        provision: "existing",
        preserve: "none",
        setup: ["docker compose up -d", "bun install"],
        teardown: ["docker compose down"],
      },
    })
    expect(profiles.dev).toEqual({
      name: "dev",
      provision: "existing",
      preserve: "none",
      setup: ["docker compose up -d", "bun install"],
      teardown: ["docker compose down"],
    })
  })
})

describe("the built-in default", () => {
  test("reproduces today's layout, base and setup", () => {
    expect(DEFAULT_PROFILE).toEqual({
      name: "default",
      provision: "worktree",
      layout: "threa.${name}",
      base: "origin/main",
      setup: ["bun run setup:worktree"],
      teardown: [],
      preserve: "commit+push",
      reclaim: true,
    })
    expect(windDownPolicyFor(DEFAULT_PROFILE)).toEqual({ preserve: "commit+push", reclaim: true })
  })
})

describe("windDownPolicyFor", () => {
  test("every existing profile yields a policy that cannot reclaim", () => {
    const profiles = okProfiles({
      a: { provision: "existing", preserve: "none" },
      b: { provision: "existing", preserve: "commit" },
      c: { provision: "existing", preserve: "commit+push" },
    })
    for (const profile of [...Object.values(profiles), CWD_PROFILE]) {
      expect(windDownPolicyFor(profile).reclaim).toBe(false)
    }
  })

  test("a worktree profile below commit+push cannot reclaim either", () => {
    const profiles = okProfiles({
      keep: { provision: "worktree", layout: "x.${name}", base: "origin/main", preserve: "commit" },
    })
    expect(windDownPolicyFor(profiles.keep!)).toEqual({ preserve: "commit", reclaim: false })
  })
})

describe("readProfiles", () => {
  test("an absent file is no profiles, not an error", () => {
    expect(readProfiles()).toEqual({})
  })

  test("an invalid file dies with the whole error list rather than falling back to none", () => {
    writeFileSync(
      profilesPath(),
      JSON.stringify({
        one: { provision: "existing", preserve: "commit+push", reclaim: true },
        two: { provision: "worktree", layout: "x.${name}", base: "origin/main", preserve: "commit", reclaim: true },
      })
    )
    expect(() => readProfiles()).toThrow(/reclaim is not available under provision 'existing'/)
    expect(() => readProfiles()).toThrow(/reclaim is not available below the 'commit\+push' rung/)
  })

  test("unparseable JSON dies rather than reading as an empty fleet", () => {
    writeFileSync(profilesPath(), "{ not json")
    expect(() => readProfiles()).toThrow(/could not read/)
  })
})

describe("selectProfile", () => {
  test("a named-but-missing profile dies rather than silently falling back", () => {
    expect(() => selectProfile({ profile: "nope" }, {})).toThrow(/no profile named 'nope'/)
  })

  test("a named profile is selected", () => {
    const profiles = okProfiles({ pi: { provision: "existing", preserve: "none" } })
    expect(selectProfile({ profile: "pi" }, profiles)).toBe(profiles.pi!)
  })

  test("no name falls back to the built-in default, and --cwd to the existing-directory profile", () => {
    expect(selectProfile({}, {})).toBe(DEFAULT_PROFILE)
    expect(selectProfile({ cwd: "/some/dir" }, {})).toBe(CWD_PROFILE)
  })
})

test("a bare --cwd session preserves nothing, not just reclaims nothing", () => {
  // commit+push here would `git add -A`, wip-commit and push a checkout harnessd
  // did not create. PROTECTED_BRANCHES covers only main/master/HEAD, so every
  // feature branch in a main working tree would be exposed.
  expect(selectProfile({ cwd: "/repo" }, {})).toMatchObject({ provision: "existing", preserve: "none" })
  expect(windDownPolicyFor(selectProfile({ cwd: "/repo" }, {}))).toEqual({ preserve: "none", reclaim: false })
})

test("--cwd against a profile that provisions a worktree is refused before anything is minted", () => {
  expect(() => selectProfile({ cwd: "/repo", profile: "wt" }, { wt: DEFAULT_PROFILE })).toThrow(/cannot apply/)
})
