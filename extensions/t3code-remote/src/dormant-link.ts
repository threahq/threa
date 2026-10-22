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
  log: (message: string) => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Waits out an archived scratchpad without a session, and links it again once the scratchpad is back. Each nudge
 * checks the scratchpad itself, so a missed restore push is caught by the next reconnect or message.
 */
export class DormantLink {
  private watcher: RestoreWatcher | undefined
  private rootStreamId: string | undefined
  private waking: Promise<void> | undefined
  private nudged = false
  private stopped = false

  constructor(private readonly options: DormantLinkOptions) {}

  sleep(rootStreamId: string): void {
    if (this.stopped) return
    this.rootStreamId = rootStreamId
    this.watcher?.disconnect()
    this.watcher = this.options.watch((runtimeSessionId) => {
      if (runtimeSessionId === undefined || runtimeSessionId === this.options.runtimeSessionId) void this.wake()
    })
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.watcher?.disconnect()
    this.watcher = undefined
    await this.waking
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
    this.options.log(`scratchpad ${rootStreamId} restored; linking again`)
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
  }
}
