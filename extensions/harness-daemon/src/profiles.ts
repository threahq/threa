import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve, sep } from "node:path"
import { DEFAULT_WIND_DOWN_POLICY, PRESERVE_RUNGS, type PreserveRung, type WindDownPolicy } from "./archive-wind-down"
import { die } from "./errors"

export { PRESERVE_RUNGS, type PreserveRung, type WindDownPolicy }

interface ProfileCommon {
  name: string
  setup: string[]
  teardown: string[]
  displayName?: string
}

/**
 * `reclaim` exists only on the rung a successful push can precede. Cleanup may
 * only destroy what setup created, so the two shapes that cannot have created a
 * directory — and the rungs that stop before the push — carry no field to read.
 */
type WorktreeCleanup = { preserve: "commit+push"; reclaim: boolean } | { preserve: "none" | "commit" }

export type Profile =
  | (ProfileCommon & { provision: "existing"; preserve: PreserveRung })
  | (ProfileCommon & { provision: "worktree"; layout: string; base: string } & WorktreeCleanup)

export const DEFAULT_PROFILE: Profile = {
  name: "default",
  provision: "worktree",
  layout: "threa.${name}",
  base: "origin/main",
  setup: ["bun run setup:worktree"],
  teardown: [],
  preserve: "commit+push",
  reclaim: true,
}

/**
 * What a directory is cleaned up under when the evidence does not say.
 *
 * Deliberately NOT the built-in default: the default commits, pushes and
 * reclaims, so failing open to it escalates an unreadable or contradictory
 * snapshot into the most destructive policy there is. Nothing is the only safe
 * answer to "I do not know".
 */
export const UNKNOWN_PROFILE: Profile = {
  name: "unknown",
  provision: "existing",
  preserve: "none",
  setup: [],
  teardown: [],
}

/**
 * `--cwd` with no named profile: use the folder and touch nothing.
 *
 * `commit+push` here would `git add -A`, wip-commit and push a checkout harnessd
 * did not create — PROTECTED_BRANCHES only covers main/master/HEAD, so every
 * feature branch in a main working tree is exposed. The user's requirement was
 * the opposite: no cleanup in the repo main checkouts or the orchestrator
 * directory. Someone who does want that declares a named profile and says so.
 */
export const CWD_PROFILE: Profile = {
  name: "cwd",
  provision: "existing",
  preserve: "none",
  setup: [],
  teardown: [],
}

export function windDownPolicyFor(profile: Profile): WindDownPolicy {
  if (profile.provision === "worktree" && profile.preserve === "commit+push") {
    return { preserve: "commit+push", reclaim: profile.reclaim }
  }
  return { preserve: profile.preserve, reclaim: false }
}

export function profilesPath(): string {
  return process.env.THREA_HARNESSD_PROFILES || join(homedir(), ".threa", "harnessd", "profiles.json")
}

export type ParseProfilesResult =
  | { status: "ok"; profiles: Record<string, Profile> }
  | { status: "invalid"; errors: string[] }

const RULE = "cleanup may only destroy what setup created"
const PROVISIONS = new Set(["existing", "worktree"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function commandList(raw: unknown, field: string, name: string, errors: string[]): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    errors.push(`profile '${name}': ${field} must be an array of command strings`)
    return []
  }
  return raw as string[]
}

/**
 * The layout is a template, so it cannot be resolved against a real repo here.
 * It is resolved against a probe parent instead: a template that escapes the
 * probe escapes every parent, and one that does not escapes none.
 */
export function layoutEscapesParent(layout: string): boolean {
  if (isAbsolute(layout)) return true
  const parent = resolve(sep, "harnessd-layout-probe")
  const resolved = resolve(parent, expandLayout(layout, { name: "a", repo: "b" }))
  return resolved !== parent && !resolved.startsWith(parent + sep)
}

export function expandLayout(layout: string, values: { name: string; repo: string }): string {
  return layout.replaceAll("${name}", values.name).replaceAll("${repo}", values.repo)
}

