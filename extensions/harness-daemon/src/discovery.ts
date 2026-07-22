import { basename } from "node:path"
import { hostname } from "node:os"
import { output } from "./shell"
import { deriveClaudeRuntimeIdentity, readThreaChannelConfig, sanitizeId } from "./spawners"
import type { ThreaChannelConfig } from "./types"

export interface LocalTmuxPane {
  sessionName: string
  windowName: string
  windowId: string
  paneId: string
  panePid: number
  cwd: string
  startCommand: string
}

interface ClaudeChannelLaunch {
  runtimeSessionId?: string
}

function shellWords(input: string): string[] | undefined {
  const words: string[] = []
  let word = ""
  let quote: "'" | '"' | undefined
  let escaped = false
  let started = false

  for (const char of input.trim()) {
    if (escaped) {
      word += char
      escaped = false
      started = true
      continue
    }
    if (char === "\\" && quote !== "'") {
      escaped = true
      started = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else word += char
      started = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        words.push(word)
        word = ""
        started = false
      }
      continue
    }
    word += char
    started = true
  }

  if (quote || escaped) return undefined
  if (started) words.push(word)
  return words
}

function launchWords(command: string): string[] | undefined {
  const firstPass = shellWords(command)
  if (!firstPass) return undefined
  if (firstPass.length !== 1 || !/\s/.test(firstPass[0]!)) return firstPass
  return shellWords(firstPass[0]!)
}

function parseAssignment(word: string): { name: string; value: string } | undefined {
  const match = word.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s)
  return match ? { name: match[1]!, value: match[2]! } : undefined
}

export function parseClaudeChannelLaunch(command: string): ClaudeChannelLaunch | undefined {
  const words = launchWords(command)
  if (!words || words.length === 0) return undefined

  let index = 0
  if (basename(words[index]!) === "env") index += 1

  let runtimeSessionId: string | undefined
  while (index < words.length) {
    const assignment = parseAssignment(words[index]!)
    if (!assignment) break
    if (assignment.name === "THREA_RUNTIME_SESSION_ID") {
      runtimeSessionId = sanitizeId(assignment.value).slice(0, 64)
    }
    index += 1
  }

  if (index >= words.length || basename(words[index]!) !== "claude") return undefined
  index += 1

  let channel = false
  for (; index < words.length; index += 1) {
    const word = words[index]!
    if (word === "--") break
    if (word === "--dangerously-load-development-channels" && words[index + 1] === "server:threa-channel") {
      channel = true
      break
    }
    if (word === "--dangerously-load-development-channels=server:threa-channel") {
      channel = true
      break
    }
  }
  return channel ? { runtimeSessionId } : undefined
}

export function parseTmuxPanes(text: string): LocalTmuxPane[] {
  const panes: LocalTmuxPane[] = []
  for (const line of text.split("\n")) {
    if (!line) continue
    const fields = line.split("\t")
    const [dead, sessionName, windowName, windowId, paneId, panePid, cwd] = fields
    if (dead !== "0" || !sessionName || !windowName || !windowId || !paneId || !panePid || !cwd) continue
    const pid = Number(panePid)
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    panes.push({
      sessionName,
      windowName,
      windowId,
      paneId,
      panePid: pid,
      cwd,
      startCommand: fields.slice(7).join("\t"),
    })
  }
  return panes
}

export function listLocalTmuxPanes(run: typeof output = output): LocalTmuxPane[] {
  const result = run(
    [
      "tmux",
      "list-panes",
      "-a",
      "-F",
      "#{pane_dead}\t#{session_name}\t#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{pane_current_path}\t#{pane_start_command}",
    ],
    { allowFailure: true }
  )
  if (result.exitCode !== 0) {
    throw new Error(`could not inspect local tmux panes: ${result.stderr.trim() || `tmux exited ${result.exitCode}`}`)
  }
  return parseTmuxPanes(result.stdout)
}

function runtimeSessionIdForPane(pane: LocalTmuxPane, config: ThreaChannelConfig, host: string): string | undefined {
  const launch = parseClaudeChannelLaunch(pane.startCommand)
  if (!launch) return undefined
  return launch.runtimeSessionId ?? deriveClaudeRuntimeIdentity(pane.cwd, config, host).runtimeSessionId
}

export function findLocalClaudeChannelPane(
  runtimeSessionId: string,
  panes: LocalTmuxPane[] = listLocalTmuxPanes(),
  config: ThreaChannelConfig = readThreaChannelConfig(),
  host = hostname()
): LocalTmuxPane | undefined {
  const matches = panes.filter((pane) => runtimeSessionIdForPane(pane, config, host) === runtimeSessionId)
  if (matches.length > 1) {
    throw new Error(
      `multiple live unmanaged Claude channel panes match ${runtimeSessionId}: ${matches.map((pane) => pane.paneId).join(", ")}`
    )
  }
  return matches[0]
}
