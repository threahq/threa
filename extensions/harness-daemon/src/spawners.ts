import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { basename, dirname, join } from "node:path"
import { acceptClaudeBootPrompts, warnIfBlocked } from "./claude-boot"
import { defaultClaudeDiskDeps, resumableClaudeTranscript } from "./claude-registry"
import { die } from "./errors"
import { commandExists, commandPath, run, shellQuote } from "./shell"
import { capturePane, createWindow, ensureTmuxSession, pickTmuxWindow, sendKeys, tmuxSession } from "./tmux"
import type { ManagedAgent, ResumeOptions, SpawnOptions, SpawnResult, ThreaChannelConfig } from "./types"
import { recordedNoYolo } from "./resume"
import { recordProfileSnapshot } from "./identity-store"
import { mintRuntimeIdentity } from "./mint"
import { plannedWorktreePath, provisionWorkspace } from "./worktree"
import { selectProfile, type Profile } from "./profiles"
import { runtimeIdentityFor, type ResolvedRuntimeIdentity } from "./discovery"

/**
 * Keyed by runtime session id, not the agent name: two agents that share a name
 * shared one config file, so the second silently repointed the first's channel.
 * Old name-keyed files are written past, never deleted — a live pane's recorded
 * launch command still names one, and `reconnect` validates that it exists.
 */
export function mcpConfigDir(): string {
  return process.env.THREA_HARNESSD_MCP_DIR || join(homedir(), ".threa", "harnessd", "mcp")
}

export function mcpConfigPath(runtimeSessionId: string): string {
  return join(mcpConfigDir(), `${runtimeSessionId}.json`)
}

export function configuredThreaBaseUrl(config: ThreaChannelConfig): string {
  return (process.env.THREA_BASE_URL || config.baseUrl || "https://app.threa.io").replace(/\/$/, "")
}

export function piLaunchArgs(piBin: string, runtimeSessionId: string): string[] {
  return [piBin, "--session-id", runtimeSessionId]
}

function harnessDaemonEnvironment(): string[] {
  return [
    `THREA_HARNESSD_ENTRYPOINT=${process.env.THREA_HARNESSD_ENTRYPOINT || join(import.meta.dir, "index.ts")}`,
    `THREA_HARNESSD_BUN_BIN=${process.env.THREA_HARNESSD_BUN_BIN || process.execPath}`,
  ]
}

export function piLaunchCommand(piBin: string, runtimeSessionId: string): string {
  return ["env", ...harnessDaemonEnvironment(), ...piLaunchArgs(piBin, runtimeSessionId)].map(shellQuote).join(" ")
}

export function piResumeCommand(piBin: string, runtimeSessionId: string, expectedRootStreamId: string): string {
  return [
    "env",
    ...harnessDaemonEnvironment(),
    `THREA_EXPECTED_ROOT_STREAM_ID=${expectedRootStreamId}`,
    ...piLaunchArgs(piBin, runtimeSessionId),
  ]
    .map(shellQuote)
    .join(" ")
}

