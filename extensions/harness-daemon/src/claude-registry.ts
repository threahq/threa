import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { output } from "./shell"

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

export function defaultClaudeRegistryDeps(run: typeof output = output): ClaudeRegistryDeps {
  return {
    read: (path) => readFileSync(path, "utf8"),
    exists: existsSync,
    canonical: realpathSync,
    processStart: (pid) => {
      const result = run(["env", "TZ=UTC", "ps", "-p", String(pid), "-o", "lstart="], { allowFailure: true })
      return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined
    },
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
}

export function defaultClaudeDiskDeps(run: typeof output = output): ClaudeDiskDeps {
  return {
    ...defaultClaudeRegistryDeps(run),
    list: (path) => {
      try {
        return readdirSync(path)
      } catch {
        return []
      }
    },
    modified: (path) => statSync(path).mtimeMs,
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
    // pids are recycled; the start instant is what makes the entry this process.
    if (deps.processStart(pid) !== row.procStart) continue
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
  const candidates: ClaudeTranscript[] = []
  for (const entry of deps.list(directory)) {
    const sessionId = entry.match(/^(.+)\.jsonl$/)?.[1]
    if (!sessionId || !UUID_RE.test(sessionId)) continue
    const path = join(directory, entry)
    candidates.push({ sessionId, path, modifiedMs: readModified(path, deps) })
  }
  if (candidates.length === 0) throw new Error(`no Claude transcript under ${directory}`)
  return candidates.sort((left, right) => right.modifiedMs - left.modifiedMs)[0]!
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
