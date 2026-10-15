import { formatDuration, formatLocalTime } from "./clock"
import { classifyApiErrorText, type QuotaSignal } from "./quota-signal"

/**
 * Quota carry-on: keep a turn alive across a provider quota window and resume
 * it when the quota resets.
 *
 * When Claude Code's model call dies on quota (detected from the transcript's
 * synthetic API-error line, classified by `quota-signal.ts`), the turn is dead
 * in the TUI but the Threa invocation is still claimed. Instead of letting it
 * idle out as "ended without a reply", this controller:
 *
 *  1. holds the claim open (periodic keep-alive beats the idle reaper),
 *  2. records the wait, and when it resumes, on the held turn's own trace,
 *  3. at reset time pastes a continuation prompt into the idle TUI — the same
 *     invocation answers, so its trace shows the wait and the resume.
 *
 * While held, nothing is injected into the running turn and /enqueue'd
 * messages are not claimed (`awaitingResume`): the TUI sits at a quota-dead
 * prompt. Give-up paths (attempt cap, unschedulable reset, lost tmux control)
 * close the turn with a message.
 */

export interface CarryOnTiming {
  keepAliveIntervalMs: number
  transientResumeDelayMs: number
  /** Resume slightly after the printed reset minute — the quota flips sometime within it. */
  resumeJitterMs: number
  maxHoldMs: number
  maxResumeAttempts: number
  minResumeDelayMs: number
  /** One delayed re-attempt when posting the give-up close fails (a transient API error there would strand the turn on the idle reaper). */
  giveUpRetryDelayMs: number
}

export const DEFAULT_CARRY_ON_TIMING: CarryOnTiming = {
  // Must stay well under the session's idleTimeoutMs (default 1h in
  // remote-session/identity.ts) or the idle reaper closes the held turn
  // between keep-alives.
  keepAliveIntervalMs: 5 * 60_000,
  transientResumeDelayMs: 2 * 60_000,
  resumeJitterMs: 45_000,
  maxHoldMs: 8 * 60 * 60_000,
  maxResumeAttempts: 3,
  minResumeDelayMs: 5_000,
  giveUpRetryDelayMs: 60_000,
}

/** What the controller needs from the channel; injected so tests drive it with fakes. */
export interface CarryOnHost {
  isInflight(invocationId: string): boolean
  keepAlive(streamId: string): void
  /**
   * Record the wait on the held turn's own trace. The turn is still running, so
   * what it is doing belongs in its activity — not in a message written about it.
   */
  reportHold(invocationId: string, content: string, statusText: string): Promise<unknown>
  /** Close the held invocation with a final message (the SDK reply path). */
  closeTurn(invocationId: string, text: string): Promise<void>
  /** Submit a fresh prompt into the idle runtime. False = control lost. */
  inject(text: string): Promise<boolean>
  /** The hold that kept messages unclaimed ended; claim what waited behind it. */
  holdEnded(): void
  log(message: string): void
  now?(): number
}

interface Hold {
  invocationId: string
  streamId: string
  resumeAt: number
  /** Resumes already fired for this blocked turn (caps re-detection loops). */
  attempts: number
  resumeTimer?: ReturnType<typeof setTimeout>
  /** The resume prompt landed; the turn is running again. */
  resumed: boolean
  keepAliveTimer: ReturnType<typeof setInterval>
}

export function buildResumePrompt(invocationId: string): string {
  return (
    "[Quota carry-on] The provider quota should be available again. Continue the work for invocation " +
    `${invocationId} exactly where it left off. When finished, call the reply tool with that invocation_id as usual.`
  )
}

export class CarryOnController {
  private turn: { invocationId: string; streamId: string } | undefined
  private hold: Hold | undefined
  private gaveUpOn: string | undefined
  private readonly timing: CarryOnTiming

  constructor(
    private readonly host: CarryOnHost,
    timing?: Partial<CarryOnTiming>
  ) {
    this.timing = { ...DEFAULT_CARRY_ON_TIMING, ...timing }
  }

  private now(): number {
    return this.host.now?.() ?? Date.now()
  }

  get holding(): boolean {
    return this.hold !== undefined
  }

  /** Held and the resume prompt has not landed yet; once it has, the resumed turn is running again. */
  get awaitingResume(): boolean {
    return this.hold !== undefined && !this.hold.resumed
  }

  /** A turn was pushed to the runtime. A hold for any other invocation is stale — that turn was closed under us. */
  onTurnStarted(invocationId: string, streamId: string): void {
    this.turn = { invocationId, streamId }
    if (this.hold && this.hold.invocationId !== invocationId) {
      this.dropHold(`superseded by a new turn (${invocationId})`)
    }
  }

  /** The runtime answered (or the turn closed some other way); nothing left to resume. */
  onTurnClosed(invocationId: string): void {
    if (this.turn?.invocationId === invocationId) this.turn = undefined
    if (this.hold?.invocationId === invocationId) this.dropHold("turn closed")
  }

  /** /stop actuation: the interrupt is about to close every in-flight turn. */
  onInterrupt(): void {
    if (this.hold) this.dropHold("interrupted by /stop")
  }

