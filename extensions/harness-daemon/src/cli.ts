import { resolve } from "node:path"
import type { AdoptOptions } from "./adopt"
import { die } from "./errors"
import type { ReconnectOptions } from "./reconnect"
import type { ResumeOptions, RuntimeKind, SpawnOptions } from "./types"

export function usage(): never {
  console.log(`threa-harnessd

Usage:
  threa-harnessd spawn <pi|claude> --name <name> [--branch <ref>] [--repo <path>] [--tmux <session>] [--skip-setup]
  threa-harnessd do <natural language command>
  threa-harnessd list
  threa-harnessd up [--tmux <session>] [--dry-run] [--recreate-worktree]
  threa-harnessd resume-active                (alias of up; also revive-unarchived, restore-active)
  threa-harnessd reap [--dry-run]             (clean up worktrees whose scratchpad was archived while nothing was running)
  threa-harnessd watch-unarchived [--tmux <session>] [--dry-run]
  threa-harnessd boot-resume [--tmux <session>] [--dry-run]
  threa-harnessd install-watch [--tmux <session>]
  threa-harnessd install-boot-resume [--tmux <session>]
  threa-harnessd reconnect <runtime-session-id> --root-stream-id <stream-id> [--force]
  threa-harnessd adopt <runtime-session-id> --root-stream-id <stream-id>
      [--cwd <path>] [--name <name>] [--claude-session-id <uuid>] [--tmux <session>]
      [--dry-run] [--force] [--no-yolo | --yolo]
  threa-harnessd stop <agent-id-or-name>
  threa-harnessd kick <agent-id-or-name-or-runtime-session-id>
  threa-harnessd interrupt <agent-id-or-name>
  threa-harnessd steer <agent-id-or-name> [follow-up text]
  threa-harnessd keys <agent-id-or-name> <tmux send-keys tokens...>
  threa-harnessd attach <agent-id-or-name>
  threa-harnessd resolve [<agent-id-or-name-or-runtime-session-id>]
  threa-harnessd backfill-identities [--dry-run]  (record the identity two sources already agree on)
  threa-harnessd doctor

Examples:
  threa-harnessd spawn pi --name explore-long-chat-perf --branch explore/long-chat-perf
  threa-harnessd spawn claude --name fix-sidebar --branch fix/sidebar
  threa-harnessd up --dry-run
  threa-harnessd watch-unarchived --tmux threa-agents
  threa-harnessd install-watch
  threa-harnessd do spawn a pi agent for long chat performance
  threa-harnessd kick fix-sidebar
  threa-harnessd interrupt fix-sidebar
  threa-harnessd steer fix-sidebar "also update the tests"
  threa-harnessd keys fix-sidebar /compact Enter
  threa-harnessd adopt ccs-3ea859c21682385b --root-stream-id stream_01KY... --dry-run
`)
  process.exit(0)
}

export function now(): string {
  return new Date().toISOString()
}

export function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg.startsWith("--")) die(`unexpected argument: ${arg}`)
    const key = arg.slice(2)
    const next = args[i + 1]
    if (!next || next.startsWith("--")) {
      flags[key] = true
    } else {
      flags[key] = next
      i += 1
    }
  }
  return flags
}

export function stringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key]
  if (typeof value === "string" && value.trim()) return value.trim()
  return undefined
}

export function boolFlag(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true
}

export function defaultRepo(): string {
  const configured = process.env.THREA_HARNESSD_REPO
  if (configured) return resolve(configured)
  const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode === 0) return result.stdout.toString().trim()
  return process.cwd()
}

export function normalizeName(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
  return slug || `agent-${Date.now()}`
}

export function inferBranch(name: string, text?: string): string {
  const lower = text?.toLowerCase() ?? ""
  if (lower.includes("fix")) return `fix/${name.replace(/^fix-/, "")}`
  if (lower.includes("refactor")) return `refactor/${name.replace(/^refactor-/, "")}`
  return `explore/${name.replace(/^explore-/, "")}`
}

