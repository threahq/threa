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
 *  2. posts one notice to the scratchpad with the resume time,
 *  3. queues any `/carry-on <text>` (and `/steer`) messages the user sends
 *     while blocked, and
 *  4. at reset time pastes a continuation prompt into the idle TUI — the same
 *     invocation answers, so its trace shows the wait and the resume.
 *
 * Give-up paths (attempt cap, unschedulable reset, lost tmux control) close
 * the turn with a message that carries the queued texts verbatim, so nothing
 * is ever dropped silently.
 */

export interface CarryOnTiming {
  keepAliveIntervalMs: number
  transientResumeDelayMs: number
  /** Resume slightly after the printed reset minute — the quota flips sometime within it. */
  resumeJitterMs: number
  maxHoldMs: number
  maxResumeAttempts: number
  minResumeDelayMs: number
  /** One delayed re-attempt when posting the give-up close fails (a transient API error there would strand the turn on the idle reaper and eat the queued texts). */
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
  postNotice(streamId: string, text: string): Promise<void>
  /** Close the held invocation with a final message (the SDK reply path). */
  closeTurn(invocationId: string, text: string): Promise<void>
  /** Submit a fresh prompt into the idle runtime. False = control lost. */
  inject(text: string): Promise<boolean>
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
  keepAliveTimer: ReturnType<typeof setInterval>
}

function formatLocalTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
}

function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000)
  if (totalMin < 1) return "<1 min"
  if (totalMin < 60) return `${totalMin} min`
  const hours = Math.floor(totalMin / 60)
  const minutes = totalMin % 60
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

function quoteQueued(queue: readonly string[]): string {
  return queue.map((text, i) => `${i + 1}. ${text}`).join("\n")
}

export function buildResumePrompt(invocationId: string, queued: readonly string[]): string {
  const lines = [
    "[Quota carry-on] The provider quota should be available again. Continue the work for invocation " +
      `${invocationId} exactly where it left off. When finished, call the reply tool with that invocation_id as usual.`,
  ]
  if (queued.length > 0) {
    lines.push("", "Instructions the user queued while the session was blocked (oldest first):", quoteQueued(queued))
  }
  return lines.join("\n")
}

export class CarryOnController {
  private turn: { invocationId: string; streamId: string } | undefined
  private hold: Hold | undefined
  private queue: string[] = []
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

  /**
   * /steer while blocked folds into the carry-on queue instead of poking a
   * quota-dead session (the paste would submit a prompt that immediately dies).
   * Returns the ack when absorbed; undefined when no hold is active.
   */
  absorbSteer(text: string): string | undefined {
    if (!this.hold || !text.trim()) return undefined
    this.queue.push(text.trim())
    return `Session is blocked on provider quota — queued the steer for the resume ~${formatLocalTime(this.hold.resumeAt)}.`
  }

  /** The /carry-on command. Returns the user-facing ack. */
  enqueue(text: string): { ok: boolean; message: string } {
    const trimmed = text.trim()
    if (!this.hold) {
      return {
        ok: false,
        message: trimmed
          ? "No quota block is active — send this as a normal message and the session will pick it up."
          : "No quota block is active; nothing to carry on from.",
      }
    }
    const eta = `~${formatLocalTime(this.hold.resumeAt)} (in ~${formatDuration(this.hold.resumeAt - this.now())})`
    if (!trimmed) {
      const queuedNote = this.queue.length > 0 ? ` ${this.queue.length} message(s) queued.` : ""
      return { ok: true, message: `Waiting for the provider quota — resuming ${eta}.${queuedNote}` }
    }
    this.queue.push(trimmed)
    return { ok: true, message: `Queued — the session folds it in when it resumes ${eta}.` }
  }

  /** A synthetic API-error line landed for an in-flight turn. */
  onApiError(invocationId: string, text: string): void {
    if (this.turn?.invocationId !== invocationId || !this.host.isInflight(invocationId)) return
    const signal = classifyApiErrorText(text, this.now())
    if (signal.kind === "other") return
    const attempts = this.hold?.invocationId === invocationId ? this.hold.attempts : 0
    if (attempts >= this.timing.maxResumeAttempts) {
      void this.giveUp(invocationId, `still blocked after ${attempts} resume attempts`, signal)
      return
    }
    const now = this.now()
    if (signal.kind === "quota-no-reset") {
      void this.giveUp(invocationId, "the provider gave no reset time to wait for", signal)
      return
    }
    const resumeAt =
      signal.kind === "quota-reset"
        ? signal.resetAt! + this.timing.resumeJitterMs
        : now + this.timing.transientResumeDelayMs * (attempts + 1)
    if (resumeAt - now > this.timing.maxHoldMs) {
      void this.giveUp(invocationId, `the quota reset is too far away (~${formatDuration(resumeAt - now)})`, signal)
      return
    }
    this.beginHold(invocationId, this.turn.streamId, resumeAt, attempts, signal)
  }

