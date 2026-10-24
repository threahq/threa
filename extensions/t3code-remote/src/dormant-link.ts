export interface RestoreWatcher {
  disconnect(): void
}

export interface DormantLinkOptions {
  runtimeSessionId: string
  /**
   * Opens a socket that links nothing and holds no presence. `nudge` fires when it connects (without a session id),
   * and on a restore or queued work naming a session.
   */
  watch: (nudge: (runtimeSessionId?: string) => void) => RestoreWatcher
  isArchived: (rootStreamId: string) => Promise<boolean>
  /** Links the session to the restored scratchpad again; throws when it cannot. */
  revive: (rootStreamId: string) => Promise<void>
  /** True from a turn's claim until its run ends, and while a run T3 started by itself is followed. */
  isBusy: () => boolean
  /** The scratchpad a wind-down would leave, or undefined when the session can't wind down now. */
  windDownTarget: () => string | undefined
  /** Ends the linked session. */
  windDown: () => Promise<void>
  /** Posts the wound-down session's last presence on its behalf, so messages and commands still reach it. */
  holdPresence: () => Promise<void>
  idleAfterMs: number
  now?: () => number
  log: (message: string) => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Waits without a session, and links it again when it is wanted: after an archive once the scratchpad is restored,
 * after an idle wind-down once a message or command arrives for it. Each nudge checks the scratchpad itself, so a
 * missed restore push is caught by the next reconnect or message, a wake that failed is retried every tick, and a
 * presence hold that failed links the session again.
 */
export class DormantLink {
  private watcher: RestoreWatcher | undefined
  private rootStreamId: string | undefined
  /** `pending`: idle, the session still up until the watcher is subscribed. */
  private mode: "archived" | "pending" | "idle" | undefined
  private idleSince = 0
  private wanted = false
  /** The wind-down and held presence in flight; a revive waits for them, or their writes would land on the new link. */
  private settling: Promise<void> = Promise.resolve()
  private waking: Promise<void> | undefined
  private nudged = false
  private stopped = false
  private readonly now: () => number
  private lastActive: number

  constructor(private readonly options: DormantLinkOptions) {
    this.now = options.now ?? Date.now
    this.lastActive = this.now()
  }

  get archived(): boolean {
    return this.mode === "archived"
  }

  sleep(rootStreamId: string): void {
    this.enter(rootStreamId, "archived")
  }

  touch(): void {
    this.lastActive = this.now()
  }

  /** Runs once a minute: winds an idle session down, and keeps a wound-down session's presence fresh. */
  async tick(): Promise<void> {
    if (this.stopped) return
    if (this.rootStreamId) {
      if (this.wanted && !this.waking) void this.wake()
      if (this.mode === "idle" && !this.waking) await this.hold()
      return
    }
    if (this.options.isBusy()) return this.touch()
    if (this.now() - this.lastActive < this.options.idleAfterMs) return
    const rootStreamId = this.options.windDownTarget()
    if (!rootStreamId) return
    // The session ends once the watcher is subscribed, so a message landing while it shuts down reaches one of them.
    this.idleSince = this.lastActive
    this.enter(rootStreamId, "pending")
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.watcher?.disconnect()
    this.watcher = undefined
    await this.waking
    await this.settling
  }

  private enter(rootStreamId: string, mode: "archived" | "pending"): void {
    if (this.stopped) return
    this.rootStreamId = rootStreamId
    this.mode = mode
    this.watcher?.disconnect()
    this.watcher = this.options.watch((runtimeSessionId) => {
      if (this.mode === "pending") {
        if (runtimeSessionId === undefined) void this.windDown()
        return
      }
      // Connecting says nothing about an idle session; only work addressed to it wakes it.
      if (
        runtimeSessionId === this.options.runtimeSessionId ||
        (runtimeSessionId === undefined && this.mode === "archived")
      ) {
        void this.wake()
      }
    })
  }

  private async windDown(): Promise<void> {
    if (this.stopped) return
    if (this.options.isBusy() || this.lastActive !== this.idleSince) return this.leave()
    this.mode = "idle"
    this.options.log(
      `idle for ${Math.round(this.options.idleAfterMs / 60_000)} min; winding down until scratchpad ${this.rootStreamId} is used`
    )
    this.settling = this.options
      .windDown()
      .catch((error) => this.options.log(`winding down failed: ${messageOf(error)}`))
    await this.hold()
  }

  private leave(): void {
    this.watcher?.disconnect()
    this.watcher = undefined
    this.rootStreamId = undefined
    this.mode = undefined
    this.wanted = false
  }

  private hold(): Promise<void> {
    this.settling = this.settling.then(async () => {
      try {
        await this.options.holdPresence()
      } catch (error) {
        // The ended session's presence is offline until a hold lands, which hides its commands; linking again is honest.
        this.options.log(`holding presence failed: ${messageOf(error)}; linking again`)
        void this.wake()
      }
    })
    return this.settling
  }

  private wake(): Promise<void> {
    this.wanted = true
    // A restore that lands while the scratchpad is being checked must not be lost to a check that saw it archived.
    this.nudged = true
    this.waking ??= (async () => {
      while (this.nudged && this.rootStreamId && !this.stopped) {
        this.nudged = false
        await this.tryWake(this.rootStreamId)
      }
    })().finally(() => {
      this.waking = undefined
    })
    return this.waking
  }

  private async tryWake(rootStreamId: string): Promise<void> {
    let archived: boolean
    try {
      archived = await this.options.isArchived(rootStreamId)
    } catch (error) {
      this.options.log(`could not check whether scratchpad ${rootStreamId} is still archived: ${messageOf(error)}`)
      return
    }
    if (archived) this.wanted = false
    if (archived || this.stopped) return
    this.options.log(`scratchpad ${rootStreamId} wanted again; linking`)
    await this.settling
    try {
      await this.options.revive(rootStreamId)
    } catch (error) {
      // The watcher stays up and the next tick retries; a new watcher would retry on connecting, in a loop.
      this.options.log(`linking scratchpad ${rootStreamId} again failed: ${messageOf(error)}`)
      return
    }
    this.leave()
    this.touch()
  }
}
