import { randomUUID } from "node:crypto"
import { defaultRepo, inferBranch, normalizeName, now } from "./cli"
import { die } from "./errors"
import { findAgent, inventoryPath, readInventory, upsertAgent } from "./inventory"
import { commandExists, commandPath, output } from "./shell"
import { ClaudeRuntimeSpawner, PiRuntimeSpawner } from "./spawners"
import { attachedTmuxSession, sendKeys } from "./tmux"
import type { ManagedAgent, SpawnOptions } from "./types"

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
