import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { basename, dirname, join } from "node:path"
import { die } from "./errors"
import { commandExists, commandPath, run, shellQuote } from "./shell"
import { capturePane, createWindow, ensureTmuxSession, pickTmuxWindow, sendKeys, tmuxSession } from "./tmux"
import type { ManagedAgent, ResumeOptions, SpawnOptions, SpawnResult, ThreaChannelConfig } from "./types"
import { recordedNoYolo } from "./resume"
import { ensureWorktree } from "./worktree"

export function mcpConfigPath(name: string): string {
  return join(homedir(), ".threa", "harnessd", "mcp", `${name}.json`)
}

export function configuredThreaBaseUrl(config: ThreaChannelConfig): string {
  return (process.env.THREA_BASE_URL || config.baseUrl || "https://app.threa.io").replace(/\/$/, "")
}

export function claudeLaunchArgs(params: {
  claudeBin: string
  name: string
  channel: string
  mcpConfig?: string
  noYolo?: boolean
}): string[] {
  const args = [params.claudeBin, "--name", `threa.${params.name}`]
  if (params.mcpConfig) {
    args.push("--mcp-config", params.mcpConfig, "--dangerously-load-development-channels", `server:${params.channel}`)
  }
  if (!params.noYolo) args.push("--dangerously-skip-permissions")
  return args
}

function mcpChannel(path: string): string {
  try {
    const mcpServers = JSON.parse(readFileSync(path, "utf8")).mcpServers
    const channels = mcpServers && typeof mcpServers === "object" ? Object.keys(mcpServers) : []
    if (channels.length === 1 && channels[0]) return channels[0]
  } catch {
    // The caller reports the same actionable MCP-config error for malformed JSON.
  }
  die(`MCP config must contain exactly one channel server: ${path}`)
}

/**
 * Configs written before the channel gate required a registration-carried key
 * lack THREA_CHANNEL_SERVER_KEY; without it the channel serves plain and the
 * scratchpad never links. Inject it on resume so old agents keep working.
 */
