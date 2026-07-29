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
  /**
   * Set by a runtime that watched the restore grace expire and is exiting:
   * harnessd may preserve and remove this worktree on its next pass with no
   * further margin, because the grace it would otherwise wait out has already
   * been served. Absent on every record written by {@link recordHarnessLink},
   * so a relink after an unarchive clears it.
   */
  windDownRequestedAt?: string
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
export function isSafeSessionFileName(runtimeSessionId: string): boolean {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(runtimeSessionId)) return false
  return runtimeSessionId !== "." && runtimeSessionId !== ".."
}

function linkPath(runtimeSessionId: string): string | undefined {
  if (!isSafeSessionFileName(runtimeSessionId)) return undefined
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
 *
 * `windDownRequestedAt` is omitted from the parameter rather than merely left
 * unset: a caller spreading an existing record in here would smuggle the mark
 * onto a link that was just revived, and `reapLink` skips every margin for a
 * marked record. The type is what stops that, not the convention.
 */
export function recordHarnessLink(
  link: Omit<HarnessLink, "updatedAt" | "pid" | "windDownRequestedAt"> & { pid?: number }
): void {
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
 * Hand this worktree to harnessd: the restore grace expired with the
 * scratchpad still archived, so preserving the branch and removing the
 * worktree is now due.
 *
 * The runtime does not do that work itself. Only harnessd holds
 * `resume-active.lock`, which a concurrent revive of the same worktree also
 * takes, and only harnessd outlives the tmux window this runtime is about to
 * kill. Marking rather than clearing is what keeps the record findable.
 *
 * No-op when nothing was recorded — this must never mint a record for a
 * worktree no live runtime ever claimed.
 */
export function markHarnessLinkWoundDown(runtimeSessionId: string): void {
  const path = linkPath(runtimeSessionId)
  if (!path) return
  try {
    const existing = readHarnessLinks().find((link) => link.runtimeSessionId === runtimeSessionId)
    if (!existing) return
    const record: HarnessLink = { ...existing, windDownRequestedAt: new Date().toISOString() }
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`)
  } catch {
    // Losing the mark only costs the reaper its shortcut: the record is still
    // there, and the ordinary archivedAt margin reaps the worktree anyway.
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
  } catch (error) {
    // A scan that could not run must not read as a scan that found nothing:
    // `doctor` prints the count, and "0 drift" from an unreadable directory is
    // the unfalsifiable clean result this whole effort exists to remove.
    throw new Error(`harnessd: could not read the harness link directory ${dir}: ${error}`)
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
          ...(typeof parsed.windDownRequestedAt === "string" && parsed.windDownRequestedAt
            ? { windDownRequestedAt: parsed.windDownRequestedAt }
            : {}),
        })
      }
    } catch {
      // Skip: a half-written or hand-edited file must not abort the sweep.
    }
  }
  return links
}