export function claudeLaunchArgs(params: {
  claudeBin: string
  name: string
  channel: string
  mcpConfig?: string
  noYolo?: boolean
  /** Set only by a takeover: continue this native conversation instead of starting one. */
  resumeSessionId?: string
}): string[] {
  const args = [params.claudeBin]
  if (params.resumeSessionId) args.push("--resume", params.resumeSessionId)
  args.push("--name", `threa.${params.name}`)
  if (params.mcpConfig) {
    args.push("--mcp-config", params.mcpConfig, "--dangerously-load-development-channels", `server:${params.channel}`)
  }
  if (!params.noYolo) args.push("--dangerously-skip-permissions")
  return args
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
export function writeChannelMcpConfig(runtimeSessionId: string, channel: string, channelEntry: string): string {
  const path = mcpConfigPath(runtimeSessionId)
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

function scratchpadStreamId(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return new URL(value).pathname.match(/\/s\/(stream_[A-Za-z0-9]+)(?:\/|$)/)?.[1]
  } catch {
    return undefined
  }
}

export interface PiRemoteSession {
  instanceId: string
  rootStreamId: string
  scratchpadUrl: string
}

export interface PiRemoteConfig extends ThreaChannelConfig {
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

export class RuntimeSpawnError extends Error {
  constructor(
    cause: unknown,
    readonly partial: Partial<SpawnResult>
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = "RuntimeSpawnError"
  }
}

abstract class RuntimeSpawner {
  abstract spawn(options: SpawnOptions): Promise<SpawnResult>

  protected profileFor(options: SpawnOptions): Profile {
    return selectProfile(options)
  }

  protected createWorktree(options: SpawnOptions, profile: Profile): { worktree: string; branch: string } {
    return provisionWorkspace(options, profile)
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
    const profile = this.profileFor(options)
    const { worktree, branch } = this.createWorktree(options, profile)
    const runtimeSessionId = randomUUID()
    // Pi does not mint, but the mint record is where the profile snapshot lives
    // and the reaper reads it by worktree — `pi-local` links are reaped too. With
    // no snapshot the reaper falls back to the built-in default, which commits,
    // pushes and reclaims: exactly the wrong answer for a `--cwd` directory the
    // operator owns, and it would drop the declared teardown silently.
    recordProfileSnapshot({ worktree, runtimeSessionId, runtimeKind: "pi-local", profile })
    const partial: Partial<SpawnResult> = { worktree, branch, tmuxSession: session, runtimeSessionId }
    try {
      const window = pickTmuxWindow(session, options.name)
      const { windowId, paneId } = createWindow(session, window, worktree, piLaunchCommand(piBin, runtimeSessionId))
      Object.assign(partial, { tmuxWindow: window, tmuxWindowId: windowId, tmuxPaneId: paneId })
      console.log(`harnessd: launched Pi in tmux ${session}:${window} (${windowId})`)

      if (!options.noRemote) {
        await Bun.sleep(Number(process.env.THREA_HARNESSD_PI_BOOT_WAIT_MS ?? 8000))
        sendKeys(paneId, ["/remote-control", "Enter"])
        await Bun.sleep(Number(process.env.THREA_HARNESSD_PI_REMOTE_WAIT_MS ?? 6000))
      }

      const outputText = capturePane(paneId)
      const link = readPiRemoteSession(runtimeSessionId)
      return {
        worktree,
        branch,
        tmuxSession: session,
        tmuxWindow: window,
        tmuxWindowId: windowId,
        tmuxPaneId: paneId,
        scratchpadUrl: link?.scratchpadUrl ?? firstScratchpadUrl(outputText),
        instanceId: link?.instanceId,
        runtimeSessionId,
        output: outputText,
      }
    } catch (error) {
      throw new RuntimeSpawnError(error, partial)
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
    const { windowId, paneId } = createWindow(
      session,
      window,
      agent.worktree,
      piResumeCommand(
        piBin,
        agent.runtimeSessionId,
        scratchpadStreamId(agent.scratchpadUrl) ?? die(`invalid scratchpad URL: ${agent.scratchpadUrl ?? "<none>"}`)
      )
    )
    await Bun.sleep(Number(process.env.THREA_HARNESSD_PI_BOOT_WAIT_MS ?? 8000))
    const output = capturePane(paneId)
    return {
      worktree: agent.worktree,
      branch: agent.branch ?? agent.name,
      tmuxSession: session,
      tmuxWindow: window,
      tmuxWindowId: windowId,
      tmuxPaneId: paneId,
      scratchpadUrl: agent.scratchpadUrl,
      instanceId: agent.instanceId,
      runtimeSessionId: agent.runtimeSessionId,
      output,
    }
  }
}

export function prepareClaudeChannel(): string {
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

    const config = readThreaChannelConfig()
    const profile = this.profileFor(options)
    // Minted against the path the worktree WILL occupy, before anything exists.
    // Minting after `git worktree add` meant a refusal — or the lock timing out
    // behind a long revival sweep — stranded a directory and a branch that no
    // inventory row points at, and the next spawn of that name died on the
    // leftover. It is also the only ordering under which the occupancy veto can
    // see a live Claude already squatting the target.
    const minted = await mintRuntimeIdentity({
      worktree: plannedWorktreePath(options, profile),
      runtimeKind: "claude-code-channel",
      requireVacant: true,
      declared: { instanceId: config.instanceId, runtimeSessionId: config.runtimeSessionId },
      profile,
    })
    if (minted.status === "refused") die(`harnessd: refusing to spawn — ${minted.reason}`)
    const identity = { instanceId: minted.instanceId, runtimeSessionId: minted.runtimeSessionId }

    const session = tmuxSession(options)
    ensureTmuxSession(session)
    const { worktree, branch } = this.createWorktree(options, profile)
    const partial: Partial<SpawnResult> = {
      worktree,
      branch,
      tmuxSession: session,
      instanceId: identity.instanceId,
      runtimeSessionId: identity.runtimeSessionId,
    }
    try {
      const channel = process.env.THREA_HARNESSD_CLAUDE_CHANNEL || "threa-channel"
      const channelEntry = prepareClaudeChannel()
      const scratchpadUrl = await this.prelinkScratchpad(worktree, identity, config)
      if (scratchpadUrl) {
        partial.scratchpadUrl = scratchpadUrl
        console.log(`harnessd: scratchpad: ${scratchpadUrl}`)
      }

      const args = claudeLaunchArgs({
        claudeBin,
        name: options.name,
        channel,
        mcpConfig: options.noRegister
          ? undefined
          : this.writeMcpConfig(identity.runtimeSessionId, channel, channelEntry),
        noYolo: options.noYolo,
      })

      const window = pickTmuxWindow(session, options.name)
      const { windowId, paneId } = createWindow(session, window, worktree, claudeLaunchCommand(args, identity, config))
      Object.assign(partial, { tmuxWindow: window, tmuxWindowId: windowId, tmuxPaneId: paneId })
      console.log(`harnessd: launched Claude Code in tmux ${session}:${window} (${windowId})`)

      if (!options.noAutoAccept) warnIfBlocked(await acceptClaudeBootPrompts(paneId))

      const outputText = capturePane(paneId)
      return {
        worktree,
        branch,
        tmuxSession: session,
        tmuxWindow: window,
        tmuxWindowId: windowId,
        tmuxPaneId: paneId,
        scratchpadUrl: scratchpadUrl ?? firstScratchpadUrl(outputText),
        instanceId: identity.instanceId,
        runtimeSessionId: identity.runtimeSessionId,
        output: outputText,
      }
    } catch (error) {
      throw new RuntimeSpawnError(error, partial)
    }
  }

  async resume(agent: ManagedAgent, options: ResumeOptions): Promise<SpawnResult> {
    if (!agent.worktree || !existsSync(agent.worktree)) die(`worktree dir missing: ${agent.worktree ?? "<none>"}`)
    if (!commandExists("tmux")) die("tmux not found")
    const claudeBin = process.env.THREA_HARNESSD_CLAUDE_BIN || commandPath("claude")
    if (!claudeBin) die("claude binary not found; set THREA_HARNESSD_CLAUDE_BIN or put claude on PATH")

    const channel = process.env.THREA_HARNESSD_CLAUDE_CHANNEL || "threa-channel"
    const channelEntry = prepareClaudeChannel()
    const config = readThreaChannelConfig()
    const identity = claudeAgentIdentity(agent, config)
    const mcpConfig = mcpConfigPath(identity.runtimeSessionId)
    if (!existsSync(mcpConfig)) this.writeMcpConfig(identity.runtimeSessionId, channel, channelEntry)
    normalizeChannelMcpConfig(mcpConfig, channel, channelEntry)
    const session = options.tmux ?? agent.tmuxSession ?? tmuxSession({ runtime: "claude", name: agent.name })
    ensureTmuxSession(session, true)
    const noYolo = recordedNoYolo(agent)
    // "Bring it back up as it was" has to include the conversation. Without
    // --resume a revival silently starts an empty session in the old worktree,
    // still attached to the same scratchpad, and the history is only reachable
    // by hand. A transcript a live process still holds is skipped, never shared.
    const transcript = resumableClaudeTranscript(agent.worktree, defaultClaudeDiskDeps())
    console.log(
      transcript
        ? `harnessd: resuming Claude conversation ${transcript.sessionId} for ${agent.name}`
        : `harnessd: no resumable Claude transcript in ${agent.worktree}; starting a fresh conversation`
    )
    const window = pickTmuxWindow(session, agent.name)
    const { windowId, paneId } = createWindow(
      session,
      window,
      agent.worktree,
      claudeLaunchCommand(
        claudeLaunchArgs({
          claudeBin,
          name: agent.name,
          channel,
          mcpConfig,
          noYolo,
          resumeSessionId: transcript?.sessionId,
        }),
        identity,
        config,
        "wait",
        "error",
        scratchpadStreamId(agent.scratchpadUrl) ?? die(`invalid scratchpad URL: ${agent.scratchpadUrl ?? "<none>"}`)
      )
    )
    console.log(`harnessd: resumed Claude Code in tmux ${session}:${window} (${windowId})`)
    try {
      warnIfBlocked(await acceptClaudeBootPrompts(paneId))
      // Claude's own /remote-control (claude.ai/code, the mobile app) is not
      // how a session reaches Threa — the channel MCP server is, and it is
      // already wired above. Sending it opened a MODAL dialog every revival
      // then parked in ("waitingFor":"dialog open" in Claude's registry), and
      // the /rc that followed was typed into that dialog as garbage. `spawn`
      // never sent either. Opt-in for anyone who does want the mobile app.
      if (process.env.THREA_HARNESSD_CLAUDE_REMOTE_CONTROL === "1") {
        sendKeys(paneId, ["/remote-control", "Enter"])
        await Bun.sleep(Number(process.env.THREA_HARNESSD_CLAUDE_REMOTE_WAIT_MS ?? 2000))
      }
      const output = capturePane(paneId)
      return {
        worktree: agent.worktree,
        branch: agent.branch ?? agent.name,
        tmuxSession: session,
        tmuxWindow: window,
        tmuxWindowId: windowId,
        tmuxPaneId: paneId,
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

  private writeMcpConfig(runtimeSessionId: string, channel: string, channelEntry: string): string {
    return writeChannelMcpConfig(runtimeSessionId, channel, channelEntry)
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
      signal: AbortSignal.timeout(10_000),
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

export const CLAUDE_INSTANCE_ID_PREFIX = "cc"
export const CLAUDE_RUNTIME_SESSION_ID_PREFIX = "ccs"

export function deriveClaudeRuntimeIdentity(
  worktree: string,
  config: ThreaChannelConfig = {},
  host = hostname()
): { instanceId: string; runtimeSessionId: string } {
  const seed = `${host}:${worktree}`
  return {
    instanceId: sanitizeId(config.instanceId || stableId(CLAUDE_INSTANCE_ID_PREFIX, seed)).slice(0, 64),
    runtimeSessionId: sanitizeId(config.runtimeSessionId || stableId(CLAUDE_RUNTIME_SESSION_ID_PREFIX, seed)).slice(
      0,
      64
    ),
  }
}

/**
 * The identity a managed Claude row runs under, through the one resolver: a
 * revival reuses the recorded identity instead of computing a new one from a
 * hostname that has since changed.
 */
export function claudeAgentIdentity(
  agent: Pick<ManagedAgent, "worktree" | "instanceId" | "runtimeSessionId">,
  config: ThreaChannelConfig = readThreaChannelConfig()
): ResolvedRuntimeIdentity {
  return runtimeIdentityFor({
    cwd: agent.worktree ?? "",
    agent: { instanceId: agent.instanceId, runtimeSessionId: agent.runtimeSessionId },
    config,
  })
}

export function claudeLaunchCommand(
  args: string[],
  identity: { instanceId: string; runtimeSessionId: string },
  config: ThreaChannelConfig = {},
  coldStartIfArchived: "wait" | "replace" = "replace",
  coldStartIfMissing: "create" | "error" = "create",
  expectedRootStreamId?: string
): string {
  const environment = {
    THREA_INSTANCE_ID: identity.instanceId,
    THREA_RUNTIME_SESSION_ID: identity.runtimeSessionId,
    THREA_DISPLAY_NAME: process.env.THREA_DISPLAY_NAME || config.displayName || "Claude Code",
    THREA_DEFAULT_LABEL: process.env.THREA_DEFAULT_LABEL || config.defaultLabel || "coding",
    THREA_HARNESSD_ENTRYPOINT: process.env.THREA_HARNESSD_ENTRYPOINT || join(import.meta.dir, "index.ts"),
    THREA_HARNESSD_BUN_BIN: process.env.THREA_HARNESSD_BUN_BIN || process.execPath,
    THREA_COLD_START_IF_ARCHIVED: coldStartIfArchived,
    THREA_COLD_START_IF_MISSING: coldStartIfMissing,
    ...(expectedRootStreamId ? { THREA_EXPECTED_ROOT_STREAM_ID: expectedRootStreamId } : {}),
  }
  return ["env", ...Object.entries(environment).map(([key, value]) => `${key}=${value}`), ...args]
    .map(shellQuote)
    .join(" ")
}

export function sanitizeId(value: string): string {
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
