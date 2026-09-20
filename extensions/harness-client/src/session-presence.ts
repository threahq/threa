import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { isSafeSessionFileName } from "./harness-links"

/**
 * The descriptive half of a runtime session's presence: what harnessd needs to
 * keep publishing it while the session's own process is not running.
 *
 * A suspended session cannot answer for itself. Its socket drops, the server
 * marks the instance offline, and every session-control command vanishes from
 * the UI until a message wakes it — so a user has to prompt an agent, stop the
 * prompt, and only then change its model. Harnessd re-posts this record
 * instead. It is a snapshot the live session wrote, never a reconstruction:
 * with no snapshot harnessd holds nothing rather than advertising capabilities
 * it guessed.
 *
 * Status and the BIK are deliberately absent. Harnessd decides the status it
 * publishes, and the keypair is the running process's alone — it is reloaded
 * from disk on resume, so the server keeps the registered key rather than
 * anyone replaying it.
 */
export interface SessionPresenceSnapshot {
  runtimeKind: string
  instanceId: string
  runtimeSessionId: string
  displayName?: string
  /** `capabilities` exactly as the session last published them. */
  capabilities: Record<string, unknown>
  /** `manifest` exactly as the session last published it. */
  manifest?: Record<string, unknown>
  updatedAt: string
}

export function sessionPresenceDir(): string {
  return process.env.THREA_HARNESS_PRESENCE_DIR || join(homedir(), ".threa", "harnessd", "presence")
}

function presencePath(runtimeSessionId: string): string | undefined {
  if (!isSafeSessionFileName(runtimeSessionId)) return undefined
  return join(sessionPresenceDir(), `${runtimeSessionId}.json`)
}

/** Best-effort: a session must never fail a presence write because the snapshot could not be stored. */
export function writeSessionPresence(snapshot: Omit<SessionPresenceSnapshot, "updatedAt">): void {
  const path = presencePath(snapshot.runtimeSessionId)
  if (!path) return
  try {
    mkdirSync(sessionPresenceDir(), { recursive: true })
    const record: SessionPresenceSnapshot = { ...snapshot, updatedAt: new Date().toISOString() }
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`)
  } catch {
    // Losing the snapshot costs held presence while suspended, never the turn.
  }
}

/**
 * The snapshot for one session, or undefined when there is none to replay.
 *
 * Undefined is a real answer the caller reports — an unreadable or malformed
 * file must not be dressed up as presence.
 */
export function readSessionPresence(runtimeSessionId: string): SessionPresenceSnapshot | undefined {
  let parsed: Partial<SessionPresenceSnapshot>
  try {
    const path = presencePath(runtimeSessionId)
    if (!path || !existsSync(path)) return undefined
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionPresenceSnapshot>
  } catch {
    return undefined
  }
  if (
    typeof parsed.runtimeKind !== "string" ||
    typeof parsed.instanceId !== "string" ||
    !parsed.runtimeKind ||
    !parsed.instanceId ||
    typeof parsed.capabilities !== "object" ||
    parsed.capabilities === null ||
    Array.isArray(parsed.capabilities)
  ) {
    return undefined
  }
  return {
    runtimeKind: parsed.runtimeKind,
    instanceId: parsed.instanceId,
    runtimeSessionId,
    ...(typeof parsed.displayName === "string" && parsed.displayName ? { displayName: parsed.displayName } : {}),
    capabilities: parsed.capabilities as Record<string, unknown>,
    ...(typeof parsed.manifest === "object" && parsed.manifest !== null && !Array.isArray(parsed.manifest)
      ? { manifest: parsed.manifest as Record<string, unknown> }
      : {}),
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
  }
}

/**
 * Drop the snapshot for a session that published itself offline.
 *
 * A session that shut down cleanly is not one harnessd should speak for: it
 * ended on purpose, and holding its presence would advertise commands with
 * nothing behind them.
 */
export function clearSessionPresence(runtimeSessionId: string): void {
  const path = presencePath(runtimeSessionId)
  if (!path) return
  try {
    rmSync(path, { force: true })
  } catch {
    // A leftover snapshot is only replayed for a row harnessd suspended itself.
  }
}
