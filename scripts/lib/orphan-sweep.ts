import { $ } from "bun"
import { computeDescendants } from "./dev-lifecycle"

export interface ProcessInfo {
  pid: number
  ppid: number
  args: string
}

// Commands playwright.config.ts starts as webServer entries. When Playwright
// itself dies by SIGKILL (an agent's shell timeout, the OOM killer) it runs no
// teardown, so these servers are reparented to init and live until a reboot.
const webServerMarkers = [
  "tests/browser/fake-cf-runner.ts",
  "test:browser:backend",
  "test:browser:control-plane",
  "test:browser:frontend",
]

export function parseProcessInfo(psOutput: string): ProcessInfo[] {
  const rows: ProcessInfo[] = []
  for (const line of psOutput.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (!match) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3]! })
  }
  return rows
}

// A webServer process is owned while any ancestor is a live Playwright run.
export function findOrphanedWebServers(rows: ProcessInfo[]): ProcessInfo[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const orphans: ProcessInfo[] = []
  for (const row of rows) {
    if (!webServerMarkers.some((marker) => row.args.includes(marker))) continue
    let owned = false
    const seen = new Set<number>()
    let ancestor = byPid.get(row.ppid)
    while (ancestor && !seen.has(ancestor.pid)) {
      seen.add(ancestor.pid)
      if (ancestor.args.includes("playwright")) {
        owned = true
        break
      }
      ancestor = byPid.get(ancestor.ppid)
    }
    if (!owned) orphans.push(row)
  }
  return orphans
}

export async function sweepOrphanedWebServers(): Promise<void> {
  const result = await $`ps -axo pid=,ppid=,args=`.quiet().nothrow()
  const rows = parseProcessInfo(result.stdout.toString())
  const orphans = findOrphanedWebServers(rows)
  if (orphans.length === 0) return
  for (const orphan of orphans) {
    console.error(`Killing orphaned browser-test server pid=${orphan.pid}: ${orphan.args}`)
  }
  for (const pid of computeDescendants(
    rows,
    orphans.map((row) => row.pid)
  )) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
}
