/**
 * How long a runtime survives its scratchpad being archived before winding
 * down. An unarchive inside this window reattaches the live agent in place.
 * Shared: Claude (`@threa/remote-session`) and Pi run separate session
 * implementations, and a grace tuned on one must not diverge from the other.
 */
export const ARCHIVE_RESTORE_GRACE_MS = 5 * 60 * 1000
/** Reattach-probe cadence while detached. Bounded by the grace window, so it cannot become a quota burn. */
export const ARCHIVE_RESTORE_PROBE_MS = 45_000
/**
 * Poll cadence while the `/bot` socket is up: pushes deliver work within a
 * frame, so the poll is only a backstop for a dropped one. Shared because it
 * is also the worst case for a runtime to notice an archive it was not pushed,
 * which is what any external reaper has to wait out.
 */
export const WS_BACKSTOP_POLL_MS = 15 * 60 * 1000

/**
 * The archive → grace → wind-down state machine, shared by every harness
 * runtime.
 *
 * Archiving a scratchpad ends its session server-side, so the worktree behind
 * it is finished — but archiving is also how a mis-click gets undone, so the
 * wind-down (hand the worktree to harnessd, kill the tmux window) waits out a
 * grace window that an unarchive can cancel.
 *
 * This is deliberately one implementation rather than one per runtime. Every
 * bug this machine has produced came from the same shape: state read before an
 * `await` and acted on after it, once the deadline had already fired or a
 * second caller had won. The `pending` object is the identity token — every
 * resumption re-checks `this.pending !== pending` and bails, which is what
 * makes the wind-down terminal.
 */

export interface ArchiveGraceHooks {
  /**
   * Server truth for the attached direction. `undefined` means "could not
   * tell" (transient failure, missing scope, outage) and never detaches — a
   * diagnostic that did not run is not evidence the scratchpad is archived.
   */
  isArchived(rootStreamId: string): Promise<boolean | undefined>
  /**
   * Server truth for the detached direction: try to revive this runtime's link.
   * `true` once reattached, `false` while the scratchpad is still archived.
   * Throwing is treated as `false` — the probe cadence retries.
   */
  reattach(rootStreamId: string): Promise<boolean>
  /** Detach effects: go offline, suspend claiming, pull the poll onto {@link probeDelayMs}. */
  onDetached(rootStreamId: string, graceMs: number): Promise<void> | void
  /** Reattach effects: back to available, resume claiming. */
  onReattached(rootStreamId: string): Promise<void> | void
  /**
   * Terminal. Hand the worktree to harnessd ({@link markHarnessLinkWoundDown})
   * and take the window down; the runtime usually dies here. Preserving the
   * branch and removing the worktree is harnessd's job, never a runtime's —
   * only harnessd holds the lock a concurrent revive also takes.
   */
  onWindDown(rootStreamId: string): Promise<void> | void
  log(message: string): void
}

export interface ArchiveGraceOptions {
  /** Override the grace window. Tests use a few hundred ms; production takes the shared default. */
  graceMs?: number
}

interface Pending {
  rootStreamId: string
  deadline: ReturnType<typeof setTimeout>
}

export class ArchiveGraceController {
  private pending: Pending | undefined
  private probing = false
  private stopped = false
  private transitions = 0
  private readonly graceMs: number

  constructor(
    private readonly hooks: ArchiveGraceHooks,
    options: ArchiveGraceOptions = {}
  ) {
    this.graceMs = options.graceMs ?? ARCHIVE_RESTORE_GRACE_MS
  }

  /** Detached and waiting out the grace: claims must stay suspended while this is true. */
  get detached(): boolean {
    return this.pending !== undefined
  }

  get pendingRootStreamId(): string | undefined {
    return this.pending?.rootStreamId
  }

  /**
   * Bumped on every attach/detach transition. A runtime with a request already
   * in flight snapshots this before awaiting and drops its result if the value
   * moved — otherwise a link created before the archive lands is committed
   * after it, resurrecting a link to a scratchpad that is archived
   * server-side.
   */
  get generation(): number {
    return this.transitions
  }

