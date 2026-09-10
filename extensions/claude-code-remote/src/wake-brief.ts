import { takeSessionWakeNote, type SessionWakeNote } from "@threahq/harness-client"
import { formatDuration, formatLocalTime } from "./clock"

export interface WakeBrief {
  /** Prepended to the first turn the revived session is handed. */
  notice: string
  /** The same fact on the invocation's own trace, so the user sees the gap too. */
  step: { stepType: string; content: string }
}

/**
 * What a session that harnessd wound down and brought back needs told.
 *
 * The transcript survives a suspension but the process does not, so the brief
 * leads with what is actually gone rather than with the suspension itself, and
 * says outright that none of this is the user's message to answer.
 */
export function formatWakeBrief(note: SessionWakeNote): WakeBrief | undefined {
  const suspendedAt = Date.parse(note.suspendedAt)
  const wokeAt = Date.parse(note.wokeAt)
  if (!Number.isFinite(suspendedAt) || !Number.isFinite(wokeAt) || wokeAt < suspendedAt) return undefined

  const when = `suspended ${formatLocalTime(suspendedAt)}, asleep ${formatDuration(wokeAt - suspendedAt)}`
  return {
    notice:
      `[harnessd] You were suspended for sitting idle and resumed just now to take the message below (${when}). ` +
      "Your runtime process was replaced, so background shell jobs, background subagents, timers, and shell state " +
      "from before it are gone; re-check anything you left running. A command still running counts as work and " +
      "holds the sweep off by itself; a subagent or a wait of your own does not, so hold it off first with " +
      `\`threa-harnessd hold ${note.runtimeSessionId} --minutes N\`. ` +
      "The user did not ask for the resume and needs no reply about it.",
    step: { stepType: "context_received", content: `Resumed from idle suspension (${when})` },
  }
}

/** Reads and consumes the note harnessd left for this session, if there is one. */
export function takeWakeBrief(runtimeSessionId: string): WakeBrief | undefined {
  const note = takeSessionWakeNote(runtimeSessionId)
  return note ? formatWakeBrief(note) : undefined
}
