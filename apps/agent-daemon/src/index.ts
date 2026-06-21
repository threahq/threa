#!/usr/bin/env bun

import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

const PI_SPAWN_SCRIPT = "/Users/kristofferremback/dev/personal/pi-extensions/skills/spawn-pi-remote-worktree/spawn.sh"
const CLAUDE_SPAWN_SCRIPT =
  "/Users/kristofferremback/dev/personal/pi-extensions/skills/spawn-claude-channel-worktree/spawn.sh"
const DEFAULT_INVENTORY_PATH = `${homedir()}/.threa/agentd/inventory.sqlite`

type RuntimeKind = "pi" | "claude"
type AgentStatus = "starting" | "online" | "offline" | "stopped" | "error"

interface ManagedAgent {
  id: string
  name: string
  runtime: RuntimeKind
  status: AgentStatus
  worktree?: string
  branch?: string
  tmuxSession?: string
  tmuxWindow?: string
  scratchpadUrl?: string
  command: string[]
  createdAt: string
  updatedAt: string
  lastOutput?: string
}

interface SpawnOptions {
  runtime: RuntimeKind
  name: string
  branch?: string
  base?: string
  repo?: string
  tmux?: string
  skipSetup?: boolean
  noRemote?: boolean
  noRegister?: boolean
  noAutoAccept?: boolean
  noYolo?: boolean
}

function usage(): never {
  console.log(`threa-agentd

Usage:
  threa-agentd spawn <pi|claude> --name <name> [--branch <ref>] [--repo <path>] [--tmux <session>] [--skip-setup]
  threa-agentd do <natural language command>
  threa-agentd list
  threa-agentd stop <agent-id-or-name>
  threa-agentd attach <agent-id-or-name>
  threa-agentd doctor

Examples:
  threa-agentd spawn pi --name explore-long-chat-perf --branch explore/long-chat-perf
  threa-agentd spawn claude --name fix-sidebar --branch fix/sidebar
  threa-agentd do spawn a pi agent for long chat performance
`)
  process.exit(0)
}

function die(message: string): never {
  console.error(`agentd: ${message}`)
  process.exit(1)
}

function now(): string {
  return new Date().toISOString()
}

function inventoryPath(): string {
  return process.env.THREA_AGENTD_INVENTORY || DEFAULT_INVENTORY_PATH
}

