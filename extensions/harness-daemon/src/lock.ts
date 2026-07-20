import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export interface LockOptions {
  pid?: number
  isAlive?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
  pollMs?: number
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Cross-process mutex with owner-pid staleness recovery: a crashed holder's
 * lock is stolen instead of wedging every later pass (the previous tmux
 * wait-for lock survived its owner until the tmux server restarted).
 */
export async function acquireProcessLock(path: string, options: LockOptions = {}): Promise<() => void> {
  const pid = options.pid ?? process.pid
  const isAlive = options.isAlive ?? processAlive
  const sleep = options.sleep ?? Bun.sleep
  const timeoutMs = options.timeoutMs ?? 10 * 60_000
  const pollMs = options.pollMs ?? 250
  mkdirSync(dirname(path), { recursive: true })
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      writeFileSync(path, String(pid), { flag: "wx" })
      return () => {
        try {
          if (readFileSync(path, "utf8") === String(pid)) unlinkSync(path)
        } catch {
          // already released or stolen after our crash-recovery window
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    let holder: number | undefined
    try {
      holder = Number(readFileSync(path, "utf8")) || undefined
    } catch {
      continue
    }
    if (holder !== undefined && holder !== pid && !isAlive(holder)) {
      try {
        unlinkSync(path)
      } catch {}
      continue
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `lock ${path} held by pid ${holder ?? "unknown"} for over ${Math.round(timeoutMs / 1000)}s; ` +
          "another revival pass appears stuck"
      )
    }
    await sleep(pollMs)
  }
}