export function ensureChannelServerKeyEnv(path: string, channel: string): void {
  const parsed = JSON.parse(readFileSync(path, "utf8"))
  const server = parsed.mcpServers?.[channel]
  if (!server || server.env?.THREA_CHANNEL_SERVER_KEY === channel) return
  server.env = { ...server.env, THREA_CHANNEL_SERVER_KEY: channel }
  writeFileSync(path, JSON.stringify(parsed, null, 2))
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

export class PiRuntimeSpawner extends RuntimeSpawner {
  async spawn(options: SpawnOptions): Promise<SpawnResult> {
    if (!commandExists("git")) die("git not found")
    if (!commandExists("tmux")) die("tmux not found")
    if (!commandExists("bun")) die("bun not found")
    const piBin = process.env.THREA_HARNESSD_PI_BIN || commandPath("pi")
    if (!piBin) die("pi binary not found; set THREA_HARNESSD_PI_BIN or put pi on PATH")

    const session = tmuxSession(options)
    ensureTmuxSession(session)
    ensurePiDefaultLabel()
    const { worktree, branch } = this.createWorktree(options)
    const window = pickTmuxWindow(session, options.name)
    const windowId = createWindow(session, window, worktree, piBin)
    console.log(`harnessd: launched Pi in tmux ${session}:${window} (${windowId})`)

    if (!options.noRemote) {
      await Bun.sleep(Number(process.env.THREA_HARNESSD_PI_BOOT_WAIT_MS ?? 8000))
      sendKeys(windowId, ["/remote-control", "Enter"])
      await Bun.sleep(Number(process.env.THREA_HARNESSD_PI_REMOTE_WAIT_MS ?? 6000))
    }

    const outputText = capturePane(windowId)
    return {
      worktree,
      branch,
      tmuxSession: session,
      tmuxWindow: window,
      tmuxWindowId: windowId,
      scratchpadUrl: firstScratchpadUrl(outputText),
      output: outputText,
    }
  }
}

// Boot dialogs (trust prompt, MCP-server approval, update notices) all end
// with an "Enter to confirm/continue" hint; the composer's input line is a
// bare "❯" only once boot has settled (during a dialog that line carries the
// highlighted option, e.g. "❯ 1. Use this MCP server").
const BOOT_DIALOG_RE = /Enter to confirm|Enter to continue/
const IDLE_PROMPT_RE = /^❯\s*$/m

export class ClaudeRuntimeSpawner extends RuntimeSpawner {
  async spawn(options: SpawnOptions): Promise<SpawnResult> {
    if (!commandExists("git")) die("git not found")
    if (!commandExists("tmux")) die("tmux not found")
    if (!commandExists("bun")) die("bun not found")
    const claudeBin = process.env.THREA_HARNESSD_CLAUDE_BIN || commandPath("claude")
    if (!claudeBin) die("claude binary not found; set THREA_HARNESSD_CLAUDE_BIN or put claude on PATH")

    const session = tmuxSession(options)
    ensureTmuxSession(session)
    const { worktree, branch } = this.createWorktree(options)
    const channel = process.env.THREA_HARNESSD_CLAUDE_CHANNEL || "threa-channel"
    const channelDir = join(worktree, "extensions", "claude-code-remote")
    const channelEntry = join(channelDir, "src", "index.ts")
    if (!existsSync(channelEntry)) die(`Claude channel entry not found: ${channelEntry}`)

    console.log("harnessd: installing Claude channel dependencies")
    run(["bun", "install"], { cwd: channelDir })
    // The channel's `file:` dep on the remote-session SDK links the folder but
    // does NOT install the SDK's own deps — bun resolves the SDK's imports from
    // its real path, so it needs its own node_modules. Guarded for worktrees
    // predating the SDK split.
    const sdkDir = join(worktree, "extensions", "remote-session")
    if (existsSync(join(sdkDir, "package.json"))) {
      run(["bun", "install"], { cwd: sdkDir })
    }

    const scratchpadUrl = await this.prelinkScratchpad(worktree)
    if (scratchpadUrl) console.log(`harnessd: scratchpad: ${scratchpadUrl}`)

    const args = claudeLaunchArgs({
      claudeBin,
      name: options.name,
      channel,
      mcpConfig: options.noRegister ? undefined : this.writeMcpConfig(options.name, channel, channelEntry),
      noYolo: options.noYolo,
    })

    const window = pickTmuxWindow(session, options.name)
    const windowId = createWindow(session, window, worktree, args.map(shellQuote).join(" "))
    console.log(`harnessd: launched Claude Code in tmux ${session}:${window} (${windowId})`)

    if (!options.noAutoAccept) await this.acceptBootPrompts(windowId)

    const outputText = capturePane(windowId)
    return {
      worktree,
      branch,
      tmuxSession: session,
      tmuxWindow: window,
      tmuxWindowId: windowId,
      scratchpadUrl: scratchpadUrl ?? firstScratchpadUrl(outputText),
      output: outputText,
    }
  }

  async resume(agent: ManagedAgent, options: ResumeOptions): Promise<SpawnResult> {
    if (!agent.worktree || !existsSync(agent.worktree)) die(`worktree dir missing: ${agent.worktree ?? "<none>"}`)
    if (!commandExists("tmux")) die("tmux not found")
    const claudeBin = process.env.THREA_HARNESSD_CLAUDE_BIN || commandPath("claude")
    if (!claudeBin) die("claude binary not found; set THREA_HARNESSD_CLAUDE_BIN or put claude on PATH")

    const mcpConfig = mcpConfigPath(agent.name)
    if (!existsSync(mcpConfig)) die(`MCP config missing: ${mcpConfig}`)
    const channel = mcpChannel(mcpConfig)
    ensureChannelServerKeyEnv(mcpConfig, channel)
    const session = options.tmux ?? agent.tmuxSession ?? tmuxSession({ runtime: "claude", name: agent.name })
    ensureTmuxSession(session, true)
    const noYolo = recordedNoYolo(agent)
    const window = pickTmuxWindow(session, agent.name)
    const windowId = createWindow(
      session,
      window,
      agent.worktree,
      claudeLaunchArgs({ claudeBin, name: agent.name, channel, mcpConfig, noYolo }).map(shellQuote).join(" ")
    )
    console.log(`harnessd: resumed Claude Code in tmux ${session}:${window} (${windowId})`)
    try {
      await this.acceptBootPrompts(windowId)
      sendKeys(windowId, ["/remote-control", "Enter"])
      await Bun.sleep(Number(process.env.THREA_HARNESSD_CLAUDE_REMOTE_WAIT_MS ?? 2000))
      sendKeys(windowId, ["/rc", "Enter"])
      await Bun.sleep(500)
      const output = capturePane(windowId)
      return {
        worktree: agent.worktree,
        branch: agent.branch ?? agent.name,
        tmuxSession: session,
        tmuxWindow: window,
        tmuxWindowId: windowId,
        scratchpadUrl: agent.scratchpadUrl,
        output,
      }
    } catch (error) {
      run(["tmux", "kill-window", "-t", windowId], { allowFailure: true })
      throw error
    }
  }

  /**
   * Session-scoped MCP wiring via `--mcp-config` instead of `claude mcp add
   * --scope local`: Claude Code resolves every worktree of a repo to the same
   * project entry, so a persisted local-scope registration from worktree A
   * silently repoints worktree B's channel at A's code the next time B starts
   * (and stacks a duplicate channel on top of a user-scope registration). A
   * config file passed at launch binds this session to this worktree's channel
   * and leaves global config untouched.
   */
  private writeMcpConfig(name: string, channel: string, channelEntry: string): string {
    const path = mcpConfigPath(name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify(
        {
          mcpServers: {
            [channel]: {
              type: "stdio",
              command: "bun",
              args: [channelEntry],
              env: { THREA_CHANNEL_SERVER_KEY: channel },
            },
          },
        },
        null,
        2
      )
    )
    return path
  }

  /**
   * Walk Claude Code through its boot dialogs by pressing Enter until the
   * composer prompt is idle. Polling capture-pane beats fixed sleeps: a fast
   * boot isn't held for the full wait and a slow one isn't abandoned with a
   * dialog still open (which left the channel half-wired often enough that the
   * old two-blind-Enters approach needed constant retuning).
   */
  private async acceptBootPrompts(windowId: string): Promise<void> {
    const deadline = Date.now() + Number(process.env.THREA_HARNESSD_CLAUDE_BOOT_WAIT_MS ?? 45_000)
    while (Date.now() < deadline) {
      const text = capturePane(windowId)
      if (BOOT_DIALOG_RE.test(text)) {
        sendKeys(windowId, ["Enter"])
        await Bun.sleep(1000)
        continue
      }
      if (IDLE_PROMPT_RE.test(text)) return
      await Bun.sleep(500)
    }
    console.warn("harnessd: Claude Code boot did not settle before the wait deadline; continuing")
  }

  private async prelinkScratchpad(worktree: string): Promise<string | undefined> {
    const config = readThreaChannelConfig()
    const baseUrl = configuredThreaBaseUrl(config)
    const workspaceId = process.env.THREA_WORKSPACE_ID || config.workspaceId
    const apiKey = process.env.THREA_API_KEY || config.apiKey
    if (!workspaceId || !apiKey) {
      console.warn("harnessd: no Claude channel Threa credentials found; channel will link on startup")
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
      console.warn(`harnessd: could not pre-link Claude scratchpad: ${response.status} ${body.slice(0, 300)}`)
      return undefined
    }
    const json = (await response.json()) as { data?: { streamUrlPath?: string } }
    return json.data?.streamUrlPath ? `${baseUrl}${json.data.streamUrlPath}` : undefined
  }
}

function ensurePiDefaultLabel(): void {
  const path = join(homedir(), ".pi", "agent", "threa-remote.json")
  if (!existsSync(path)) return
  try {
    const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    if (typeof config.defaultLabel === "string" && config.defaultLabel.trim()) return
    writeFileSync(path, `${JSON.stringify({ ...config, defaultLabel: "coding" }, null, 2)}\n`)
    console.log("harnessd: set Pi remote defaultLabel=coding")
  } catch (error) {
    console.warn(`harnessd: could not ensure Pi default label: ${error}`)
  }
}

export function readThreaChannelConfig(): ThreaChannelConfig {
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
