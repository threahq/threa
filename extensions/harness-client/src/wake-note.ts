import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { isSafeSessionFileName } from "./harness-links"

/**
 * What harnessd leaves behind when it wakes a session it had suspended for
 * idling, keyed by runtime session id.
 *
 * The handoff has to be a file because the two halves never share a process:
 * harnessd decides the wake, and only the channel extension the revival starts
 * can put it in front of the model — and only it holds the invocation claim an
 * agent-trace step needs. The note is written at wake, not at suspend, so a
 * note that exists always names a resume that is about to happen.
 */
export interface SessionWakeNote {
  runtimeSessionId: string
  /** ISO instant harnessd wound the session down. */
  suspendedAt: string
  /** ISO instant the queued turn arrived and harnessd started the revival. */
  wokeAt: string
}

/**
 * A note nobody consumed must not brief a session hours later: the revival it
 * belonged to failed, and whatever is running now started for its own reasons.
 */
export const WAKE_NOTE_TTL_MS = 60 * 60_000

export function wakeNotesDir(): string {
  return process.env.THREA_HARNESS_WAKE_NOTES_DIR || join(homedir(), ".threa", "harnessd", "wake")
}

function notePath(runtimeSessionId: string): string | undefined {
  if (!isSafeSessionFileName(runtimeSessionId)) return undefined
  return join(wakeNotesDir(), `${runtimeSessionId}.json`)
}

/** Best-effort: a wake must never fail because its note could not be written. */
export function writeSessionWakeNote(note: SessionWakeNote): void {
  const path = notePath(note.runtimeSessionId)
  if (!path) return
  try {
    mkdirSync(wakeNotesDir(), { recursive: true })
    writeFileSync(path, `${JSON.stringify(note, null, 2)}\n`)
  } catch {
    // Losing the note costs the brief, never the revival.
  }
}

/**
 * Read and remove the note for this session, if it is still fresh. Removing it
 * as part of reading is what keeps one suspension to one brief — a second
 * reader (a restart, a second boot) finds nothing.
 */
export function takeSessionWakeNote(runtimeSessionId: string, nowMs = Date.now()): SessionWakeNote | undefined {
  const path = notePath(runtimeSessionId)
  if (!path || !existsSync(path)) return undefined
  let parsed: Partial<SessionWakeNote>
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionWakeNote>
  } catch {
    rmSync(path, { force: true })
    return undefined
  }
  rmSync(path, { force: true })
  if (
    typeof parsed.suspendedAt !== "string" ||
    typeof parsed.wokeAt !== "string" ||
    !parsed.suspendedAt ||
    !parsed.wokeAt
  ) {
    return undefined
  }
  const wokeAtMs = Date.parse(parsed.wokeAt)
  if (!Number.isFinite(wokeAtMs) || nowMs - wokeAtMs > WAKE_NOTE_TTL_MS) return undefined
  return { runtimeSessionId, suspendedAt: parsed.suspendedAt, wokeAt: parsed.wokeAt }
}
