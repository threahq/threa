import { spawn } from "child_process"
import { existsSync, mkdirSync, readFileSync } from "fs"
import * as os from "os"
import * as path from "path"

const flockBinary = "/usr/bin/flock"

export interface HeavyLockOptions {
  cwd?: string
  env?: Record<string, string>
  label: string
}

function lockPaths(): { lockFile: string; holderFile: string } {
  const dir = path.join(os.homedir(), ".cache", "threa")
  mkdirSync(dir, { recursive: true })
  const lockFile = path.join(dir, "heavy.lock")
  return { lockFile, holderFile: `${lockFile}.holder` }
}

function run(command: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { cwd, env, stdio: "inherit" })
    child.on("error", reject)
    child.on("close", (code) => resolve(code ?? 1))
  })
}

function readHolder(holderFile: string): string {
  try {
    return readFileSync(holderFile, "utf8").trim() || "unknown job"
  } catch {
    return "unknown job"
  }
}

async function isFree(lockFile: string): Promise<boolean> {
  const code = await new Promise<number>((resolve) => {
    const child = spawn(flockBinary, ["-n", lockFile, "true"], { stdio: "ignore" })
    child.on("error", () => resolve(1))
    child.on("close", (exitCode) => resolve(exitCode ?? 1))
  })
  return code === 0
}

export async function runUnderHeavyLock(cmd: string[], opts: HeavyLockOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd()
  const env = { ...process.env, ...(opts.env ?? {}) }

  if (process.env.CI) return await run(cmd, cwd, env)

  if (!existsSync(flockBinary)) {
    console.error(`heavy-lock: ${flockBinary} not found — running "${opts.label}" without the cross-worktree lock.`)
    return await run(cmd, cwd, env)
  }

  const { lockFile, holderFile } = lockPaths()
  if (!(await isFree(lockFile))) {
    console.error(`Waiting for heavy job: ${readHolder(holderFile)}`)
  }

  const holderText = `${cwd} ${opts.label} pid=${process.pid} since=${new Date().toISOString()}`
  const wrapped = [
    flockBinary,
    "-w",
    "7200",
    lockFile,
    "sh",
    "-c",
    'printf "%s" "$0" > "$1"; shift 1; exec "$@"',
    holderText,
    holderFile,
    ...cmd,
  ]
  return await run(wrapped, cwd, env)
}