export function parseResume(args: string[]): ResumeOptions {
  const flags = parseFlags(args)
  if (Object.keys(flags).some((key) => key === "force" || key.startsWith("force="))) {
    die("--force was removed; revival never launches archived or inaccessible scratchpads")
  }
  return {
    tmux: stringFlag(flags, "tmux"),
    dryRun: boolFlag(flags, "dry-run"),
    recreateWorktree: boolFlag(flags, "recreate-worktree"),
  }
}

export function parseReconnect(args: string[]): ReconnectOptions {
  const runtimeSessionId = args.shift()
  if (!runtimeSessionId || runtimeSessionId.startsWith("--")) die("reconnect requires a runtime session id")
  let rootStreamId: string | undefined
  let force = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--force") {
      if (force) die("reconnect accepts --force exactly once")
      force = true
      continue
    }
    if (arg === "--root-stream-id") {
      if (rootStreamId) die("reconnect accepts --root-stream-id exactly once")
      const value = args[++index]
      if (!value || value.startsWith("--")) die("reconnect requires --root-stream-id <stream-id>")
      rootStreamId = value
      continue
    }
    die(`unexpected reconnect argument: ${arg}`)
  }
  if (!rootStreamId) die("reconnect requires --root-stream-id <stream-id>")
  return { runtimeSessionId, rootStreamId, force }
}

export function parseAdopt(args: string[]): AdoptOptions {
  const runtimeSessionId = args.shift()
  if (!runtimeSessionId || runtimeSessionId.startsWith("--")) die("adopt requires a runtime session id")
  const flags = parseFlags(args)
  for (const key of Object.keys(flags)) {
    if (!ADOPT_FLAGS.has(key)) die(`unexpected adopt argument: --${key}`)
  }
  const cwd = stringFlag(flags, "cwd")
  const yolo = boolFlag(flags, "yolo")
  const noYolo = boolFlag(flags, "no-yolo")
  if (yolo && noYolo) die("adopt accepts --yolo or --no-yolo, not both")
  return {
    runtimeSessionId,
    rootStreamId: stringFlag(flags, "root-stream-id") ?? die("adopt requires --root-stream-id <stream-id>"),
    cwd: cwd ? resolve(cwd) : undefined,
    name: stringFlag(flags, "name"),
    claudeSessionId: stringFlag(flags, "claude-session-id"),
    tmux: stringFlag(flags, "tmux"),
    dryRun: boolFlag(flags, "dry-run"),
    force: boolFlag(flags, "force"),
    noYolo: noYolo || undefined,
    yolo: yolo || undefined,
  }
}

const ADOPT_FLAGS = new Set([
  "root-stream-id",
  "cwd",
  "name",
  "claude-session-id",
  "tmux",
  "dry-run",
  "force",
  "no-yolo",
  "yolo",
])

export function parseBackfill(args: string[]): { dryRun: boolean } {
  const flags = parseFlags(args)
  for (const key of Object.keys(flags)) {
    if (key !== "dry-run") die(`unexpected backfill-identities argument: --${key}`)
  }
  return { dryRun: boolFlag(flags, "dry-run") }
}

export function parseResolve(args: string[]): string | undefined {
  const ref = args.shift()
  if (ref?.startsWith("--")) die(`unexpected resolve argument: ${ref}`)
  if (args.length > 0) die(`unexpected resolve argument: ${args[0]}`)
  return ref
}

export function parseSpawn(args: string[]): SpawnOptions {
  const runtime = args.shift() as RuntimeKind | undefined
  if (runtime !== "pi" && runtime !== "claude") die("spawn requires runtime: pi or claude")
  const flags = parseFlags(args)
  const name = stringFlag(flags, "name")
  if (!name) die("spawn requires --name")
  return {
    runtime,
    name: normalizeName(name),
    branch: stringFlag(flags, "branch"),
    base: stringFlag(flags, "base"),
    repo: resolve(stringFlag(flags, "repo") ?? defaultRepo()),
    tmux: stringFlag(flags, "tmux"),
    skipSetup: boolFlag(flags, "skip-setup"),
    noRemote: boolFlag(flags, "no-remote"),
    noRegister: boolFlag(flags, "no-register"),
    noAutoAccept: boolFlag(flags, "no-auto-accept"),
    noYolo: boolFlag(flags, "no-yolo"),
  }
}
