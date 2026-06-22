import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { basename, join } from "node:path"
import { die } from "./errors"
import { commandExists, commandPath, run, shellQuote } from "./shell"
import { capturePane, ensureTmuxSession, pickTmuxWindow, tmuxSession } from "./tmux"
import type { SpawnOptions, SpawnResult, ThreaChannelConfig } from "./types"
import { ensureWorktree } from "./worktree"

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
    const { worktree, branch } = this.createWorktree(options)
    const window = pickTmuxWindow(session, options.name)
    console.log(`harnessd: launching Pi in tmux ${session}:${window}`)
    run(["tmux", "new-window", "-t", session, "-a", "-n", window, "-c", worktree, piBin])

    if (!options.noRemote) {
      await Bun.sleep(Number(process.env.THREA_HARNESSD_PI_BOOT_WAIT_MS ?? 8000))
      run(["tmux", "send-keys", "-t", `${session}:${window}`, "/remote-control", "Enter"])
      await Bun.sleep(Number(process.env.THREA_HARNESSD_PI_REMOTE_WAIT_MS ?? 6000))
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
    const channel = process.env.THREA_HARNESSD_CLAUDE_CHANNEL || "threa"
    const channelDir = join(worktree, "extensions", "claude-code-remote")
    const channelEntry = join(channelDir, "src", "index.ts")
    if (!existsSync(channelEntry)) die(`Claude channel entry not found: ${channelEntry}`)

    console.log("harnessd: installing Claude channel dependencies")
    run(["bun", "install"], { cwd: channelDir })

    const scratchpadUrl = await this.prelinkScratchpad(worktree)
    if (scratchpadUrl) console.log(`harnessd: scratchpad: ${scratchpadUrl}`)

    if (!options.noRegister) {
      console.log(`harnessd: registering Claude MCP server '${channel}'`)
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
    console.log(`harnessd: launching Claude Code in tmux ${session}:${window}`)
    run(["tmux", "new-window", "-t", session, "-a", "-n", window, "-c", worktree, args.map(shellQuote).join(" ")])

    if (!options.noAutoAccept) {
      await Bun.sleep(Number(process.env.THREA_HARNESSD_CLAUDE_BOOT_WAIT_MS ?? 5000))
      run(["tmux", "send-keys", "-t", `${session}:${window}`, "Enter"])
      await Bun.sleep(Number(process.env.THREA_HARNESSD_CLAUDE_ACCEPT_WAIT_MS ?? 6000))
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