function parseProfile(name: string, raw: unknown, errors: string[]): Profile | undefined {
  if (!isRecord(raw)) {
    errors.push(`profile '${name}': must be an object`)
    return undefined
  }
  const before = errors.length
  const provision = raw.provision
  if (typeof provision !== "string" || !PROVISIONS.has(provision)) {
    errors.push(`profile '${name}': provision must be 'existing' or 'worktree'`)
    return undefined
  }
  const preserve = raw.preserve
  if (typeof preserve !== "string" || !(PRESERVE_RUNGS as readonly string[]).includes(preserve)) {
    errors.push(`profile '${name}': preserve must be one of ${PRESERVE_RUNGS.join(", ")}`)
  }
  if (raw.displayName !== undefined && typeof raw.displayName !== "string") {
    errors.push(`profile '${name}': displayName must be a string`)
  }
  const setup = commandList(raw.setup, "setup", name, errors)
  const teardown = commandList(raw.teardown, "teardown", name, errors)
  const common: ProfileCommon = {
    name,
    setup,
    teardown,
    ...(typeof raw.displayName === "string" ? { displayName: raw.displayName } : {}),
  }

  if (provision === "existing") {
    if ("reclaim" in raw) {
      errors.push(
        `profile '${name}': reclaim is not available under provision 'existing' — ${RULE}, and this profile creates nothing`
      )
    }
    for (const field of ["layout", "base"] as const) {
      if (field in raw) {
        errors.push(`profile '${name}': ${field} is not available under provision 'existing' — nothing is created`)
      }
    }
    if (errors.length > before) return undefined
    return { ...common, provision: "existing", preserve: preserve as PreserveRung }
  }

  if (typeof raw.layout !== "string" || !raw.layout) {
    errors.push(`profile '${name}': provision 'worktree' requires a layout template`)
  } else if (layoutEscapesParent(raw.layout)) {
    errors.push(`profile '${name}': layout '${raw.layout}' resolves outside the repo's parent directory`)
  }
  if (typeof raw.base !== "string" || !raw.base) {
    errors.push(`profile '${name}': provision 'worktree' requires a base ref`)
  }
  if (preserve === "commit+push") {
    if (typeof raw.reclaim !== "boolean") {
      errors.push(`profile '${name}': reclaim must be stated as true or false at the 'commit+push' rung`)
    }
  } else if ("reclaim" in raw) {
    errors.push(
      `profile '${name}': reclaim is not available below the 'commit+push' rung — ${RULE}, and nothing below it pushes`
    )
  }
  if (errors.length > before) return undefined

  const worktree = { ...common, provision: "worktree" as const, layout: raw.layout as string, base: raw.base as string }
  return preserve === "commit+push"
    ? { ...worktree, preserve: "commit+push", reclaim: raw.reclaim as boolean }
    : { ...worktree, preserve: preserve as "none" | "commit" }
}

/** A single profile value, keyed by its own recorded `name`. Used to re-read a snapshot. */
export function parseProfileSnapshot(raw: unknown): Profile | undefined {
  if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name) return undefined
  const errors: string[] = []
  const profile = parseProfile(raw.name, raw, errors)
  return errors.length === 0 ? profile : undefined
}

/** Every error, never the first: a config fixed one line at a time is fixed by guesswork. */
export function parseProfiles(value: unknown): ParseProfilesResult {
  if (!isRecord(value)) return { status: "invalid", errors: ["profiles must be a JSON object of name -> profile"] }
  const errors: string[] = []
  const profiles: Record<string, Profile> = {}
  for (const [name, raw] of Object.entries(value)) {
    const profile = parseProfile(name, raw, errors)
    if (profile) profiles[name] = profile
  }
  return errors.length > 0 ? { status: "invalid", errors } : { status: "ok", profiles }
}

export type ReadProfilesResult =
  | { status: "ok"; path: string; profiles: Record<string, Profile>; present: boolean }
  | { status: "invalid"; path: string; errors: string[] }

/** Reports rather than throws, so `doctor` can show a broken file before anything needs it. */
export function inspectProfiles(path = profilesPath()): ReadProfilesResult {
  if (!existsSync(path)) return { status: "ok", path, profiles: {}, present: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    return { status: "invalid", path, errors: [`could not read ${path}: ${error}`] }
  }
  const result = parseProfiles(parsed)
  return result.status === "ok"
    ? { status: "ok", path, profiles: result.profiles, present: true }
    : { status: "invalid", path, errors: result.errors }
}

/** Dies with the full error list. A profiles file that failed to parse is never an empty fleet. */
export function readProfiles(path = profilesPath()): Record<string, Profile> {
  const result = inspectProfiles(path)
  if (result.status === "invalid") {
    die(`harnessd: invalid profiles in ${result.path}:\n  ${result.errors.join("\n  ")}`)
  }
  return result.profiles
}

/**
 * A named-but-missing profile dies: silently provisioning the default under a
 * name the user chose is the no-op this feature exists to remove.
 */
export function selectProfile(
  options: { profile?: string; cwd?: string },
  profiles: Record<string, Profile> = readProfiles()
): Profile {
  if (options.profile) {
    const found = profiles[options.profile]
    if (!found) {
      const known = Object.keys(profiles)
      die(
        `harnessd: no profile named '${options.profile}' in ${profilesPath()}${known.length > 0 ? ` (known: ${known.join(", ")})` : ""}`
      )
    }
    // Before the mint, not inside the provisioner: `plannedWorktreePath` would
    // otherwise fall back to the daemon's own cwd for a worktree profile with no
    // --repo, and mint a durable identity for an unrelated directory on the way
    // to dying.
    if (options.cwd && found.provision === "worktree") {
      die(`harnessd: profile '${options.profile}' provisions a worktree; --cwd cannot apply to it`)
    }
    return found
  }
  return options.cwd ? CWD_PROFILE : DEFAULT_PROFILE
}

export { DEFAULT_WIND_DOWN_POLICY }
