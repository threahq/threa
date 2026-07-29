import { spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { basename, dirname, resolve, sep } from "node:path"
import { canonicalOrRaw } from "./discovery"
import { die } from "./errors"
import { DEFAULT_PROFILE, expandLayout, type Profile } from "./profiles"
import { output, run } from "./shell"
import type { ManagedAgent, SpawnOptions } from "./types"

/**
 * Setup can be a full monorepo install; teardown runs while `resume-active.lock`
 * is held, so a hang there blocks every revive — the same reasoning as
 * `REMOVE_TIMEOUT_MS` in `archive-wind-down.ts`.
 */
const SETUP_TIMEOUT_MS = 600_000
const TEARDOWN_TIMEOUT_MS = 120_000

/**
 * Where {@link provisionWorkspace} will put this agent, without creating
 * anything — and the single definition of that path, so a caller that has to
 * name the directory before it exists cannot drift from the one that creates it.
 *
 * The parent is canonicalized and the leaf appended, rather than canonicalizing
 * the whole path: the leaf does not exist yet, so `realpathSync` would throw and
 * fall back to the raw path — which then fails to match the resolved path every
 * later reader sees once the directory does exist.
 */
export function plannedWorktreePath(options: SpawnOptions, profile: Profile = DEFAULT_PROFILE): string {
  if (profile.provision === "existing") {
    return canonicalOrRaw(resolve(options.cwd ?? die("this profile provisions no directory; pass --cwd")))
  }
  const repo = resolve(options.repo ?? process.cwd())
  const parent = canonicalOrRaw(dirname(repo))
  const leaf = expandLayout(profile.layout, { name: options.name, repo: basename(repo) })
  const path = resolve(parent, leaf)
  if (path !== parent && !path.startsWith(parent + sep)) {
    die(`profile '${profile.name}': layout '${profile.layout}' resolves outside ${parent}`)
  }
  return path
}

function branchFor(options: SpawnOptions): string {
  return options.branch ?? options.name
}

export function provisionWorkspace(
  options: SpawnOptions,
  profile: Profile = DEFAULT_PROFILE
): { worktree: string; branch: string } {
  return profile.provision === "existing" ? useExistingDirectory(options, profile) : createWorktree(options, profile)
}

function useExistingDirectory(options: SpawnOptions, profile: Profile): { worktree: string; branch: string } {
  if (options.cwd === undefined) die(`profile '${profile.name}' provisions nothing; pass --cwd <path>`)
  const dir = plannedWorktreePath(options, profile)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) die(`directory not found: ${dir}`)
  console.log(`harnessd: using existing directory ${dir} (profile '${profile.name}')`)
  runSetupCommands(dir, profile.setup, options.skipSetup === true)
  return { worktree: dir, branch: options.branch ?? currentBranch(dir) ?? options.name }
}

function createWorktree(
  options: SpawnOptions,
  profile: Profile & { provision: "worktree" }
): { worktree: string; branch: string } {
  if (options.cwd !== undefined) die(`profile '${profile.name}' creates a worktree; --cwd cannot apply to it`)
  const repo = resolve(options.repo ?? process.cwd())
  const branch = branchFor(options)
  const base = options.base ?? profile.base
  const worktree = plannedWorktreePath(options, profile)
  if (!existsSync(repo)) die(`repo not found: ${repo}`)
  if (existsSync(worktree)) die(`worktree dir already exists: ${worktree}`)

  console.log(`harnessd: fetching ${base} in ${repo}`)
  run(["git", "-C", repo, "fetch", "origin", base.replace(/^origin\//, "")])
  console.log(`harnessd: creating worktree ${worktree} (${branch} off ${base})`)
  run(["git", "-C", repo, "worktree", "add", "-b", branch, worktree, base])
  runSetupCommands(worktree, profile.setup, options.skipSetup === true)
  return { worktree, branch }
}

/** The Pi orchestrator directory is not a repo, and `SpawnResult.branch` is required. */
function currentBranch(dir: string): string | undefined {
  const result = output(["git", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true })
  if (result.exitCode !== 0) return undefined
  const branch = result.stdout.trim()
  return branch && branch !== "HEAD" ? branch : undefined
}

export function restorableWorktreeSource(
  agent: ManagedAgent
): { repo: string; worktree: string; branch: string } | { reason: string } {
  if (!agent.worktree) return { reason: "no worktree path recorded" }
  if (!agent.branch) return { reason: "no branch recorded" }
  const repoFlag = agent.command.indexOf("--repo")
  const repo = repoFlag >= 0 ? agent.command[repoFlag + 1] : undefined
  if (!repo) return { reason: "no source repo recorded" }
  if (!existsSync(repo)) return { reason: `source repo missing: ${repo}` }
  return { repo, worktree: agent.worktree, branch: agent.branch }
}

export function restoreManagedWorktree(
  agent: ManagedAgent,
  profile: Profile = DEFAULT_PROFILE
): { restored: boolean; reason?: string } {
  if (agent.worktree && existsSync(agent.worktree)) return { restored: false }
  const source = restorableWorktreeSource(agent)
  if ("reason" in source) return { restored: false, reason: source.reason }

  output(["git", "-C", source.repo, "worktree", "prune"], { allowFailure: true })
  const result = output(["git", "-C", source.repo, "worktree", "add", source.worktree, source.branch], {
    allowFailure: true,
  })
  if (result.exitCode !== 0) {
    return { restored: false, reason: result.stderr.trim() || `could not restore ${source.branch}` }
  }
  runSetupCommands(source.worktree, profile.setup, agent.command.includes("--skip-setup"))
  return { restored: true }
}

function runProfileCommands(
  cwd: string,
  commands: string[],
  label: string,
  timeoutMs: number,
  skip = false
): { ok: boolean; reason?: string } {
  if (commands.length === 0) return { ok: true }
  if (skip) {
    console.warn(`harnessd: --skip-setup: skipping ${commands.length} ${label} command(s)`)
    return { ok: true }
  }
  for (const command of commands) {
    console.log(`harnessd: running ${label}: ${command}`)
    // killSignal: spawnSync's timeout signals but never escalates, so a command
    // that traps SIGTERM blocks the reap sweep — and everything waiting on the
    // lock it holds — for as long as it likes.
    const result = spawnSync("sh", ["-c", command], {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      stdio: "inherit",
    })
    if (result.error || result.signal !== null || result.status !== 0) {
      const detail = result.signal
        ? `timed out or was killed (${result.signal}) after ${timeoutMs}ms`
        : (result.error?.message ?? `exit code ${result.status}`)
      return { ok: false, reason: `${label} command '${command}' ${detail}` }
    }
  }
  return { ok: true }
}

/**
 * Setup failures warn and continue, as they always have. Teardown failures do
 * not: {@link reapLink} is about to destroy the directory, and a teardown that
 * did not run is not a teardown that had nothing to do.
 */
export function runSetupCommands(cwd: string, commands: string[], skip = false): void {
  const result = runProfileCommands(cwd, commands, "setup", SETUP_TIMEOUT_MS, skip)
  if (!result.ok) console.warn(`harnessd: ${result.reason}; continuing`)
}

export function runTeardownCommands(
  cwd: string,
  commands: string[],
  timeoutMs = TEARDOWN_TIMEOUT_MS
): { ok: boolean; reason?: string } {
  return runProfileCommands(cwd, commands, "teardown", timeoutMs)
}
