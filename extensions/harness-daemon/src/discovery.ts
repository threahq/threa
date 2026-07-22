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

export interface ClaudeLaunch {
  executable: string
  name?: string
  channel: string
  mcpConfig?: string
  skipPermissions: boolean
  environment: Array<{ name: string; value: string }>
}

export interface PiLaunch {
  executable: string
  sessionId: string
  environment: Array<{ name: string; value: string }>
}

const CLAUDE_ENVIRONMENT = new Set([
  "THREA_INSTANCE_ID",
  "THREA_RUNTIME_SESSION_ID",
  "THREA_DISPLAY_NAME",
  "THREA_DEFAULT_LABEL",
  "THREA_HARNESSD_ENTRYPOINT",
  "THREA_HARNESSD_BUN_BIN",
  "THREA_COLD_START_IF_ARCHIVED",
  "THREA_COLD_START_IF_MISSING",
  "THREA_EXPECTED_ROOT_STREAM_ID",
])
const PI_ENVIRONMENT = new Set([
  "THREA_HARNESSD_ENTRYPOINT",
  "THREA_HARNESSD_BUN_BIN",
  "THREA_INSTANCE_ID",
  "THREA_RUNTIME_SESSION_ID",
  "THREA_EXPECTED_ROOT_STREAM_ID",
])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function strictShellWords(input: string): string[] | undefined {
  const words: string[] = []
  let word = ""
  let quote: "'" | '"' | undefined
  let started = false

  for (let index = 0; index < input.trim().length; index += 1) {
    const char = input.trim()[index]!
    if (quote === "'") {
      if (char === quote) quote = undefined
      else word += char
      started = true
      continue
    }
    if (quote === '"') {
      if (char === quote) quote = undefined
      else if (char === "\\") {
        const next = input.trim()[index + 1]
        if (next && '$`"\\'.includes(next)) word += input.trim()[++index]!
        else word += char
      } else {
        if (char === "$" || char === "`") return undefined
        word += char
      }
      started = true
      continue
    }
    if (char === "\\") {
      const next = input.trim()[++index]
      if (!next || next === "\n") return undefined
      word += next
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
    if ("$`*?[]{};|&<>".includes(char) || (char === "~" && !started)) return undefined
    word += char
    started = true
  }

  if (quote) return undefined
  if (started) words.push(word)
  return words
}

function strictLaunchWords(command: string): string[] | undefined {
  const firstPass = strictShellWords(command)
  if (!firstPass) return undefined
  if (firstPass.length !== 1 || !/\s/.test(firstPass[0]!)) return firstPass
  return strictShellWords(firstPass[0]!)
}

function permissiveShellWords(input: string): string[] | undefined {
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

function permissiveLaunchWords(command: string): string[] | undefined {
  const firstPass = permissiveShellWords(command)
  if (!firstPass) return undefined
  if (firstPass.length !== 1 || !/\s/.test(firstPass[0]!)) return firstPass
  return permissiveShellWords(firstPass[0]!)
}

function parseAssignment(word: string): { name: string; value: string } | undefined {
  const match = word.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s)
  return match ? { name: match[1]!, value: match[2]! } : undefined
}

export function parsePiLaunch(command: string): PiLaunch | undefined {
  const words = strictLaunchWords(command)
  if (!words?.length) return undefined

  let index = 0
  const environment: PiLaunch["environment"] = []
  const names = new Set<string>()
  if (basename(words[index]!) === "env") {
    index += 1
    while (index < words.length) {
      const assignment = parseAssignment(words[index]!)
      if (!assignment) break
      if (
        !PI_ENVIRONMENT.has(assignment.name) ||
        names.has(assignment.name) ||
        !assignment.value ||
        /[$`*?[\]{};|&<>]/.test(assignment.value)
      )
        return undefined
      names.add(assignment.name)
      environment.push(assignment)
      index += 1
    }
  } else if (parseAssignment(words[index]!)) {
    return undefined
  }

  const executable = words[index]
  if (!executable || basename(executable) !== "pi") return undefined
  index += 1
  if (words.length - index !== 2 || words[index] !== "--session-id") return undefined
  const sessionId = words[index + 1]!
  if (!UUID_RE.test(sessionId)) return undefined
  const runtimeIdentity = environment.find(({ name }) => name === "THREA_RUNTIME_SESSION_ID")?.value
  if (runtimeIdentity && runtimeIdentity !== sessionId) return undefined
  return { executable, sessionId, environment }
}

export function parseClaudeLaunch(command: string): ClaudeLaunch | undefined {
  const words = strictLaunchWords(command)
  if (!words?.length) return undefined
  let index = 0
  const environment: ClaudeLaunch["environment"] = []
  const environmentNames = new Set<string>()
  if (basename(words[index]!) === "env") {
    index += 1
    while (index < words.length) {
      const assignment = parseAssignment(words[index]!)
      if (!assignment) break
      if (
        !CLAUDE_ENVIRONMENT.has(assignment.name) ||
        environmentNames.has(assignment.name) ||
        !assignment.value ||
        /[$`*?[\]{};|&<>]/.test(assignment.value)
      )
        return undefined
      environmentNames.add(assignment.name)
      environment.push(assignment)
      index += 1
    }
  } else if (parseAssignment(words[index]!)) return undefined

  const executable = words[index++]
  if (!executable || basename(executable) !== "claude") return undefined
  let name: string | undefined
  let channel: string | undefined
  let mcpConfig: string | undefined
  let skipPermissions = false
  while (index < words.length) {
    const option = words[index++]!
    if (option === "--" || option === "--resume" || option.includes("=")) return undefined
    if (option === "--name") {
      const value = words[index++]
      if (name || !value?.match(/^threa\.[A-Za-z0-9_-]+$/)) return undefined
      name = value
    } else if (option === "--dangerously-load-development-channels") {
      const value = words[index++]
      if (channel || !value?.match(/^server:[A-Za-z0-9_-]+$/)) return undefined
      channel = value.slice("server:".length)
    } else if (option === "--dangerously-skip-permissions") {
      if (skipPermissions) return undefined
      skipPermissions = true
    } else if (option === "--mcp-config") {
      const value = words[index++]
      if (mcpConfig || !value || value.startsWith("-") || /^[{[]/.test(value.trim())) return undefined
      mcpConfig = value
    } else return undefined
  }
  return channel ? { executable, name, channel, mcpConfig, skipPermissions, environment } : undefined
}

export function findLocalPiPane(
  runtimeSessionId: string,
  panes: LocalTmuxPane[] = listLocalTmuxPanes()
): LocalTmuxPane | undefined {
  const matches = panes.filter((pane) => parsePiLaunch(pane.startCommand)?.sessionId === runtimeSessionId)
  if (matches.length > 1) {
    throw new Error(
      `multiple live standalone Pi panes match ${runtimeSessionId}: ${matches.map((pane) => pane.paneId).join(", ")}`
    )
  }
  return matches[0]
}

export function parseClaudeChannelLaunch(command: string): ClaudeChannelLaunch | undefined {
  const words = permissiveLaunchWords(command)
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
