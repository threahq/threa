import { createHash, randomUUID } from "node:crypto"
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

export function piLaunchArgs(piBin: string, runtimeSessionId: string): string[] {
  return [piBin, "--session-id", runtimeSessionId]
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

export function normalizeChannelMcpConfig(path: string, channel: string, channelEntry: string): void {
  const parsed = JSON.parse(readFileSync(path, "utf8"))
  const servers = parsed.mcpServers
  const entries = servers && typeof servers === "object" ? Object.entries(servers) : []
  if (entries.length !== 1 || !entries[0]) die(`MCP config must contain exactly one channel server: ${path}`)
  const [, server] = entries[0] as [string, Record<string, unknown>]
  parsed.mcpServers = {
    [channel]: {
      ...server,
      type: "stdio",
      command: "bun",
      args: [channelEntry],
      env: { ...((server.env as Record<string, unknown> | undefined) ?? {}), THREA_CHANNEL_SERVER_KEY: channel },
    },
  }
  writeFileSync(path, JSON.stringify(parsed, null, 2))
}

function firstScratchpadUrl(text: string): string | undefined {
  return text.match(/https:\/\/app\.threa\.io\/[^\s)]+/)?.[0]
}

export interface PiRemoteSession {
  instanceId: string
  rootStreamId: string
  scratchpadUrl: string
}

interface PiRemoteConfig extends ThreaChannelConfig {
  defaultDisplayName?: string
  linkedSessions?: Record<
    string,
    { instanceId?: string; rootStreamId?: string; activeStreamId?: string; enabled?: boolean }
  >
}

export function readPiRemoteConfig(): PiRemoteConfig {
  const path = join(homedir(), ".pi", "agent", "threa-remote.json")
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PiRemoteConfig
  } catch {
    return {}
  }
}

export function readPiRemoteSession(runtimeSessionId: string): PiRemoteSession | undefined {
  try {
    const config = readPiRemoteConfig()
    const link = config.linkedSessions?.[runtimeSessionId]
    if (!link?.instanceId || !link.rootStreamId || link.enabled === false || !config.workspaceId) return undefined
    const baseUrl = (config.baseUrl || "https://app.threa.io").replace(/\/$/, "")
    return {
      instanceId: link.instanceId,
      rootStreamId: link.rootStreamId,
      scratchpadUrl: `${baseUrl}/w/${config.workspaceId}/s/${link.rootStreamId}`,
    }
  } catch {
    return undefined
  }
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
    const runtimeSessionId = randomUUID()
    const window = pickTmuxWindow(session, options.name)
    const windowId = createWindow(
      session,
      window,
      worktree,
      piLaunchArgs(piBin, runtimeSessionId).map(shellQuote).join(" ")
    )
    console.log(`harnessd: launched Pi in tmux ${session}:${window} (${windowId})`)

    if (!options.noRemote) {
      await Bun.sleep(Number(process.env.THREA_HARNESSD_PI_BOOT_WAIT_MS ?? 8000))
      sendKeys(windowId, ["/remote-control", "Enter"])
      await Bun.sleep(Number(process.env.THREA_HARNESSD_PI_REMOTE_WAIT_MS ?? 6000))
    }

    const outputText = capturePane(windowId)
    const link = readPiRemoteSession(runtimeSessionId)
    return {
      worktree,
      branch,
      tmuxSession: session,
      tmuxWindow: window,
      tmuxWindowId: windowId,
      scratchpadUrl: link?.scratchpadUrl ?? firstScratchpadUrl(outputText),
      instanceId: link?.instanceId,
      runtimeSessionId,
      output: outputText,
    }
  }

  async resume(agent: ManagedAgent, options: ResumeOptions): Promise<SpawnResult> {
    if (!agent.worktree || !existsSync(agent.worktree)) die(`worktree dir missing: ${agent.worktree ?? "<none>"}`)
    if (!agent.runtimeSessionId) die("original Pi session id is not recorded")
    if (!commandExists("tmux")) die("tmux not found")
    const piBin = process.env.THREA_HARNESSD_PI_BIN || commandPath("pi")
    if (!piBin) die("pi binary not found; set THREA_HARNESSD_PI_BIN or put pi on PATH")

    const session = options.tmux ?? agent.tmuxSession ?? tmuxSession({ runtime: "pi", name: agent.name })
    ensureTmuxSession(session, true)
    const window = pickTmuxWindow(session, agent.name)
    const windowId = createWindow(
      session,
      window,
      agent.worktree,
      piLaunchArgs(piBin, agent.runtimeSessionId).map(shellQuote).join(" ")
    )
    await Bun.sleep(Number(process.env.THREA_HARNESSD_PI_BOOT_WAIT_MS ?? 8000))
    const output = capturePane(windowId)
    return {
      worktree: agent.worktree,
      branch: agent.branch ?? agent.name,
      tmuxSession: session,
      tmuxWindow: window,
      tmuxWindowId: windowId,
      scratchpadUrl: agent.scratchpadUrl,
      instanceId: agent.instanceId,
      runtimeSessionId: agent.runtimeSessionId,
      output,
    }
  }
}

