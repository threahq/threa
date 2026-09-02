import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { processAlive } from "./lock"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface ClaudeNativeSession {
  pid: number
  sessionId: string
  cwd: string
  procStart: string
  name?: string
  status: string
}

export interface ClaudeRegistryDeps {
  read(path: string): string
  exists(path: string): boolean
  canonical(path: string): string
  processStart(pid: number): string | undefined
  home: string
}

/**
 * The process generation Claude Code records as `procStart`: the start time in
 * clock ticks since boot, field 22 of `/proc/<pid>/stat`, compared as the
 * string it is. Undefined when the process is gone or the record is not a
 * stat line, so the callers' indeterminate path applies rather than a guess.
 */
export function procStatStartTime(
  pid: number,
  read: (path: string) => string = (p) => readFileSync(p, "utf8")
): string | undefined {
  let stat: string
  try {
    stat = read(`/proc/${pid}/stat`)
  } catch {
    return undefined
  }
  // The comm field is parenthesised and may itself contain spaces or ')', so
  // the fixed-width fields only start after the LAST ')'.
  const commEnd = stat.lastIndexOf(")")
  if (commEnd < 0) return undefined
  const tail = stat
    .slice(commEnd + 1)
    .trim()
    .split(/\s+/)
  // tail[0] is field 3 (state), so field 22 sits at index 19.
  const startTime = tail[19]
  return startTime && /^\d+$/.test(startTime) ? startTime : undefined
}

export function defaultClaudeRegistryDeps(): ClaudeRegistryDeps {
  return {
    read: (path) => readFileSync(path, "utf8"),
    exists: existsSync,
    canonical: realpathSync,
    processStart: (pid) => procStatStartTime(pid),
    home: homedir(),
  }
}

export function projectDirectory(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-")
}

/**
 * The extra filesystem reach a cold takeover needs: the live registry answers
 * "which session is this pid running", but a takeover starts from a pid that is
 * gone, so it enumerates instead.
 */
export interface ClaudeDiskDeps extends ClaudeRegistryDeps {
  list(path: string): string[]
  modified(path: string): number
  alive(pid: number): boolean
}

export function defaultClaudeDiskDeps(): ClaudeDiskDeps {
  return {
    ...defaultClaudeRegistryDeps(),
    list: (path) => {
      try {
        return readdirSync(path)
      } catch {
        return []
      }
    },
    modified: (path) => statSync(path).mtimeMs,
    alive: processAlive,
  }
}

/**
 * Every Claude process still running in `cwd`, by registry entry corroborated
 * against the live process table.
 *
 * A cold takeover resumes a transcript, and resuming one that a surviving
 * process still holds gives two Claudes writing the same conversation. The pane
 * is not enough to rule that out: a process detached from tmux (or whose window
 * was killed while it kept running) leaves no pane but is very much alive.
 */
export function liveClaudePidsIn(cwd: string, deps: ClaudeDiskDeps = defaultClaudeDiskDeps()): number[] {
  return findLiveClaudeSessions(cwd, deps).map((session) => session.pid)
}

