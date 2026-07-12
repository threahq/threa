import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { installBootResume } from "./boot"
import { defaultRepo, inferBranch, normalizeName, now } from "./cli"
import { die } from "./errors"
import { findAgent, inventoryPath, readInventory, upsertAgent } from "./inventory"
import { commandExists, commandPath, output } from "./shell"
import { ClaudeRuntimeSpawner, PiRuntimeSpawner, readThreaChannelConfig } from "./spawners"
import { latestAgents, parseScratchpadUrl } from "./resume"
import { agentWindowExists, attachedTmuxSession, ensureTmuxSession, sendKeys } from "./tmux"
import type { ManagedAgent, ResumeOptions, SpawnOptions } from "./types"

function spawnCommand(options: SpawnOptions): string[] {
  const command = ["threa-harnessd", "spawn", options.runtime, "--name", options.name]
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

export async function spawnAgent(options: SpawnOptions): Promise<void> {
  const command = spawnCommand(options)
  const id = `${options.runtime}-${Date.now()}-${randomUUID().slice(0, 8)}`
  const createdAt = now()
  const agent = {
    id,
    name: options.name,
    runtime: options.runtime,
    status: "starting" as const,
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
      tmuxWindowId: result.tmuxWindowId,
      scratchpadUrl: result.scratchpadUrl,
      status: "online",
      updatedAt: now(),
      lastOutput: result.output.slice(-4000),
    })
    if (result.output) process.stdout.write(result.output)
    console.log(`harnessd: recorded ${id}`)
  } catch (error) {
    upsertAgent({ ...agent, status: "error", updatedAt: now(), lastOutput: String(error).slice(-4000) })
    throw error
  }
}

export async function bootResume(options: ResumeOptions): Promise<void> {
  const session = options.tmux ?? "threa-agents"
  ensureTmuxSession(session, true)
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const retryable = await resumeActive({ ...options, tmux: session })
    if (!retryable || options.dryRun) return
    if (attempt < 3) {
      console.warn(`harnessd: Threa API unavailable; retrying boot resume (${attempt}/3) in 10 seconds`)
      await Bun.sleep(10_000)
    }
  }
}

export function installBootResumeAgent(options: ResumeOptions): void {
  installBootResume(options.tmux ?? "threa-agents")
}

export async function resumeActive(options: ResumeOptions): Promise<boolean> {
  output(["tmux", "wait-for", "-L", "harnessd-resume-active"])
  try {
    return await resumeActiveUnlocked(options)
  } finally {
    output(["tmux", "wait-for", "-U", "harnessd-resume-active"], { allowFailure: true })
  }
}

