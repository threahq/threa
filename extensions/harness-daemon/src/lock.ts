import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { inventoryPath } from "./inventory"

/** One lock serializes spawn/mint, revive and reap: they all race for the same worktrees. */
export function resumeActiveLockPath(): string {
  return join(dirname(inventoryPath()), "resume-active.lock")
}

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
 * Remove a lock whose owner is gone — but only one waiter at a time.
 *
 * Re-reading the file immediately before unlinking is NOT enough, and the
 * comment that used to claim it was is why this looked safe. Two waiters can
 * both read the dead holder and both be authorised; the first unlinks and takes
 * the lock, and the second's already-authorised `unlink` then deletes that fresh
 * lock and takes its own. Both return believing they hold it, and a revive runs
 * concurrently with a reap that force-removes worktrees.
 *
 * The steal marker closes it: a waiter can only reach the unlink while holding
 * an exclusive marker, so by the time the second waiter gets there its re-read
 * shows the NEW owner rather than the dead one, and it declines. The marker is
 * itself stale-recoverable, or a stealer dying mid-steal would wedge everyone.
 */
function stealStaleLock(path: string, holder: number, pid: number, isAlive: (pid: number) => boolean): boolean {
  const markerPath = `${path}.steal`
  try {
    writeFileSync(markerPath, String(pid), { flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    try {
      const owner = Number(readFileSync(markerPath, "utf8")) || undefined
      if (owner !== undefined && owner !== pid && !isAlive(owner)) unlinkSync(markerPath)
    } catch {
      // The marker went away on its own; the next pass re-reads the lock.
    }
    return false
  }
  try {
    if (Number(readFileSync(path, "utf8")) !== holder || isAlive(holder)) return false
    unlinkSync(path)
    return true
  } catch {
    // Already gone, or taken by the waiter that stole it before us.
    return false
  } finally {
    try {
      unlinkSync(markerPath)
    } catch {
      // Losing the marker only costs the next stealer one poll.
    }
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
    // Retry at once only when the steal actually freed the lock. Falling through
    // otherwise is what keeps a contested steal — another waiter holding the
    // marker — from spinning past the deadline instead of timing out.
    if (holder !== undefined && holder !== pid && !isAlive(holder)) {
      if (stealStaleLock(path, holder, pid, isAlive)) continue
    }
    if (Date.now() >= deadline) {
      // Re-read: `holder` was captured before the steal attempt, and naming the
      // pid we gave up on rather than the one actually holding it sends whoever
      // reads this at a process that is already gone.
      let current: number | undefined
      try {
        current = Number(readFileSync(path, "utf8")) || undefined
      } catch {
        current = holder
      }
      throw new Error(
        `lock ${path} held by pid ${current ?? holder ?? "unknown"} for over ${Math.round(timeoutMs / 1000)}s; ` +
          "another revival pass appears stuck"
      )
    }
    await sleep(pollMs)
  }
}
