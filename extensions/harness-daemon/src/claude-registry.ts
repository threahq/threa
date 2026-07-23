import { existsSync, readFileSync, realpathSync } from "node:fs"
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

function projectDirectory(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-")
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