// Boot dialogs (trust prompt, MCP-server approval, update notices) all end
// with an "Enter to confirm/continue" hint; the composer's input line is a
// bare "❯" only once boot has settled (during a dialog that line carries the
// highlighted option, e.g. "❯ 1. Use this MCP server").
const BOOT_DIALOG_RE = /Enter to confirm|Enter to continue/
const IDLE_PROMPT_RE = /^❯\s*$/m

function prepareClaudeChannel(): string {
  const channelDir = join(import.meta.dir, "..", "..", "claude-code-remote")
  const channelEntry = join(channelDir, "src", "index.ts")
  if (!existsSync(channelEntry)) die(`Claude channel entry not found: ${channelEntry}`)
  if (!existsSync(join(channelDir, "node_modules"))) {
    console.log("harnessd: installing Claude channel dependencies")
    run(["bun", "install"], { cwd: channelDir })
  }
  // Bun resolves the file dependency from the SDK's real directory, so that
  // package needs its own installed dependencies too.
  const sdkDir = join(channelDir, "..", "remote-session")
  if (existsSync(join(sdkDir, "package.json")) && !existsSync(join(sdkDir, "node_modules"))) {
    run(["bun", "install"], { cwd: sdkDir })
  }
  return channelEntry
}

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
    const channelEntry = prepareClaudeChannel()

    const config = readThreaChannelConfig()
    const identity = claudeRuntimeIdentity(worktree, config)
    const scratchpadUrl = await this.prelinkScratchpad(worktree, identity, config)
    if (scratchpadUrl) console.log(`harnessd: scratchpad: ${scratchpadUrl}`)

    const args = claudeLaunchArgs({
      claudeBin,
      name: options.name,
      channel,
      mcpConfig: options.noRegister ? undefined : this.writeMcpConfig(options.name, channel, channelEntry),
      noYolo: options.noYolo,
    })

    const window = pickTmuxWindow(session, options.name)
    const windowId = createWindow(session, window, worktree, claudeLaunchCommand(args, identity, config))
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
      instanceId: identity.instanceId,
      runtimeSessionId: identity.runtimeSessionId,
      output: outputText,
    }
  }

  async resume(agent: ManagedAgent, options: ResumeOptions): Promise<SpawnResult> {
    if (!agent.worktree || !existsSync(agent.worktree)) die(`worktree dir missing: ${agent.worktree ?? "<none>"}`)
    if (!commandExists("tmux")) die("tmux not found")
    const claudeBin = process.env.THREA_HARNESSD_CLAUDE_BIN || commandPath("claude")
    if (!claudeBin) die("claude binary not found; set THREA_HARNESSD_CLAUDE_BIN or put claude on PATH")

    const channel = process.env.THREA_HARNESSD_CLAUDE_CHANNEL || "threa-channel"
    const channelEntry = prepareClaudeChannel()
    const mcpConfig = mcpConfigPath(agent.name)
    if (!existsSync(mcpConfig)) this.writeMcpConfig(agent.name, channel, channelEntry)
    normalizeChannelMcpConfig(mcpConfig, channel, channelEntry)
    const config = readThreaChannelConfig()
    const derived = claudeRuntimeIdentity(agent.worktree, config)
    const identity = {
      instanceId: agent.instanceId ?? derived.instanceId,
      runtimeSessionId: agent.runtimeSessionId ?? derived.runtimeSessionId,
    }
    const session = options.tmux ?? agent.tmuxSession ?? tmuxSession({ runtime: "claude", name: agent.name })
    ensureTmuxSession(session, true)
    const noYolo = recordedNoYolo(agent)
    const window = pickTmuxWindow(session, agent.name)
    const windowId = createWindow(
      session,
      window,
      agent.worktree,
      claudeLaunchCommand(
        claudeLaunchArgs({ claudeBin, name: agent.name, channel, mcpConfig, noYolo }),
        identity,
        config,
        "wait"
      )
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
        instanceId: identity.instanceId,
        runtimeSessionId: identity.runtimeSessionId,
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
   * config file passed at launch binds this session to the supervisor's current
   * channel implementation and leaves global config untouched. This also keeps
   * revived feature branches from loading an obsolete connector.
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

  private async prelinkScratchpad(
    worktree: string,
    identity: { instanceId: string; runtimeSessionId: string },
    config: ThreaChannelConfig
  ): Promise<string | undefined> {
    const baseUrl = configuredThreaBaseUrl(config)
    const workspaceId = process.env.THREA_WORKSPACE_ID || config.workspaceId
    const apiKey = process.env.THREA_API_KEY || config.apiKey
    if (!workspaceId || !apiKey) {
      console.warn("harnessd: no Claude channel Threa credentials found; channel will link on startup")
      return undefined
    }

    const displayName = defaultDisplayName(worktree, process.env.THREA_DISPLAY_NAME || config.displayName)
    const labelName = process.env.THREA_DEFAULT_LABEL || config.defaultLabel

    const response = await fetch(`${baseUrl}/api/v1/workspaces/${workspaceId}/bot-runtime/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        runtimeKind: "claude-code-channel",
        instanceId: identity.instanceId,
        runtimeSessionId: identity.runtimeSessionId,
        displayName,
        localCwd: worktree,
        ...(labelName ? { labelName } : {}),
        ifArchived: "wait",
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

export function claudeRuntimeIdentity(
  worktree: string,
  config: ThreaChannelConfig = {},
  host = hostname()
): { instanceId: string; runtimeSessionId: string } {
  const seed = `${host}:${worktree}`
  return {
    instanceId: sanitizeId(process.env.THREA_INSTANCE_ID || config.instanceId || stableId("cc", seed)).slice(0, 64),
    runtimeSessionId: sanitizeId(
      process.env.THREA_RUNTIME_SESSION_ID || config.runtimeSessionId || stableId("ccs", seed)
    ).slice(0, 64),
  }
}

export function claudeLaunchCommand(
  args: string[],
  identity: { instanceId: string; runtimeSessionId: string },
  config: ThreaChannelConfig = {},
  coldStartIfArchived: "wait" | "replace" = "replace"
): string {
  const environment = {
    THREA_INSTANCE_ID: identity.instanceId,
    THREA_RUNTIME_SESSION_ID: identity.runtimeSessionId,
    THREA_DISPLAY_NAME: process.env.THREA_DISPLAY_NAME || config.displayName || "Claude Code",
    THREA_DEFAULT_LABEL: process.env.THREA_DEFAULT_LABEL || config.defaultLabel || "coding",
    THREA_COLD_START_IF_ARCHIVED: coldStartIfArchived,
  }
  return ["env", ...Object.entries(environment).map(([key, value]) => `${key}=${value}`), ...args]
    .map(shellQuote)
    .join(" ")
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