export function findLiveClaudeSessions(cwd: string, deps: ClaudeDiskDeps): ClaudeNativeSession[] {
  let target: string
  try {
    target = deps.canonical(cwd)
  } catch {
    return []
  }
  const directory = join(deps.home, ".claude", "sessions")
  const live: ClaudeNativeSession[] = []
  for (const entry of deps.list(directory)) {
    const pid = Number(entry.match(/^(\d+)\.json$/)?.[1])
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    let value: unknown
    try {
      value = JSON.parse(deps.read(join(directory, entry)))
    } catch {
      continue
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const row = value as Record<string, unknown>
    if (
      row.pid !== pid ||
      typeof row.sessionId !== "string" ||
      !UUID_RE.test(row.sessionId) ||
      typeof row.cwd !== "string" ||
      typeof row.procStart !== "string" ||
      typeof row.status !== "string"
    )
      continue
    let registryCwd: string
    try {
      registryCwd = deps.canonical(row.cwd)
    } catch {
      continue
    }
    if (registryCwd !== target) continue
    // Liveness first, and it must be decided by something that cannot fail
    // ambiguously: `ps` exits nonzero both for "no such pid" and for "ps itself
    // failed", so reading undefined as "dead" would let one bad `ps` hide a
    // live Claude — defeating the occupied guard and the held-transcript filter
    // in the same instant. kill(pid, 0) answers only the question asked.
    if (!deps.alive(pid)) continue
    // pids are recycled; the start instant is what makes the entry this
    // process. Indeterminate (undefined) keeps it: a live pid the registry
    // claims is Claude is not something to launch a second Claude next to.
    const started = deps.processStart(pid)
    if (started !== undefined && started !== row.procStart) continue
    live.push({
      pid,
      sessionId: row.sessionId,
      cwd: registryCwd,
      procStart: row.procStart,
      name: typeof row.name === "string" ? row.name : undefined,
      status: row.status,
    })
  }
  return live
}

export interface ClaudeTranscript {
  sessionId: string
  path: string
  modifiedMs: number
}

/**
 * The conversation a cold takeover resumes. With the process gone, the newest
 * transcript under the cwd's project directory is the last session that ran
 * there — `pinned` is the escape hatch when an unrelated `claude` run in the
 * same directory is newer.
 */
export function resolveClaudeTranscript(
  cwd: string,
  pinned: string | undefined,
  deps: ClaudeDiskDeps
): ClaudeTranscript {
  let canonicalCwd: string
  try {
    canonicalCwd = deps.canonical(cwd)
  } catch {
    throw new Error(`cwd is not canonicalizable: ${cwd}`)
  }
  const directory = join(deps.home, ".claude", "projects", projectDirectory(canonicalCwd))
  if (pinned) {
    if (!UUID_RE.test(pinned)) throw new Error(`not a Claude session UUID: ${pinned}`)
    const path = join(directory, `${pinned}.jsonl`)
    if (!deps.exists(path)) throw new Error(`Claude transcript is missing: ${path}`)
    return { sessionId: pinned, path, modifiedMs: readModified(path, deps) }
  }
  const candidates = listClaudeTranscripts(directory, deps)
  if (candidates.length === 0) throw new Error(`no Claude transcript under ${directory}`)
  return candidates[0]!
}

/** Newest first. */
function listClaudeTranscripts(directory: string, deps: ClaudeDiskDeps): ClaudeTranscript[] {
  const candidates: ClaudeTranscript[] = []
  for (const entry of deps.list(directory)) {
    const sessionId = entry.match(/^(.+)\.jsonl$/)?.[1]
    if (!sessionId || !UUID_RE.test(sessionId)) continue
    const path = join(directory, entry)
    candidates.push({ sessionId, path, modifiedMs: readModified(path, deps) })
  }
  return candidates.sort((left, right) => right.modifiedMs - left.modifiedMs)
}

/**
 * The conversation a revival should continue: the newest transcript in the
 * worktree that no live process is already holding.
 *
 * Skipping held transcripts is the whole point of the filter — resuming one a
 * surviving Claude still owns puts two processes on one conversation, which is
 * how the 2026-07-28 duplicate storm compounded. Undefined when the directory
 * has no usable transcript, so the caller starts fresh rather than failing.
 */
export function resumableClaudeTranscript(cwd: string, deps: ClaudeDiskDeps): ClaudeTranscript | undefined {
  let canonicalCwd: string
  try {
    canonicalCwd = deps.canonical(cwd)
  } catch {
    return undefined
  }
  const held = new Set(findLiveClaudeSessions(canonicalCwd, deps).map((session) => session.sessionId))
  const directory = join(deps.home, ".claude", "projects", projectDirectory(canonicalCwd))
  return listClaudeTranscripts(directory, deps).find((transcript) => !held.has(transcript.sessionId))
}

function readModified(path: string, deps: ClaudeDiskDeps): number {
  try {
    return deps.modified(path)
  } catch {
    return 0
  }
}

export function resolveClaudeNativeSession(
  panePid: number,
  cwd: string,
  launchName: string | undefined,
  force: boolean,
  deps: ClaudeRegistryDeps = defaultClaudeRegistryDeps()
): ClaudeNativeSession {
  const path = join(deps.home, ".claude", "sessions", `${panePid}.json`)
  let value: unknown
  try {
    value = JSON.parse(deps.read(path))
  } catch {
    throw new Error(`invalid Claude live registry: ${path}`)
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid Claude registry shape")
  const row = value as Record<string, unknown>
  if (
    row.pid !== panePid ||
    typeof row.sessionId !== "string" ||
    !UUID_RE.test(row.sessionId) ||
    typeof row.cwd !== "string" ||
    typeof row.procStart !== "string" ||
    typeof row.status !== "string"
  )
    throw new Error("invalid Claude registry shape")
  if (deps.processStart(panePid) !== row.procStart) throw new Error("Claude process generation does not match registry")
  let registryCwd: string
  let paneCwd: string
  try {
    registryCwd = deps.canonical(row.cwd)
    paneCwd = deps.canonical(cwd)
  } catch {
    throw new Error("Claude registry cwd is not canonicalizable")
  }
  if (registryCwd !== paneCwd || row.cwd !== registryCwd) throw new Error("Claude registry cwd does not match pane")
  if ((row.name === undefined ? undefined : row.name) !== launchName)
    throw new Error("Claude registry name does not match launch")
  if (!force && row.status !== "idle") throw new Error(`Claude session is ${row.status}; use --force to reconnect`)
  const transcript = join(deps.home, ".claude", "projects", projectDirectory(registryCwd), `${row.sessionId}.jsonl`)
  if (!deps.exists(transcript)) throw new Error(`Claude transcript is missing: ${transcript}`)
  return {
    pid: panePid,
    sessionId: row.sessionId,
    cwd: registryCwd,
    procStart: row.procStart,
    name: typeof row.name === "string" ? row.name : undefined,
    status: row.status,
  }
}
