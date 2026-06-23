import { resolve } from "node:path"
import { die } from "./errors"
import type { RuntimeKind, SpawnOptions } from "./types"

export function usage(): never {
  console.log(`threa-harnessd

Usage:
  threa-harnessd spawn <pi|claude> --name <name> [--branch <ref>] [--repo <path>] [--tmux <session>] [--skip-setup]
  threa-harnessd do <natural language command>
  threa-harnessd list
  threa-harnessd stop <agent-id-or-name>
  threa-harnessd attach <agent-id-or-name>
  threa-harnessd doctor

Examples:
  threa-harnessd spawn pi --name explore-long-chat-perf --branch explore/long-chat-perf
  threa-harnessd spawn claude --name fix-sidebar --branch fix/sidebar
  threa-harnessd do spawn a pi agent for long chat performance
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
    repo: stringFlag(flags, "repo") ?? defaultRepo(),
    tmux: stringFlag(flags, "tmux"),
    skipSetup: boolFlag(flags, "skip-setup"),
    noRemote: boolFlag(flags, "no-remote"),
    noRegister: boolFlag(flags, "no-register"),
    noAutoAccept: boolFlag(flags, "no-auto-accept"),
    noYolo: boolFlag(flags, "no-yolo"),
  }
}
