#!/usr/bin/env bun

import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { homedir, hostname } from "node:os"

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

interface SpawnResult {
  worktree: string
  branch: string
  tmuxSession: string
  tmuxWindow: string
  scratchpadUrl?: string
  output: string
}

interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface ThreaChannelConfig {
  baseUrl?: string
  workspaceId?: string
  apiKey?: string
  displayName?: string
  defaultLabel?: string
  instanceId?: string
  runtimeSessionId?: string
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

function boolFlag(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true
}

function commandExists(name: string): boolean {
  const result = Bun.spawnSync(["bash", "-lc", `command -v ${name} >/dev/null`])
  return result.exitCode === 0
}

function commandPath(name: string): string | undefined {
  const result = Bun.spawnSync(["bash", "-lc", `command -v ${name}`], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) return undefined
  return result.stdout.toString().trim() || undefined
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
    skipSetup: boolFlag(flags, "skip-setup"),
    noRemote: boolFlag(flags, "no-remote"),
    noRegister: boolFlag(flags, "no-register"),
    noAutoAccept: boolFlag(flags, "no-auto-accept"),
    noYolo: boolFlag(flags, "no-yolo"),
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function run(command: string[], options: { cwd?: string; allowFailure?: boolean } = {}): RunResult {
  const result = Bun.spawnSync(command, { cwd: options.cwd, stdout: "pipe", stderr: "pipe" })
  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  if (result.exitCode !== 0 && !options.allowFailure) {
    die(`${command.join(" ")} failed with exit code ${result.exitCode}`)
  }
  return { stdout, stderr, exitCode: result.exitCode }
}

function output(command: string[], options: { cwd?: string; allowFailure?: boolean } = {}): RunResult {
  const result = Bun.spawnSync(command, { cwd: options.cwd, stdout: "pipe", stderr: "pipe" })
  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()
  if (result.exitCode !== 0 && !options.allowFailure) {
    die(stderr.trim() || `${command.join(" ")} failed with exit code ${result.exitCode}`)
  }
  return { stdout, stderr, exitCode: result.exitCode }
}

function repoWorktreeDir(repo: string, name: string): string {
  return resolve(dirname(resolve(repo)), `threa.${name}`)
}

function branchFor(options: SpawnOptions): string {
  return options.branch ?? options.name
}

function baseFor(options: SpawnOptions): string {
  return options.base ?? "origin/main"
}

function ensureWorktree(options: SpawnOptions): { worktree: string; branch: string } {
  const repo = resolve(options.repo ?? defaultRepo())
  const branch = branchFor(options)
  const base = baseFor(options)
  const worktree = repoWorktreeDir(repo, options.name)
  if (!existsSync(repo)) die(`repo not found: ${repo}`)
  if (existsSync(worktree)) die(`worktree dir already exists: ${worktree}`)

  console.log(`agentd: fetching ${base} in ${repo}`)
  run(["git", "-C", repo, "fetch", "origin", base.replace(/^origin\//, "")])
  console.log(`agentd: creating worktree ${worktree} (${branch} off ${base})`)
  run(["git", "-C", repo, "worktree", "add", "-b", branch, worktree, base])
  maybeSetupWorktree(worktree, options.skipSetup === true)
  return { worktree, branch }
}

function maybeSetupWorktree(worktree: string, skipSetup: boolean): void {
  if (skipSetup) {
    console.warn("agentd: --skip-setup: skipping bun run setup:worktree")
    return
  }
  const docker = output(["docker", "ps", "--format", "{{.Names}}"], { allowFailure: true })
  if (docker.exitCode !== 0 || !docker.stdout.split("\n").includes("threa-postgres")) {
    console.warn("agentd: threa-postgres container not running; skipping setup:worktree")
    return
  }
  console.log("agentd: running bun run setup:worktree")
  const result = run(["bun", "run", "setup:worktree"], { cwd: worktree, allowFailure: true })
  if (result.exitCode !== 0) console.warn("agentd: setup:worktree reported errors; continuing")
}

function tmuxSession(options: SpawnOptions): string {
  return options.tmux ?? "0"
}

function ensureTmuxSession(session: string): void {
  const result = output(["tmux", "has-session", "-t", session], { allowFailure: true })
  if (result.exitCode !== 0) die(`tmux session '${session}' not found`)
}

function pickTmuxWindow(session: string, name: string): string {
  const existing = output(["tmux", "list-windows", "-t", session, "-F", "#{window_name}"])
    .stdout.split("\n")
    .filter(Boolean)
  if (!existing.includes(name)) return name
  return `${name}-${Math.floor(Math.random() * 10000)}`
}

function capturePane(session: string, window: string, lines = 30): string {
  return output(["tmux", "capture-pane", "-t", `${session}:${window}`, "-p", "-S", `-${lines}`], {
    allowFailure: true,
  }).stdout
}

function firstScratchpadUrl(text: string): string | undefined {
  return text.match(/https:\/\/app\.threa\.io\/[^\s)]+/)?.[0]
}

abstract class RuntimeSpawner {
  abstract spawn(options: SpawnOptions): Promise<SpawnResult>

  protected createWorktree(options: SpawnOptions): { worktree: string; branch: string } {
    return ensureWorktree(options)
  }
}

class PiRuntimeSpawner extends RuntimeSpawner {
  async spawn(options: SpawnOptions): Promise<SpawnResult> {
    if (!commandExists("git")) die("git not found")
    if (!commandExists("tmux")) die("tmux not found")
    if (!commandExists("bun")) die("bun not found")
    const piBin = process.env.THREA_AGENTD_PI_BIN || commandPath("pi")
    if (!piBin) die("pi binary not found; set THREA_AGENTD_PI_BIN or put pi on PATH")

    const session = tmuxSession(options)
    ensureTmuxSession(session)
    const { worktree, branch } = this.createWorktree(options)
    const window = pickTmuxWindow(session, options.name)
    console.log(`agentd: launching Pi in tmux ${session}:${window}`)
    run(["tmux", "new-window", "-t", session, "-a", "-n", window, "-c", worktree, piBin])

    if (!options.noRemote) {
      await Bun.sleep(Number(process.env.THREA_AGENTD_PI_BOOT_WAIT_MS ?? 8000))
      run(["tmux", "send-keys", "-t", `${session}:${window}`, "/remote-control", "Enter"])
      await Bun.sleep(Number(process.env.THREA_AGENTD_PI_REMOTE_WAIT_MS ?? 6000))
    }

    const outputText = capturePane(session, window)
    return {
      worktree,
      branch,
      tmuxSession: session,
      tmuxWindow: window,
      scratchpadUrl: firstScratchpadUrl(outputText),
      output: outputText,
    }
  }
}

class ClaudeRuntimeSpawner extends RuntimeSpawner {
  async spawn(options: SpawnOptions): Promise<SpawnResult> {
    if (!commandExists("git")) die("git not found")
    if (!commandExists("tmux")) die("tmux not found")
    if (!commandExists("bun")) die("bun not found")
    const claudeBin = process.env.THREA_AGENTD_CLAUDE_BIN || commandPath("claude")
    if (!claudeBin) die("claude binary not found; set THREA_AGENTD_CLAUDE_BIN or put claude on PATH")

    const session = tmuxSession(options)
    ensureTmuxSession(session)
    const { worktree, branch } = this.createWorktree(options)
    const channel = process.env.THREA_AGENTD_CLAUDE_CHANNEL || "threa"
    const channelDir = join(worktree, "extensions", "claude-code-remote")
    const channelEntry = join(channelDir, "src", "index.ts")
    if (!existsSync(channelEntry)) die(`Claude channel entry not found: ${channelEntry}`)

    console.log("agentd: installing Claude channel dependencies")
    run(["bun", "install"], { cwd: channelDir })

    const scratchpadUrl = await this.prelinkScratchpad(worktree)
    if (scratchpadUrl) console.log(`agentd: scratchpad: ${scratchpadUrl}`)

    if (!options.noRegister) {
      console.log(`agentd: registering Claude MCP server '${channel}'`)
      run([claudeBin, "mcp", "remove", channel, "--scope", "local"], { cwd: worktree, allowFailure: true })
      run([claudeBin, "mcp", "add", channel, "--scope", "local", "--", "bun", channelEntry], { cwd: worktree })
    }

    const window = pickTmuxWindow(session, options.name)
    const args = [
      claudeBin,
      "--name",
      `threa.${options.name}`,
      "--dangerously-load-development-channels",
      `server:${channel}`,
    ]
    if (!options.noYolo) args.push("--dangerously-skip-permissions")
    console.log(`agentd: launching Claude Code in tmux ${session}:${window}`)
    run(["tmux", "new-window", "-t", session, "-a", "-n", window, "-c", worktree, args.map(shellQuote).join(" ")])

    if (!options.noAutoAccept) {
      await Bun.sleep(Number(process.env.THREA_AGENTD_CLAUDE_BOOT_WAIT_MS ?? 5000))
      run(["tmux", "send-keys", "-t", `${session}:${window}`, "Enter"])
      await Bun.sleep(Number(process.env.THREA_AGENTD_CLAUDE_ACCEPT_WAIT_MS ?? 6000))
    }

    const outputText = capturePane(session, window)
    return {
      worktree,
      branch,
      tmuxSession: session,
      tmuxWindow: window,
      scratchpadUrl: scratchpadUrl ?? firstScratchpadUrl(outputText),
      output: outputText,
    }
  }

  private async prelinkScratchpad(worktree: string): Promise<string | undefined> {
    const config = readThreaChannelConfig()
    const baseUrl = (process.env.THREA_BASE_URL || config.baseUrl || "https://app.threa.io").replace(/\/$/, "")
    const workspaceId = process.env.THREA_WORKSPACE_ID || config.workspaceId
    const apiKey = process.env.THREA_API_KEY || config.apiKey
    if (!workspaceId || !apiKey) {
      console.warn("agentd: no Claude channel Threa credentials found; channel will link on startup")
      return undefined
    }

    const seed = `${hostname()}:${worktree}`
    const instanceId = sanitizeId(process.env.THREA_INSTANCE_ID || config.instanceId || stableId("cc", seed)).slice(
      0,
      64
    )
    const runtimeSessionId = sanitizeId(
      process.env.THREA_RUNTIME_SESSION_ID || config.runtimeSessionId || stableId("ccs", seed)
    ).slice(0, 64)
    const displayName = defaultDisplayName(worktree, process.env.THREA_DISPLAY_NAME || config.displayName)
    const labelName = process.env.THREA_DEFAULT_LABEL || config.defaultLabel

    const response = await fetch(`${baseUrl}/api/v1/workspaces/${workspaceId}/bot-runtime/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        runtimeKind: "claude-code-channel",
        instanceId,
        runtimeSessionId,
        displayName,
        localCwd: worktree,
        ...(labelName ? { labelName } : {}),
      }),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => "")
      console.warn(`agentd: could not pre-link Claude scratchpad: ${response.status} ${body.slice(0, 300)}`)
      return undefined
    }
    const json = (await response.json()) as { data?: { streamUrlPath?: string } }
    return json.data?.streamUrlPath ? `${baseUrl}${json.data.streamUrlPath}` : undefined
  }
}

function readThreaChannelConfig(): ThreaChannelConfig {
  const path = join(homedir(), ".claude", "threa-channel", "config.json")
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ThreaChannelConfig
  } catch {
    return {}
  }
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
}

function stableId(prefix: string, seed: string): string {
  return `${prefix}-${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`
}

function defaultDisplayName(worktree: string, override?: string): string {
  const prefix = override?.trim() || "Claude Code"
  const name = `${prefix} - ${basename(worktree)}`
  return name.length > 100 ? name.slice(0, 100) : name
}

function spawnCommand(options: SpawnOptions): string[] {
  const command = ["threa-agentd", "spawn", options.runtime, "--name", options.name]
  if (options.branch) command.push("--branch", options.branch)
  if (options.base) command.push("--base", options.base)
  if (options.repo) command.push("--repo", options.repo)
  if (options.tmux) command.push("--tmux", options.tmux)
  if (options.skipSetup) command.push("--skip-setup")
  if (options.noRemote) command.push("--no-remote")
  if (options.noRegister) command.push("--no-register")
  if (options.noAutoAccept) command.push("--no-auto-accept")
  if (options.noYolo) command.push("--no-yolo")
  return command
}

async function spawnAgent(options: SpawnOptions): Promise<void> {
  const command = spawnCommand(options)
  const id = `${options.runtime}-${Date.now()}-${randomUUID().slice(0, 8)}`
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

  const spawner = options.runtime === "pi" ? new PiRuntimeSpawner() : new ClaudeRuntimeSpawner()
  try {
    const result = await spawner.spawn(options)
    upsertAgent({
      ...agent,
      worktree: result.worktree,
      branch: result.branch,
      tmuxSession: result.tmuxSession,
      tmuxWindow: result.tmuxWindow,
      scratchpadUrl: result.scratchpadUrl,
      status: "online",
      updatedAt: now(),
      lastOutput: result.output.slice(-4000),
    })
    if (result.output) process.stdout.write(result.output)
    console.log(`agentd: recorded ${id}`)
  } catch (error) {
    upsertAgent({ ...agent, status: "error", updatedAt: now(), lastOutput: String(error).slice(-4000) })
    throw error
  }
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
  const result = output(["tmux", "kill-window", "-t", target], { allowFailure: true })
  if (result.exitCode !== 0) die(result.stderr.trim() || `tmux kill-window failed for ${target}`)
  upsertAgent({ ...agent, status: "stopped", updatedAt: now() })
  console.log(`agentd: stopped ${agent.name} (${target})`)
}

function attachAgent(ref: string): void {
  const agent = findAgent(ref)
  if (!agent.tmuxSession || !agent.tmuxWindow) die(`${agent.name} has no tmux target recorded`)
  const target = `${agent.tmuxSession}:${agent.tmuxWindow}`
  if (process.env.TMUX) {
    const result = Bun.spawnSync(["tmux", "switch-client", "-t", target], { stdout: "inherit", stderr: "pipe" })
    if (result.exitCode !== 0) die(result.stderr.toString().trim() || `tmux switch-client failed for ${target}`)
    return
  }

  const select = output(["tmux", "select-window", "-t", target], { allowFailure: true })
  if (select.exitCode !== 0) die(select.stderr.trim() || `tmux select-window failed for ${target}`)
  const attach = Bun.spawnSync(["tmux", "attach-session", "-t", agent.tmuxSession], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "pipe",
  })
  if (attach.exitCode !== 0)
    die(attach.stderr.toString().trim() || `tmux attach-session failed for ${agent.tmuxSession}`)
}

function doctor(): void {
  const checks: Array<[string, boolean, string]> = [
    ["bun", commandExists("bun"), "required"],
    ["git", commandExists("git"), "required"],
    ["tmux", commandExists("tmux"), "required"],
    ["docker", commandExists("docker"), "needed for setup:worktree"],
    ["pi", Boolean(process.env.THREA_AGENTD_PI_BIN || commandPath("pi")), "needed for Pi agents"],
    ["claude", Boolean(process.env.THREA_AGENTD_CLAUDE_BIN || commandPath("claude")), "needed for Claude agents"],
    [
      "tmux session 0",
      output(["tmux", "has-session", "-t", "0"], { allowFailure: true }).exitCode === 0,
      "default target",
    ],
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