  /** Channel shutdown. dropHold's best-effort orphan notice is the only shot at surfacing queued texts before the process dies. */
  stop(): void {
    this.dropHold("channel shutting down")
    this.queue = []
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
      resumeTimer: setTimeout(() => void this.resume(), Math.max(resumeAt - this.now(), this.timing.minResumeDelayMs)),
      keepAliveTimer: setInterval(() => this.keepAliveTick(), this.timing.keepAliveIntervalMs),
    }
    this.host.log(`quota carry-on: holding ${invocationId} until ${new Date(resumeAt).toISOString()} (${signal.kind})`)
    const eta = `~${formatLocalTime(resumeAt)} (in ~${formatDuration(resumeAt - this.now())})`
    const notice =
      signal.kind === "quota-reset"
        ? `⏳ ${signal.summary}\n\nHolding this turn — resuming automatically ${eta}. Use \`/carry-on <message>\` to queue instructions for the resume, or \`/stop\` to drop the turn.`
        : `⏳ Provider hiccup (${signal.summary}) — retrying ${eta}.`
    void this.host
      .postNotice(streamId, notice)
      .catch((error) => this.host.log(`carry-on notice failed: ${String(error)}`))
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
    const queued = this.queue
    this.queue = []
    this.host.log(`quota carry-on: resuming ${hold.invocationId} (attempt ${hold.attempts})`)
    if (!(await this.host.inject(buildResumePrompt(hold.invocationId, queued)))) {
      // Re-queue so the give-up message carries them.
      this.queue = queued
      await this.giveUp(hold.invocationId, "could not type into the session (tmux control unavailable)", undefined)
      return
    }
    // The hold stays (minus its resume timer): keep-alives continue while the
    // resumed turn works, onTurnClosed clears everything when the reply lands,
    // and a fresh quota error re-enters onApiError with the attempt count.
  }

  /**
   * Close the turn loudly, carrying any queued texts so nothing is lost in a
   * silent drop. Works with or without an active hold — the unschedulable
   * paths (no reset time, reset too far away) give up before one exists.
   */
  private async giveUp(invocationId: string, reason: string, signal: QuotaSignal | undefined): Promise<void> {
    // Take the queue before dropping the hold so its texts ride the close
    // message instead of double-posting via dropHold's orphan notice.
    const queued = this.queue
    this.queue = []
    this.dropHold(`giving up: ${reason}`)
    if (this.turn?.invocationId === invocationId) this.turn = undefined
    const lines = [`⚠️ Quota carry-on gave up: ${reason}.`]
    if (signal) lines.push("", `Provider said: ${signal.summary}`)
    if (queued.length > 0) {
      lines.push("", "Dropped queued instructions (resend when the session is available):", quoteQueued(queued))
    }
    const message = lines.join("\n")
    await this.host.closeTurn(invocationId, message).catch((error) => {
      // The SDK re-arms a failed reply for retry, but nothing here tracks the
      // turn anymore — one delayed re-attempt beats stranding it (and the
      // queued texts named in the message) on the idle reaper.
      this.host.log(`carry-on give-up close failed (retrying once): ${String(error)}`)
      setTimeout(() => {
        void this.host
          .closeTurn(invocationId, message)
          .catch((retryError) => this.host.log(`carry-on give-up close retry failed: ${String(retryError)}`))
      }, this.timing.giveUpRetryDelayMs)
    })
  }

  private dropHold(reason: string): void {
    const hold = this.hold
    if (!hold) return
    this.host.log(`quota carry-on: dropping hold on ${hold.invocationId} — ${reason}`)
    this.clearTimers()
    this.hold = undefined
    if (this.queue.length > 0) {
      const dropped = this.queue
      this.queue = []
      // The turn these were queued for is gone; surface them instead of losing them.
      void this.host
        .postNotice(
          hold.streamId,
          `Dropped ${dropped.length} queued carry-on message(s) with the held turn:\n${quoteQueued(dropped)}`
        )
        .catch((error) => this.host.log(`carry-on drop notice failed: ${String(error)}`))
    }
  }

  private clearTimers(): void {
    if (!this.hold) return
    if (this.hold.resumeTimer) clearTimeout(this.hold.resumeTimer)
    clearInterval(this.hold.keepAliveTimer)
  }
}
