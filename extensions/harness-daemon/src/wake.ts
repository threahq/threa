import type { ReviveOutcome } from "./commands"

/**
 * Why the woken session still is not running, or undefined when the turn has a
 * runtime to answer it. A wake that ends anywhere but "started"/"already
 * running" leaves the invocation pending with nobody claiming it, which is the
 * silence this reports. "skipped unavailable" is excluded: Threa being
 * unreachable is already retried with backoff, and the notice could not be
 * posted anyway.
 */
export function wakeFailureDetail(outcome: ReviveOutcome | undefined): string | undefined {
  if (!outcome) return "the row was not evaluated for revival"
  if (outcome.status === "started" || outcome.status === "already running") return undefined
  if (outcome.status === "skipped unavailable") return undefined
  return outcome.detail ? `${outcome.status}: ${outcome.detail}` : outcome.status
}

export function formatWakeFailureNotice(detail: string): string {
  return `⚠️ This session was wound down for idle and harnessd could not start it again (${detail}). The message stays queued until a start succeeds. See \`~/.threa/harnessd/log/watch.log\`.`
}
