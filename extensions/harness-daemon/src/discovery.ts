import { basename } from "node:path"
import { hostname } from "node:os"
import { realpathSync } from "node:fs"
import { readHarnessLinks, type HarnessLink } from "@threa/bot-runtime-client"
import { identityRecordsFor, readMintedIdentities, type MintedIdentity } from "./identity-store"
import { output } from "./shell"
import { deriveClaudeRuntimeIdentity, readThreaChannelConfig, sanitizeId } from "./spawners"
import type { ManagedAgent, ThreaChannelConfig } from "./types"

export interface LocalTmuxPane {
  sessionName: string
  windowName: string
  windowId: string
  paneId: string
  panePid: number
  cwd: string
  startCommand: string
}

export interface ClaudeChannelLaunch {
  runtimeSessionId?: string
  instanceId?: string
  name?: string
  mcpConfig?: string
  skipPermissions: boolean
}

export interface ClaudeLaunch {
  executable: string
  name?: string
  resumeSessionId?: string
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
  let resumeSessionId: string | undefined
  let channel: string | undefined
  let mcpConfig: string | undefined
  let skipPermissions = false
  while (index < words.length) {
    const option = words[index++]!
    if (option === "--" || option.includes("=")) return undefined
    if (option === "--resume") {
      const value = words[index++]
      if (resumeSessionId || !value || !UUID_RE.test(value)) return undefined
      resumeSessionId = value
    } else if (option === "--name") {
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
  return channel ? { executable, name, resumeSessionId, channel, mcpConfig, skipPermissions, environment } : undefined
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
  let instanceId: string | undefined
  while (index < words.length) {
    const assignment = parseAssignment(words[index]!)
    if (!assignment) break
    if (assignment.name === "THREA_RUNTIME_SESSION_ID") {
      runtimeSessionId = sanitizeId(assignment.value).slice(0, 64)
    }
    if (assignment.name === "THREA_INSTANCE_ID") instanceId = sanitizeId(assignment.value).slice(0, 64)
    index += 1
  }

  if (index >= words.length || basename(words[index]!) !== "claude") return undefined
  index += 1

  let channel = false
  let name: string | undefined
  let mcpConfig: string | undefined
  let skipPermissions = false
  for (; index < words.length; index += 1) {
    const word = words[index]!
    if (word === "--") break
    const [option, inlineValue] = word.includes("=") ? splitOption(word) : [word, undefined]
    const value = inlineValue ?? words[index + 1]
    if (option === "--dangerously-load-development-channels" && value === "server:threa-channel") channel = true
    else if (option === "--dangerously-skip-permissions") skipPermissions = true
    else if (option === "--name" && value) name = value
    else if (option === "--mcp-config" && value && !value.startsWith("-") && !/^[{[]/.test(value.trim()))
      mcpConfig = value
  }
  return channel ? { runtimeSessionId, instanceId, name, mcpConfig, skipPermissions } : undefined
}

function splitOption(word: string): [string, string] {
  const separator = word.indexOf("=")
  return [word.slice(0, separator), word.slice(separator + 1)]
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

export type ManagedAgentPane =
  | { status: "found"; pane: LocalTmuxPane }
  | { status: "missing" }
  | { status: "ambiguous"; reason: string }
  /** A live pane matching only a recycled id — proof of liveness, never proof it is this agent's. */
  | { status: "unverified"; pane: LocalTmuxPane; reason: string }

/**
 * The live pane a managed agent occupies. tmux ids are NOT identity: a new
 * tmux server restarts numbering at `@0`/`%0`, so a recorded `@169` routinely
 * resolves to an unrelated agent's window — acting on one has killed the wrong
 * worktree. Identity is the runtime session (from the pane's launch command,
 * attested by the harness link ledger, or derived from its cwd),
 * with the worktree as the fallback key for rows predating it. The recorded
 * ids only break a tie between panes that already matched a real key.
 *
 * @param links the harness link ledger, read once per call: a per-pane read
 * would re-scan the whole directory for every pane tmux reports.
 */
export function resolveManagedAgentPane(
  agent: Pick<ManagedAgent, "runtime" | "runtimeSessionId" | "worktree" | "tmuxPaneId" | "tmuxWindowId">,
  panes: LocalTmuxPane[] = listLocalTmuxPanes(),
  config: ThreaChannelConfig = readThreaChannelConfig(),
  host = hostname(),
  links: () => HarnessLink[] = readHarnessLinks,
  identities: () => MintedIdentity[] = readMintedIdentities,
  canonical: (path: string) => string = canonicalOrRaw
): ManagedAgentPane {
  if (agent.runtimeSessionId) {
    try {
      const pane =
        agent.runtime === "pi"
          ? findLocalPiPane(agent.runtimeSessionId, panes)
          : findLocalClaudeChannelPane(agent.runtimeSessionId, panes, config, host, links, identities, canonical)
      return pane ? { status: "found", pane } : { status: "missing" }
    } catch (error) {
      return { status: "ambiguous", reason: error instanceof Error ? error.message : String(error) }
    }
  }

  // Neither key recorded (rows predating both): the id is all there is, and a
  // recycled id points at a stranger's window just as readily as this agent's.
  // Report it as unverified so a liveness check can count it while anything
  // that types into or kills the window refuses.
  if (!agent.worktree) {
    const recorded = panes.find((pane) => agent.tmuxPaneId && pane.paneId === agent.tmuxPaneId)
    return recorded
      ? {
          status: "unverified",
          pane: recorded,
          reason: `only a recycled tmux id (${agent.tmuxPaneId}) identifies this row — no runtime session or worktree recorded`,
        }
      : { status: "missing" }
  }
  const canonicalWorktree = canonical(agent.worktree)
  const inWorktree = panes.filter((pane) => canonical(pane.cwd) === canonicalWorktree)
  if (inWorktree.length === 1) return { status: "found", pane: inWorktree[0]! }
  if (inWorktree.length === 0) return { status: "missing" }
  const recorded = inWorktree.find(
    (pane) =>
      (agent.tmuxPaneId && pane.paneId === agent.tmuxPaneId) ||
      (agent.tmuxWindowId && pane.windowId === agent.tmuxWindowId)
  )
  return recorded
    ? { status: "found", pane: recorded }
    : {
        status: "ambiguous",
        reason: `${inWorktree.length} panes share ${agent.worktree} and none matches the recorded ids`,
      }
}

export function canonicalOrRaw(path: string, canonical: (path: string) => string = realpathSync): string {
  try {
    return canonical(path)
  } catch {
    return path
  }
}

export interface AttestedRuntime {
  worktree: string
  runtimeSessionId: string
  instanceId: string
}

/** Canonicalized once per resolution: a per-pane realpath is panes × records syscalls. */
export function attestedRuntimes(
  links: HarnessLink[],
  canonical: (path: string) => string = canonicalOrRaw
): AttestedRuntime[] {
  return links
    .filter((link) => link.runtimeKind === "claude-code-channel" || link.runtimeKind === "unknown")
    .map((link) => ({
      worktree: canonical(link.worktree),
      runtimeSessionId: link.runtimeSessionId,
      instanceId: link.instanceId,
    }))
}

/**
 * The attested identity of the runtime living in `cwd`, or nothing.
 *
 * Two or more records naming one worktree is a broken ledger, not a tie to
 * break: guessing here binds a live pane to a stranger's session.
 */
export function ledgerIdentity(
  cwd: string,
  attested: AttestedRuntime[],
  canonical: (path: string) => string = canonicalOrRaw
): AttestedRuntime | undefined {
  const canonicalCwd = canonical(cwd)
  const matches = attested.filter((entry) => entry.worktree === canonicalCwd)
  return matches.length === 1 ? matches[0] : undefined
}

export function ledgerRuntimeSessionId(cwd: string, attested: AttestedRuntime[]): string | undefined {
  return ledgerIdentity(cwd, attested)?.runtimeSessionId
}

export type IdentitySource = "declared" | "minted" | "ledger" | "inventory" | "derived"

export interface ResolvedRuntimeIdentity {
  instanceId: string
  runtimeSessionId: string
  /** The rung the runtime session id came from. */
  source: IdentitySource
}

/**
 * What each rung of the resolver knows. An absent field is an absent rung, not
 * an empty answer: `identities: []` means "the store was read and holds
 * nothing", `identities: undefined` means "not consulted".
 */
export interface IdentityEvidence {
  /** The launch environment of the process itself. */
  declared?: { instanceId?: string; runtimeSessionId?: string }
  identities?: MintedIdentity[]
  attested?: AttestedRuntime[]
  /** The inventory row, immutable per launch and therefore stale by construction. */
  inventory?: { instanceId?: string; runtimeSessionId?: string }
  canonical?: (path: string) => string
}

function soleMintedIdentity(
  cwd: string,
  identities: MintedIdentity[],
  canonical: (path: string) => string
): MintedIdentity | undefined {
  const records = identityRecordsFor(cwd, identities, canonical)
  return records.length === 1 ? records[0] : undefined
}

function normalizedId(value: string): string {
  return sanitizeId(value).slice(0, 64)
}

/**
 * The one answer to "what identity does this directory have".
 *
 * Order: what the process itself declares, then the minted record, then the
 * ledger's attestation, then the inventory row, and only then the derivation —
 * which hashes `os.hostname()` and so changes with the wifi network, making a
 * session unrecognisable to its own harness. Two records naming one worktree
 * fall through rather than pick a winner: guessing binds a live pane to a
 * stranger's session.
 *
 * This never answers "may a new process start here". Occupancy is the mint's
 * veto and belongs to the write side; a read path that could refuse would make
 * every lookup a policy decision.
 */
export function resolveRuntimeIdentity(
  cwd: string,
  evidence: IdentityEvidence = {},
  config: ThreaChannelConfig = {},
  host = hostname()
): ResolvedRuntimeIdentity {
  const canonical = evidence.canonical ?? canonicalOrRaw
  const minted = evidence.identities && soleMintedIdentity(cwd, evidence.identities, canonical)
  const ledger = evidence.attested && ledgerIdentity(cwd, evidence.attested, canonical)
  // Only text this daemon did not write is normalized. A recorded id IS the
  // primary key of a file in the link or identity store, and those stores allow
  // characters `sanitizeId` rewrites (dots) with no length cap — normalizing one
  // on the way out maps two distinct sessions onto one id, the exact failure
  // `isSafeSessionFileName` refuses by design.
  const rungs: Array<[IdentitySource, { instanceId?: string; runtimeSessionId?: string }, boolean]> = [
    ["declared", evidence.declared ?? {}, true],
    ["minted", minted ?? {}, false],
    ["ledger", ledger ?? {}, false],
    ["inventory", evidence.inventory ?? {}, false],
    ["derived", deriveClaudeRuntimeIdentity(cwd, config, host), true],
  ]
  const winner = (field: "instanceId" | "runtimeSessionId") => rungs.find(([, value]) => Boolean(value[field]))!
  const [source, session, normalizeSession] = winner("runtimeSessionId")
  const [, instance, normalizeInstance] = winner("instanceId")
  return {
    instanceId: normalizeInstance ? normalizedId(instance.instanceId!) : instance.instanceId!,
    runtimeSessionId: normalizeSession ? normalizedId(session.runtimeSessionId!) : session.runtimeSessionId!,
    source,
  }
}

/**
 * Every distinct identity any store attests for `cwd`, when they disagree.
 *
 * The resolver ranks its rungs, which is right for a read: one answer, most
 * trustworthy source first. A destructive caller needs the opposite question —
 * *is the evidence consistent* — because ranking silently resolves a conflict
 * the writer refused to create. `recordHarnessLink` supersedes by RAW string
 * compare while every reader canonicalizes, so `/repo/x` and `/repo/x/` leave
 * two live records; the mint refuses on that state, and so must anything that
 * kills a window or removes a directory.
 */
export function conflictingAttestations(
  cwd: string,
  attested: AttestedRuntime[],
  identities: MintedIdentity[],
  canonical: (path: string) => string = canonicalOrRaw
): string[] {
  const target = canonical(cwd)
  const ids = new Set<string>()
  for (const entry of attested) if (entry.worktree === target) ids.add(entry.runtimeSessionId)
  for (const record of identityRecordsFor(cwd, identities, canonical)) ids.add(record.runtimeSessionId)
  return ids.size > 1 ? [...ids] : []
}

/**
 * {@link resolveRuntimeIdentity} for the evidence a caller usually has to hand:
 * a live pane, an inventory row, or neither. Unsupplied stores are read here,
 * so every caller sees the same rungs.
 */
export function runtimeIdentityFor(params: {
  cwd: string
  pane?: LocalTmuxPane
  agent?: { instanceId?: string; runtimeSessionId?: string }
  identities?: MintedIdentity[]
  attested?: AttestedRuntime[]
  config?: ThreaChannelConfig
  host?: string
  canonical?: (path: string) => string
}): ResolvedRuntimeIdentity {
  const launch = params.pane ? parseClaudeChannelLaunch(params.pane.startCommand) : undefined
  return resolveRuntimeIdentity(
    params.cwd,
    {
      declared: launch ? { instanceId: launch.instanceId, runtimeSessionId: launch.runtimeSessionId } : undefined,
      identities: params.identities ?? readMintedIdentities(),
      attested: params.attested ?? attestedRuntimes(readHarnessLinks(), params.canonical),
      inventory: params.agent,
      canonical: params.canonical,
    },
    params.config,
    params.host
  )
}

function runtimeSessionIdForPane(
  pane: LocalTmuxPane,
  config: ThreaChannelConfig,
  host: string,
  attested: AttestedRuntime[],
  identities: MintedIdentity[],
  canonical: (path: string) => string
): string | undefined {
  if (!parseClaudeChannelLaunch(pane.startCommand)) return undefined
  return runtimeIdentityFor({ cwd: pane.cwd, pane, identities, attested, config, host, canonical }).runtimeSessionId
}

export function findLocalClaudeChannelPane(
  runtimeSessionId: string,
  panes: LocalTmuxPane[] = listLocalTmuxPanes(),
  config: ThreaChannelConfig = readThreaChannelConfig(),
  host = hostname(),
  links: () => HarnessLink[] = readHarnessLinks,
  identities: () => MintedIdentity[] = readMintedIdentities,
  canonical: (path: string) => string = canonicalOrRaw
): LocalTmuxPane | undefined {
  const attested = attestedRuntimes(links(), canonical)
  const records = identities()
  const matches = panes.filter(
    (pane) => runtimeSessionIdForPane(pane, config, host, attested, records, canonical) === runtimeSessionId
  )
  if (matches.length > 1) {
    throw new Error(
      `multiple live unmanaged Claude channel panes match ${runtimeSessionId}: ${matches.map((pane) => pane.paneId).join(", ")}`
    )
  }
  return matches[0]
}