async function resumeActiveUnlocked(options: ResumeOptions): Promise<boolean> {
  const config = readThreaChannelConfig()
  const workspaceId = process.env.THREA_WORKSPACE_ID || config.workspaceId
  const apiKey = process.env.THREA_API_KEY || config.apiKey
  const agents = latestAgents(readInventory())
  if (agents.length === 0) {
    console.log("No managed agents.")
    return false
  }
  let retryable = false

  for (const agent of agents) {
    const skip = (reason: string) => console.log(`skip\t${agent.name}\t${reason}`)
    if (agentWindowExists(agent)) {
      skip("already running")
      continue
    }
    if (agent.status === "stopped") {
      skip("stopped")
      continue
    }
    if (agent.runtime === "pi") {
      skip("Pi session reattachment is not supported")
      continue
    }
    if (!agent.scratchpadUrl) {
      skip("no scratchpad URL")
      continue
    }
    if (!agent.worktree || !existsSync(agent.worktree)) {
      skip("missing worktree dir")
      continue
    }
    const mcpConfig = join(homedir(), ".threa", "harnessd", "mcp", `${agent.name}.json`)
    if (!existsSync(mcpConfig)) {
      skip("missing MCP config")
      continue
    }
    const scratchpad = parseScratchpadUrl(agent.scratchpadUrl)
    if (!scratchpad) {
      skip("invalid scratchpad URL")
      continue
    }
    const configuredBaseUrl = (process.env.THREA_BASE_URL || config.baseUrl || "https://app.threa.io").replace(
      /\/$/,
      ""
    )
    if (scratchpad.baseUrl !== configuredBaseUrl) {
      skip("scratchpad URL origin does not match configured Threa base URL")
      continue
    }
    if (workspaceId && scratchpad.workspaceId && workspaceId !== scratchpad.workspaceId) {
      skip("scratchpad workspace does not match configured workspace")
      continue
    }
    const scratchpadWorkspaceId = scratchpad.workspaceId || workspaceId
    if (!scratchpadWorkspaceId || !apiKey) {
      if (!options.force) {
        skip("missing Threa credentials")
        continue
      }
    } else {
      const result = await scratchpadStatus({
        baseUrl: configuredBaseUrl,
        workspaceId: scratchpadWorkspaceId,
        apiKey,
        streamId: scratchpad.streamId,
      })
      if (result === "unavailable") retryable = true
      if (result !== "active" && !options.force) {
        skip(result)
        continue
      }
      if (result !== "active") console.log(`force\t${agent.name}\t${result}`)
    }
    if (options.dryRun) {
      console.log(`restore\t${agent.name}\t${agent.scratchpadUrl}`)
      continue
    }

    try {
      const result = await new ClaudeRuntimeSpawner().resume(agent, options)
      upsertAgent({
        ...agent,
        tmuxSession: result.tmuxSession,
        tmuxWindow: result.tmuxWindow,
        tmuxWindowId: result.tmuxWindowId,
        status: "online",
        updatedAt: now(),
        lastOutput: result.output.slice(-4000),
      })
      const bypass = agent.command.includes("--no-yolo") ? "disabled" : "enabled"
      console.log(`restored\t${agent.name}\tbypass ${bypass}`)
    } catch (error) {
      upsertAgent({ ...agent, status: "error", updatedAt: now(), lastOutput: String(error).slice(-4000) })
      skip(`launch failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return retryable
}

async function scratchpadStatus(params: {
  baseUrl: string
  workspaceId: string
  apiKey: string
  streamId: string
}): Promise<"active" | "archived" | "inaccessible" | "unavailable"> {
  try {
    const response = await fetch(
      `${params.baseUrl.replace(/\/$/, "")}/api/v1/workspaces/${params.workspaceId}/streams/${params.streamId}`,
      { headers: { authorization: `Bearer ${params.apiKey}` }, signal: AbortSignal.timeout(10_000) }
    )
    if (response.status === 403 || response.status === 404) return "inaccessible"
    if (!response.ok) return response.status === 429 || response.status >= 500 ? "unavailable" : "inaccessible"
    const json = (await response.json()) as { data?: { archivedAt?: string | null } }
    if (!json.data || !("archivedAt" in json.data)) return "inaccessible"
    return json.data.archivedAt ? "archived" : "active"
  } catch {
    return "unavailable"
  }
}

export function listAgents(): void {
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

export function stopAgent(ref: string): void {
  const agent = findAgent(ref)
  const target = tmuxTarget(agent)
  const result = output(["tmux", "kill-window", "-t", target], { allowFailure: true })
  if (result.exitCode !== 0) die(result.stderr.trim() || `tmux kill-window failed for ${target}`)
  upsertAgent({ ...agent, status: "stopped", updatedAt: now() })
  console.log(`harnessd: stopped ${agent.name} (${target})`)
}

/** Window id when recorded (durable across renames/collisions), else the legacy session:name target. */
function tmuxTarget(agent: ManagedAgent): string {
  if (agent.tmuxWindowId) return agent.tmuxWindowId
  if (agent.tmuxSession && agent.tmuxWindow) return `${agent.tmuxSession}:${agent.tmuxWindow}`
  return die(`${agent.name} has no tmux target recorded`)
}

/** Send Esc to interrupt the agent's current turn (Claude Code / Pi) without killing the window. */
export function interruptAgent(ref: string): void {
  const target = tmuxTarget(findAgent(ref))
  sendKeys(target, ["Escape"])
  console.log(`harnessd: interrupted ${target}`)
}

/** Interrupt the current turn, then (if given) type a follow-up and submit it. */
export function steerAgent(ref: string, text: string): void {
  const target = tmuxTarget(findAgent(ref))
  sendKeys(target, ["Escape"])
  if (text) {
    // Esc restores the interrupted message into the input box; clear it (Ctrl-U)
    // before typing so the follow-up doesn't concatenate with that residue and
    // submit as a plain prompt.
    sendKeys(target, ["C-u"])
    sendKeys(target, ["-l", text])
    sendKeys(target, ["Enter"])
  }
  console.log(`harnessd: steered ${target}`)
}

/** Raw `tmux send-keys` passthrough to the agent's window (tokens follow tmux rules). */
export function sendKeysToAgent(ref: string, keys: string[]): void {
  if (keys.length === 0) die("keys requires at least one key or token")
  const target = tmuxTarget(findAgent(ref))
  sendKeys(target, keys)
  console.log(`harnessd: sent keys to ${target}`)
}

export function attachAgent(ref: string): void {
  const agent = findAgent(ref)
  if (!agent.tmuxSession) die(`${agent.name} has no tmux session recorded`)
  const target = tmuxTarget(agent)
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

export function doctor(): void {
  const checks: Array<[string, boolean, string]> = [
    ["bun", commandExists("bun"), "required"],
    ["git", commandExists("git"), "required"],
    ["tmux", commandExists("tmux"), "required"],
    ["docker", commandExists("docker"), "needed for setup:worktree"],
    ["pi", Boolean(process.env.THREA_HARNESSD_PI_BIN || commandPath("pi")), "needed for Pi agents"],
    ["claude", Boolean(process.env.THREA_HARNESSD_CLAUDE_BIN || commandPath("claude")), "needed for Claude agents"],
    [
      "tmux attached session",
      Boolean(attachedTmuxSession()),
      attachedTmuxSession()
        ? `windows spawn into '${attachedTmuxSession()}'`
        : "no attached session; falls back to session '0'",
    ],
    [
      "tmux session 0 (fallback)",
      output(["tmux", "has-session", "-t", "0"], { allowFailure: true }).exitCode === 0,
      "used when nothing is attached",
    ],
  ]
  for (const [name, ok, note] of checks) {
    console.log(`${ok ? "ok" : "missing"}\t${name}\t${note}`)
  }
  console.log(`inventory\t${inventoryPath()}`)
  console.log(`repo\t${defaultRepo()}`)
}

export async function inferAndRun(text: string): Promise<void> {
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
    const runtime = lower.includes("claude") ? "claude" : "pi"
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
