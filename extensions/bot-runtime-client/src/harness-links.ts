import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Where a live harness runtime records what it is linked to.
 *
 * Without this there is no reliable local answer to "which scratchpad does
 * this tmux window belong to". The inventory only covers agents spawned by
 * `harnessd spawn` — on a real machine most windows come from elsewhere — and
 * a tmux pane knows only its cwd. Recovering the mapping any other way means
 * scraping runtime transcripts, which is far too fragile to drive a reaper
 * that deletes worktrees.
 *
 * One file per runtime session, never a shared document: several runtimes
 * write concurrently and a read-modify-write on one file would lose entries.
 */

export interface HarnessLink {
  runtimeKind: string
  runtimeSessionId: string
  instanceId: string
  rootStreamId: string
  /** The runtime's working directory — the worktree a reaper would clean up. */
  worktree: string
  /** Owning process, so a reader can tell a live runtime from an abandoned record. */
  pid: number
  updatedAt: string
}

export function harnessLinksDir(): string {
  return process.env.THREA_HARNESS_LINKS_DIR || join(homedir(), ".threa", "harnessd", "links")
}

/**
 * Session ids reach the filesystem as names. Refuse anything that is not
 * already a safe single segment rather than rewriting it — sanitising in place
 * would silently map two distinct session ids onto one file. Real ids
 * (`ccs-<hex>`, UUIDs) pass unchanged.
 */
function linkPath(runtimeSessionId: string): string | undefined {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(runtimeSessionId)) return undefined
  if (runtimeSessionId === "." || runtimeSessionId === "..") return undefined
  return join(harnessLinksDir(), `${runtimeSessionId}.json`)
}

/**
 * Best-effort: a runtime must never fail its turn because bookkeeping could not
 * be written.
 *
 * Supersedes any other record for the same worktree. One worktree hosts one
 * runtime at a time, and a leftover record from a previous session would point
 * a reaper at that directory using the OLD session's root stream — archive
 * that stale root and the reaper would push and delete a worktree whose
 * current occupant is very much alive.
 */
export function recordHarnessLink(link: Omit<HarnessLink, "updatedAt" | "pid"> & { pid?: number }): void {
  const path = linkPath(link.runtimeSessionId)
  if (!path) return
  try {
    mkdirSync(harnessLinksDir(), { recursive: true })
    const record: HarnessLink = {
      ...link,
      pid: link.pid ?? process.pid,
      updatedAt: new Date().toISOString(),
    }
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`)
    for (const other of readHarnessLinks()) {
      if (other.worktree === record.worktree && other.runtimeSessionId !== record.runtimeSessionId) {
        clearHarnessLink(other.runtimeSessionId)
      }
    }
  } catch {
    // A missing record only costs the reaper a candidate; it never breaks a turn.
  }
}

/**
 * Only for a completed wind-down, or superseding a stale record.
 *
 * Deliberately NOT called on ordinary shutdown: a runtime that exits normally
 * and is archived afterwards is the exact case the reaper exists for, and
 * dropping the record on exit would leave it with nothing to find. Records for
 * worktrees that no longer exist are pruned by the reaper instead.
 */
export function clearHarnessLink(runtimeSessionId: string): void {
  const path = linkPath(runtimeSessionId)
  if (!path) return
  try {
    rmSync(path, { force: true })
  } catch {
    // A stale record is harmless — readers re-derive liveness from the server.
  }
}

/** Every recorded link. Unreadable or malformed files are skipped, not fatal. */
export function readHarnessLinks(): HarnessLink[] {
  const dir = harnessLinksDir()
  if (!existsSync(dir)) return []
  const links: HarnessLink[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith(".json"))
  } catch {
    return []
  }
  for (const entry of entries) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, entry), "utf8")) as Partial<HarnessLink>
      if (
        typeof parsed.runtimeSessionId === "string" &&
        typeof parsed.rootStreamId === "string" &&
        typeof parsed.worktree === "string" &&
        parsed.runtimeSessionId &&
        parsed.rootStreamId &&
        parsed.worktree
      ) {
        links.push({
          runtimeKind: typeof parsed.runtimeKind === "string" ? parsed.runtimeKind : "unknown",
          runtimeSessionId: parsed.runtimeSessionId,
          instanceId: typeof parsed.instanceId === "string" ? parsed.instanceId : "",
          rootStreamId: parsed.rootStreamId,
          worktree: parsed.worktree,
          pid: typeof parsed.pid === "number" ? parsed.pid : 0,
          updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
        })
      }
    } catch {
      // Skip: a half-written or hand-edited file must not abort the sweep.
    }
  }
  return links
}
