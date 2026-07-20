import { $ } from "bun"
import type { Subprocess } from "bun"

export interface ProcessRow {
  pid: number
  ppid: number
}

export function parseProcessTable(psOutput: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of psOutput.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/)
    if (!match) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]) })
  }
  return rows
}

// Parents-first: SIGKILL runs no handlers, so a dead parent can't respawn a
// child — but a still-live parent CAN respawn a killed child with a pid absent
// from our snapshot. Killing top-down closes that window.
export function computeDescendants(rows: ProcessRow[], roots: number[]): number[] {
  const childrenOf = new Map<number, number[]>()
  for (const row of rows) {
    const list = childrenOf.get(row.ppid)
    if (list) list.push(row.pid)
    else childrenOf.set(row.ppid, [row.pid])
  }

  const ordered: number[] = []
  const seen = new Set<number>(roots)
  const visit = (pid: number) => {
    ordered.push(pid)
    for (const child of childrenOf.get(pid) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      visit(child)
    }
  }
  for (const root of roots) visit(root)
  return ordered
}

async function listProcessTable(): Promise<ProcessRow[]> {
  const result = await $`ps -axo pid=,ppid=`.quiet().nothrow()
  return parseProcessTable(result.stdout.toString())
}

export async function killTrees(procs: Subprocess[]): Promise<void> {
  const roots = procs.map((p) => p.pid).filter((pid): pid is number => typeof pid === "number")
  let pids = roots
  try {
    pids = computeDescendants(await listProcessTable(), roots)
  } catch {
    // ps failed; fall back to direct children only
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
}

/**
 * Installs shutdown handling for a dev stack:
 * - SIGINT/SIGTERM/SIGHUP kill the full process tree (workerd/vite grandchildren included)
 * - a watchdog self-terminates the stack if this process is orphaned (parent died
 *   without delivering a signal, e.g. a killed agent shell or closed tmux window)
 */
export function installDevLifecycle(procs: Subprocess[]): () => Promise<void> {
  let isShuttingDown = false

  const shutdown = async () => {
    if (isShuttingDown) return
    isShuttingDown = true
    console.log("\nShutting down...")
    await killTrees(procs)
    await Promise.all(procs.map((p) => p.exited))
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  process.on("SIGHUP", shutdown)

  // Probe the original parent's liveness with signal 0 rather than watching
  // process.ppid: Bun caches ppid on first read so it never reflects
  // reparenting, and ppid===1 both misfires under init shims/launchd (starts
  // at 1) and misses under subreapers (orphan reparents to a non-1 pid).
  const initialPpid = process.ppid
  const watchdog = setInterval(() => {
    try {
      process.kill(initialPpid, 0)
    } catch {
      console.log("Parent process died; shutting down orphaned dev stack.")
      void shutdown()
    }
  }, 2000)
  // Must not keep the event loop alive once all children have exited.
  if (typeof watchdog.unref === "function") watchdog.unref()

  return shutdown
}
