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
  /** True while a turn runs or is being admitted. */
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
 * missed restore push is caught by the next reconnect or message.
 */
export class DormantLink {
  private watcher: RestoreWatcher | undefined
  private rootStreamId: string | undefined
  private idle = false
  /** The wind-down and held presence in flight; a revive waits for them, or their writes would land on the new link. */
  private settling: Promise<void> = Promise.resolve()
  private holdFailing = false
  private waking: Promise<void> | undefined
  private nudged = false
  private stopped = false
  private readonly now: () => number
  private lastActive: number

  constructor(private readonly options: DormantLinkOptions) {
    this.now = options.now ?? Date.now
    this.lastActive = this.now()
  }

  sleep(rootStreamId: string): void {
    this.enter(rootStreamId, false)
  }

  touch(): void {
    this.lastActive = this.now()
  }

  /** Runs once a minute: winds an idle session down, and keeps a wound-down session's presence fresh. */
  async tick(): Promise<void> {
    if (this.stopped) return
    if (this.rootStreamId) {
      if (this.idle && !this.waking) await this.hold()
      return
    }
    if (this.options.isBusy()) return this.touch()
    if (this.now() - this.lastActive < this.options.idleAfterMs) return
    const rootStreamId = this.options.windDownTarget()
    if (!rootStreamId) return
    // Watch before the session ends, so a message that lands while it shuts down still wakes it.
    this.enter(rootStreamId, true)
    this.options.log(
      `idle for ${Math.round(this.options.idleAfterMs / 60_000)} min; winding down until scratchpad ${rootStreamId} is used`
    )
    this.settling = this.options
      .windDown()
      .catch((error) => this.options.log(`winding down failed: ${messageOf(error)}`))
    await this.hold()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.watcher?.disconnect()
    this.watcher = undefined
    await this.waking
    await this.settling
  }

  private enter(rootStreamId: string, idle: boolean): void {
    if (this.stopped) return
    this.rootStreamId = rootStreamId
    this.idle = idle
    this.watcher?.disconnect()
    this.watcher = this.options.watch((runtimeSessionId) => {
      // Connecting says nothing about an idle session; only work addressed to it wakes it.
      if (runtimeSessionId === this.options.runtimeSessionId || (runtimeSessionId === undefined && !this.idle)) {
        void this.wake()
      }
    })
  }

  private hold(): Promise<void> {
    this.settling = this.settling.then(async () => {
      try {
        await this.options.holdPresence()
        this.holdFailing = false
      } catch (error) {
        if (!this.holdFailing) this.options.log(`holding presence failed: ${messageOf(error)}`)
        this.holdFailing = true
      }
    })
    return this.settling
  }

  private wake(): Promise<void> {
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
    if (archived || this.stopped) return
    this.options.log(`scratchpad ${rootStreamId} wanted again; linking`)
    await this.settling
    try {
      await this.options.revive(rootStreamId)
    } catch (error) {
      // The watcher stays up so the next message or reconnect retries; a new one would retry on connecting, in a loop.
      this.options.log(`linking scratchpad ${rootStreamId} again failed: ${messageOf(error)}`)
      return
    }
    this.watcher?.disconnect()
    this.watcher = undefined
    this.rootStreamId = undefined
    this.idle = false
    this.touch()
  }
}
