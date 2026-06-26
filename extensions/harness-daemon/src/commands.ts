import { randomUUID } from "node:crypto"
import { defaultRepo, inferBranch, normalizeName, now } from "./cli"
import { die } from "./errors"
import { findAgent, inventoryPath, readInventory, upsertAgent } from "./inventory"
import { commandExists, commandPath, output } from "./shell"
import { ClaudeRuntimeSpawner, PiRuntimeSpawner } from "./spawners"
import { sendKeys } from "./tmux"
import type { SpawnOptions } from "./types"

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
  if (!agent.tmuxSession || !agent.tmuxWindow) die(`${agent.name} has no tmux target recorded`)
  const target = `${agent.tmuxSession}:${agent.tmuxWindow}`
  const result = output(["tmux", "kill-window", "-t", target], { allowFailure: true })
  if (result.exitCode !== 0) die(result.stderr.trim() || `tmux kill-window failed for ${target}`)
  upsertAgent({ ...agent, status: "stopped", updatedAt: now() })
  console.log(`harnessd: stopped ${agent.name} (${target})`)
}

function tmuxTarget(ref: string): { session: string; window: string } {
  const agent = findAgent(ref)
  if (!agent.tmuxSession || !agent.tmuxWindow) die(`${agent.name} has no tmux target recorded`)
  return { session: agent.tmuxSession, window: agent.tmuxWindow }
}

/** Send Esc to interrupt the agent's current turn (Claude Code / Pi) without killing the window. */
export function interruptAgent(ref: string): void {
  const { session, window } = tmuxTarget(ref)
  sendKeys(session, window, ["Escape"])
  console.log(`harnessd: interrupted ${session}:${window}`)
}

/** Interrupt the current turn, then (if given) type a follow-up and submit it. */
export function steerAgent(ref: string, text: string): void {
  const { session, window } = tmuxTarget(ref)
  sendKeys(session, window, ["Escape"])
  if (text) {
    // Esc restores the interrupted message into the input box; clear it (Ctrl-U)
    // before typing so the follow-up doesn't concatenate with that residue and
    // submit as a plain prompt.
    sendKeys(session, window, ["C-u"])
    sendKeys(session, window, ["-l", text])
    sendKeys(session, window, ["Enter"])
  }
  console.log(`harnessd: steered ${session}:${window}`)
}

/** Raw `tmux send-keys` passthrough to the agent's window (tokens follow tmux rules). */
export function sendKeysToAgent(ref: string, keys: string[]): void {
  if (keys.length === 0) die("keys requires at least one key or token")
  const { session, window } = tmuxTarget(ref)
  sendKeys(session, window, keys)
  console.log(`harnessd: sent keys to ${session}:${window}`)
}

export function attachAgent(ref: string): void {
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

export function doctor(): void {
  const checks: Array<[string, boolean, string]> = [
    ["bun", commandExists("bun"), "required"],
    ["git", commandExists("git"), "required"],
    ["tmux", commandExists("tmux"), "required"],
    ["docker", commandExists("docker"), "needed for setup:worktree"],
    ["pi", Boolean(process.env.THREA_HARNESSD_PI_BIN || commandPath("pi")), "needed for Pi agents"],
    ["claude", Boolean(process.env.THREA_HARNESSD_CLAUDE_BIN || commandPath("claude")), "needed for Claude agents"],
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