  /** A provider error landed for an in-flight turn. True when carry-on owns it (held, given up, or already held). */
  onApiError(invocationId: string, text: string): boolean {
    // The transcript tail and Claude's StopFailure hook can both report the same failure.
    if (this.gaveUpOn === invocationId) return true
    if (this.turn?.invocationId !== invocationId || !this.host.isInflight(invocationId)) return false
    const heldTurn = this.hold?.invocationId === invocationId ? this.hold : undefined
    if (heldTurn && !heldTurn.resumed) return true
    const signal = classifyApiErrorText(text, this.now())
    if (signal.kind === "other") return false
    const attempts = heldTurn?.attempts ?? 0
    if (attempts >= this.timing.maxResumeAttempts) {
      void this.giveUp(invocationId, `still blocked after ${attempts} resume attempts`, signal)
      return true
    }
    const now = this.now()
    if (signal.kind === "quota-no-reset") {
      void this.giveUp(invocationId, "the provider gave no reset time to wait for", signal)
      return true
    }
    const resumeAt =
      signal.kind === "quota-reset"
        ? signal.resetAt! + this.timing.resumeJitterMs
        : now + this.timing.transientResumeDelayMs * (attempts + 1)
    if (resumeAt - now > this.timing.maxHoldMs) {
      void this.giveUp(invocationId, `the quota reset is too far away (~${formatDuration(resumeAt - now)})`, signal)
      return true
    }
    this.beginHold(invocationId, this.turn.streamId, resumeAt, attempts, signal)
    return true
  }

  stop(): void {
    this.dropHold("channel shutting down")
  }

  private beginHold(
    invocationId: string,
    streamId: string,
    resumeAt: number,
    attempts: number,
    signal: QuotaSignal
  ): void {
    this.clearTimers()
    this.hold = {
      invocationId,
      streamId,
      resumeAt,
      attempts,
      resumed: false,
      resumeTimer: setTimeout(() => void this.resume(), Math.max(resumeAt - this.now(), this.timing.minResumeDelayMs)),
      keepAliveTimer: setInterval(() => this.keepAliveTick(), this.timing.keepAliveIntervalMs),
    }
    this.host.log(`quota carry-on: holding ${invocationId} until ${new Date(resumeAt).toISOString()} (${signal.kind})`)
    const eta = `~${formatLocalTime(resumeAt)} (in ~${formatDuration(resumeAt - this.now())})`
    const held =
      signal.kind === "quota-reset"
        ? {
            content: `${signal.summary}\n\nHolding this turn — resuming automatically ${eta}. Use \`/stop\` to drop the turn.`,
            statusText: `Rate limited — resuming ${eta}`,
          }
        : {
            content: `Provider hiccup (${signal.summary}) — retrying ${eta}.`,
            statusText: `Provider hiccup — retrying ${eta}`,
          }
    void this.host
      .reportHold(invocationId, held.content, held.statusText)
      .catch((error) => this.host.log(`carry-on hold step failed: ${String(error)}`))
  }

  private keepAliveTick(): void {
    const hold = this.hold
    if (!hold) return
    if (!this.host.isInflight(hold.invocationId)) {
      this.dropHold("turn vanished (claim lost or closed elsewhere)")
      return
    }
    this.host.keepAlive(hold.streamId)
  }

  private async resume(): Promise<void> {
    const hold = this.hold
    if (!hold) return
    hold.resumeTimer = undefined
    if (!this.host.isInflight(hold.invocationId)) {
      this.dropHold("turn closed before the resume fired")
      return
    }
    hold.attempts += 1
    this.host.log(`quota carry-on: resuming ${hold.invocationId} (attempt ${hold.attempts})`)
    const injected = await this.host.inject(buildResumePrompt(hold.invocationId))
    // /stop, a superseding turn or a fresh hold replaced this one during the inject.
    if (this.hold !== hold) return
    if (!injected) {
      await this.giveUp(hold.invocationId, "could not type into the session (tmux control unavailable)", undefined)
      return
    }
    hold.resumed = true
    this.host.holdEnded()
    // The hold stays (minus its resume timer): keep-alives continue while the
    // resumed turn works, onTurnClosed clears everything when the reply lands,
    // and a fresh quota error re-enters onApiError with the attempt count.
  }

  /** Close the turn loudly. Works with or without an active hold — the unschedulable paths (no reset time, reset too far away) give up before one exists. */
  private async giveUp(invocationId: string, reason: string, signal: QuotaSignal | undefined): Promise<void> {
    // Closing the turn claims what waited; claiming first would steer into the quota-dead prompt.
    this.dropHold(`giving up: ${reason}`, false)
    this.gaveUpOn = invocationId
    if (this.turn?.invocationId === invocationId) this.turn = undefined
    const lines = [`⚠️ Quota carry-on gave up: ${reason}.`]
    if (signal) lines.push("", `Provider said: ${signal.summary}`)
    const message = lines.join("\n")
    await this.host.closeTurn(invocationId, message).catch((error) => {
      // The SDK re-arms a failed reply for retry, but nothing here tracks the
      // turn anymore — one delayed re-attempt beats stranding it on the idle reaper.
      this.host.log(`carry-on give-up close failed (retrying once): ${String(error)}`)
      setTimeout(() => {
        void this.host
          .closeTurn(invocationId, message)
          .catch((retryError) => this.host.log(`carry-on give-up close retry failed: ${String(retryError)}`))
      }, this.timing.giveUpRetryDelayMs)
    })
  }

  private dropHold(reason: string, claimWaiting = true): void {
    const hold = this.hold
    if (!hold) return
    this.host.log(`quota carry-on: dropping hold on ${hold.invocationId} — ${reason}`)
    this.clearTimers()
    this.hold = undefined
    if (claimWaiting && !hold.resumed) this.host.holdEnded()
  }

  private clearTimers(): void {
    if (!this.hold) return
    if (this.hold.resumeTimer) clearTimeout(this.hold.resumeTimer)
    clearInterval(this.hold.keepAliveTimer)
  }
}