function openInventory(): Database {
  const path = inventoryPath()
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS managed_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      runtime TEXT NOT NULL,
      status TEXT NOT NULL,
      worktree TEXT,
      branch TEXT,
      tmux_session TEXT,
      tmux_window TEXT,
      scratchpad_url TEXT,
      command_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_output TEXT
    )
  `)
  return db
}

interface ManagedAgentRow {
  id: string
  name: string
  runtime: RuntimeKind
  status: AgentStatus
  worktree: string | null
  branch: string | null
  tmux_session: string | null
  tmux_window: string | null
  scratchpad_url: string | null
  command_json: string
  created_at: string
  updated_at: string
  last_output: string | null
}

function rowToAgent(row: ManagedAgentRow): ManagedAgent {
  return {
    id: row.id,
    name: row.name,
    runtime: row.runtime,
    status: row.status,
    worktree: row.worktree ?? undefined,
    branch: row.branch ?? undefined,
    tmuxSession: row.tmux_session ?? undefined,
    tmuxWindow: row.tmux_window ?? undefined,
    scratchpadUrl: row.scratchpad_url ?? undefined,
    command: JSON.parse(row.command_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOutput: row.last_output ?? undefined,
  }
}

function readInventory(): ManagedAgent[] {
  const db = openInventory()
  try {
    const rows = db.query("SELECT * FROM managed_agents ORDER BY created_at ASC").all() as ManagedAgentRow[]
    return rows.map(rowToAgent)
  } finally {
    db.close()
  }
}

function upsertAgent(agent: ManagedAgent): void {
  const db = openInventory()
  try {
    db.query(
      `
      INSERT INTO managed_agents (
        id, name, runtime, status, worktree, branch, tmux_session, tmux_window,
        scratchpad_url, command_json, created_at, updated_at, last_output
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        runtime = excluded.runtime,
        status = excluded.status,
        worktree = excluded.worktree,
        branch = excluded.branch,
        tmux_session = excluded.tmux_session,
        tmux_window = excluded.tmux_window,
        scratchpad_url = excluded.scratchpad_url,
        command_json = excluded.command_json,
        updated_at = excluded.updated_at,
        last_output = excluded.last_output
    `
    ).run(
      agent.id,
      agent.name,
      agent.runtime,
      agent.status,
      agent.worktree ?? null,
      agent.branch ?? null,
      agent.tmuxSession ?? null,
      agent.tmuxWindow ?? null,
      agent.scratchpadUrl ?? null,
      JSON.stringify(agent.command),
      agent.createdAt,
      agent.updatedAt,
      agent.lastOutput ?? null
    )
  } finally {
    db.close()
  }
}

function findAgent(ref: string): ManagedAgent {
  const agents = readInventory()
  const matches = agents.filter((agent) => agent.id === ref || agent.name === ref)
  if (matches.length === 0) die(`no agent found for ${ref}`)
  if (matches.length > 1) die(`multiple agents match ${ref}; use id`)
  return matches[0]
}

function parseFlags(args: string[]): Record<string, string | boolean> {
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

function stringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key]
  if (typeof value === "string" && value.trim()) return value.trim()
  return undefined
}

function defaultRepo(): string {
  const configured = process.env.THREA_AGENTD_REPO
  if (configured) return resolve(configured)
  const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode === 0) return result.stdout.toString().trim()
  return process.cwd()
}

function normalizeName(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
  return slug || `agent-${Date.now()}`
}

function inferBranch(name: string, text?: string): string {
  const lower = text?.toLowerCase() ?? ""
  if (lower.includes("fix")) return `fix/${name.replace(/^fix-/, "")}`
  if (lower.includes("refactor")) return `refactor/${name.replace(/^refactor-/, "")}`
  return `explore/${name.replace(/^explore-/, "")}`
}

function parseSpawn(args: string[]): SpawnOptions {
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
    skipSetup: flags["skip-setup"] === true,
    noRemote: flags["no-remote"] === true,
    noRegister: flags["no-register"] === true,
    noAutoAccept: flags["no-auto-accept"] === true,
    noYolo: flags["no-yolo"] === true,
  }
}

function buildSpawnCommand(options: SpawnOptions): string[] {
  const script = options.runtime === "pi" ? PI_SPAWN_SCRIPT : CLAUDE_SPAWN_SCRIPT
  const command = ["bash", script, options.name]
  command.push("--repo", options.repo ?? defaultRepo())
  if (options.branch) command.push("--branch", options.branch)
  if (options.base) command.push("--base", options.base)
  if (options.tmux) command.push("--tmux", options.tmux)
  if (options.skipSetup) command.push("--skip-setup")
  if (options.runtime === "pi" && options.noRemote) command.push("--no-remote")
  if (options.runtime === "claude" && options.noRegister) command.push("--no-register")
  if (options.runtime === "claude" && options.noAutoAccept) command.push("--no-auto-accept")
  if (options.runtime === "claude" && options.noYolo) command.push("--no-yolo")
  return command
}

function parseSpawnOutput(output: string): Partial<ManagedAgent> {
  const worktree = output.match(/worktree:\s+(.+)/)?.[1]?.trim()
  const branch = output.match(/branch:\s+([^\n(]+)/)?.[1]?.trim()
  const tmux = output.match(/tmux:\s+session '([^']+)', window '([^']+)'/)
  const scratchpadUrl = output.match(/https:\/\/app\.threa\.io\/[^\s)]+/)?.[0]
  return {
    worktree,
    branch,
    tmuxSession: tmux?.[1],
    tmuxWindow: tmux?.[2],
    scratchpadUrl,
  }
}

async function spawnAgent(options: SpawnOptions): Promise<void> {
  if (!existsSync(options.runtime === "pi" ? PI_SPAWN_SCRIPT : CLAUDE_SPAWN_SCRIPT)) {
    die(`spawn script missing for ${options.runtime}`)
  }
  const command = buildSpawnCommand(options)
  const id = `${options.runtime}-${Date.now()}`
  const createdAt = now()
  const agent: ManagedAgent = {
    id,
    name: options.name,
    runtime: options.runtime,
    status: "starting",
    branch: options.branch,
    tmuxSession: options.tmux,
    command,
    createdAt,
    updatedAt: createdAt,
  }
  upsertAgent(agent)

  console.log(`agentd: spawning ${options.runtime} agent ${options.name}`)
  console.log(`agentd: ${command.join(" ")}`)
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim()
  const parsed = parseSpawnOutput(output)
  const finalStatus: AgentStatus = exitCode === 0 ? "online" : "error"
  upsertAgent({
    ...agent,
    ...parsed,
    status: finalStatus,
    updatedAt: now(),
    lastOutput: output.slice(-4000),
  })
  process.stdout.write(stdout)
  process.stderr.write(stderr)
  if (exitCode !== 0) die(`spawn failed with exit code ${exitCode}`)
  console.log(`agentd: recorded ${id}`)
}

function listAgents(): void {
  const agents = readInventory()
  if (agents.length === 0) {
    console.log("No managed agents.")
    return
  }
  for (const agent of agents) {
    const tmux = agent.tmuxSession && agent.tmuxWindow ? `${agent.tmuxSession}:${agent.tmuxWindow}` : "-"
    console.log(`${agent.id}\t${agent.status}\t${agent.runtime}\t${agent.name}\t${tmux}\t${agent.scratchpadUrl ?? "-"}`)
  }
}

function stopAgent(ref: string): void {
  const agent = findAgent(ref)
  if (!agent.tmuxSession || !agent.tmuxWindow) die(`${agent.name} has no tmux target recorded`)
  const target = `${agent.tmuxSession}:${agent.tmuxWindow}`
  const result = Bun.spawnSync(["tmux", "kill-window", "-t", target], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) die(result.stderr.toString().trim() || `tmux kill-window failed for ${target}`)
  upsertAgent({ ...agent, status: "stopped", updatedAt: now() })
  console.log(`agentd: stopped ${agent.name} (${target})`)
}

function attachAgent(ref: string): void {
  const agent = findAgent(ref)
  if (!agent.tmuxSession || !agent.tmuxWindow) die(`${agent.name} has no tmux target recorded`)
  console.log(`tmux select-window -t '${agent.tmuxSession}:${agent.tmuxWindow}'`)
  if (agent.scratchpadUrl) console.log(agent.scratchpadUrl)
}

function commandExists(name: string): boolean {
  const result = Bun.spawnSync(["bash", "-lc", `command -v ${name} >/dev/null`])
  return result.exitCode === 0
}

function doctor(): void {
  const checks: Array<[string, boolean, string]> = [
    ["bun", commandExists("bun"), "required"],
    ["git", commandExists("git"), "required"],
    ["tmux", commandExists("tmux"), "required"],
    ["pi", existsSync("/Users/kristofferremback/.bun/bin/pi") || commandExists("pi"), "needed for Pi agents"],
    ["claude", commandExists("claude"), "needed for Claude agents"],
    ["pi spawn script", existsSync(PI_SPAWN_SCRIPT), PI_SPAWN_SCRIPT],
    ["claude spawn script", existsSync(CLAUDE_SPAWN_SCRIPT), CLAUDE_SPAWN_SCRIPT],
    ["tmux session 0", Bun.spawnSync(["tmux", "has-session", "-t", "0"]).exitCode === 0, "default target"],
  ]
  for (const [name, ok, note] of checks) {
    console.log(`${ok ? "ok" : "missing"}\t${name}\t${note}`)
  }
  console.log(`inventory\t${inventoryPath()}`)
  console.log(`repo\t${defaultRepo()}`)
}

async function inferAndRun(text: string): Promise<void> {
  const lower = text.toLowerCase()
  if (/\b(list|status|inventory)\b/.test(lower)) {
    listAgents()
    return
  }
  const stopMatch = lower.match(/\b(stop|kill|archive)\s+([a-z0-9_-]+)/)
  if (stopMatch?.[2]) {
    stopAgent(stopMatch[2])
    return
  }
  if (/\b(spawn|start|create|new)\b/.test(lower)) {
    const runtime: RuntimeKind = lower.includes("claude") ? "claude" : "pi"
    const topic = lower
      .replace(/\b(spawn|start|create|new|agent|worktree|scratchpad|pi|claude|for|a|an|the|please)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim()
    const name = normalizeName(topic || `${runtime}-agent`)
    await spawnAgent({ runtime, name, branch: inferBranch(name, lower), repo: defaultRepo() })
    return
  }
  die(`could not infer command from: ${text}`)
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv
  if (!command || command === "help" || command === "--help" || command === "-h") usage()
  if (command === "spawn") return spawnAgent(parseSpawn(args))
  if (command === "list") return listAgents()
  if (command === "stop") return stopAgent(args[0] ?? die("stop requires an agent id or name"))
  if (command === "attach") return attachAgent(args[0] ?? die("attach requires an agent id or name"))
  if (command === "doctor") return doctor()
  if (command === "do") return inferAndRun(args.join(" "))
  die(`unknown command: ${command}`)
}

main().catch((error) => die(error instanceof Error ? error.message : String(error)))