  /**
   * Poll cadence while detached, scaled so several probes always fit inside the
   * grace even when it is shortened for a test. Bounded by the window, so it
   * cannot become a quota burn.
   */
  get probeDelayMs(): number {
    return Math.min(ARCHIVE_RESTORE_PROBE_MS, Math.max(Math.floor(this.graceMs / 4), 10))
  }

  /**
   * This root is archived (a `bot:session_archived` push, or a probe that
   * found `archivedAt`). Callers scope the event to their own runtime session
   * and current root before calling — a stale event for a retired root must
   * never wind down the scratchpad now linked.
   */
  async archived(rootStreamId: string): Promise<void> {
    if (this.stopped || this.pending) return
    const pending: Pending = {
      rootStreamId,
      deadline: setTimeout(() => void this.windDown(pending), this.graceMs),
    }
    this.pending = pending
    this.transitions += 1
    this.hooks.log(
      `scratchpad ${rootStreamId} archived — detaching (reattaches if unarchived within ${Math.round(this.graceMs / 1000)}s)`
    )
    await this.hooks.onDetached(rootStreamId, this.graceMs)
  }

  /**
   * The scratchpad came back (a `bot:session_restored` push). Revives the link
   * and cancels the wind-down; a transient failure keeps the detached state so
   * the probe cadence retries inside the remaining window.
   */
  async restored(): Promise<void> {
    const pending = this.pending
    if (this.stopped || !pending) return
    // The server says the scratchpad is back, so restart the clock even if the
    // relink below fails transiently: winding down 1s after an unarchive push
    // because the grace happened to be nearly spent is the exact mis-click
    // recovery this window exists for. Same `pending` object, so every
    // post-await identity check still holds.
    clearTimeout(pending.deadline)
    pending.deadline = setTimeout(() => void this.windDown(pending), this.graceMs)
    await this.attemptReattach(pending)
  }

  /**
   * The poll-tick backstop. `bot:session_archived` is a one-shot push with no
   * replay, so a runtime whose socket was down when the archive landed would
   * otherwise hold its worktree forever. Re-derives from the server and drives
   * whichever direction applies.
   */
  async probe(currentRootStreamId: string | undefined): Promise<void> {
    if (this.stopped || this.probing) return
    this.probing = true
    try {
      const pending = this.pending
      if (pending) {
        await this.attemptReattach(pending)
        return
      }
      if (!currentRootStreamId) return
      const archived = await this.hooks.isArchived(currentRootStreamId)
      if (archived !== true) return
      // The awaits above can race a real push or a relink onto another root.
      if (this.stopped || this.pending) return
      this.hooks.log(`archive backstop: ${currentRootStreamId} is archived with no push received`)
      await this.archived(currentRootStreamId)
    } catch (error) {
      this.hooks.log(`archive probe failed: ${describe(error)}`)
    } finally {
      this.probing = false
    }
  }

  /** Teardown. Disarms the deadline so a shutting-down runtime cannot wind down behind itself. */
  stop(): void {
    this.stopped = true
    if (this.pending) clearTimeout(this.pending.deadline)
    this.pending = undefined
  }

  private async attemptReattach(pending: Pending): Promise<void> {
    let reattached = false
    try {
      reattached = await this.hooks.reattach(pending.rootStreamId)
    } catch (error) {
      this.hooks.log(`reattach failed, staying detached: ${describe(error)}`)
      return
    }
    // The deadline can fire, or a second caller can win, while the request
    // above is in flight. Reattaching against a session that already wound
    // down would resurrect a dead worktree.
    if (!reattached || this.stopped || this.pending !== pending) return
    clearTimeout(pending.deadline)
    this.pending = undefined
    this.transitions += 1
    this.hooks.log(`scratchpad ${pending.rootStreamId} restored — reattached`)
    await this.hooks.onReattached(pending.rootStreamId)
  }

  private async windDown(pending: Pending): Promise<void> {
    if (this.stopped || this.pending !== pending) return
    clearTimeout(pending.deadline)
    this.pending = undefined
    this.transitions += 1
    this.hooks.log(`scratchpad ${pending.rootStreamId} stayed archived — winding down`)
    try {
      await this.hooks.onWindDown(pending.rootStreamId)
    } catch (error) {
      this.hooks.log(`wind-down failed: ${describe(error)}`)
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
