import type { HibernationRecord } from "./hibernation"

export interface WakerOptions {
  hibernating: () => HibernationRecord[]
  isArchived: (rootStreamId: string) => Promise<boolean>
  start: (unit: string) => void
  log: (message: string) => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Starts hibernating connector units again. It holds no session and no T3 client: one supervisor socket hears every
 * restore and every message for the bot's sessions, and starting a unit that is already up is a no-op.
 */
export function createWaker(options: WakerOptions) {
  const start = (record: HibernationRecord, why: string) => {
    options.log(`${why}; starting ${record.unit}`)
    try {
      options.start(record.unit)
    } catch (error) {
      options.log(`starting ${record.unit} failed: ${messageOf(error)}`)
    }
  }
  return {
    /** A restore or a message named this session. */
    nudge(runtimeSessionId: string): void {
      const record = options.hibernating().find((entry) => entry.runtimeSessionId === runtimeSessionId)
      if (record) start(record, `session ${runtimeSessionId} wanted again`)
    },
    /** The socket (re)connected: catch a restore pushed while it was down. */
    async sweep(): Promise<void> {
      for (const record of options.hibernating()) {
        if (!record.rootStreamId) continue
        try {
          if (!(await options.isArchived(record.rootStreamId)))
            start(record, `scratchpad ${record.rootStreamId} restored`)
        } catch (error) {
          options.log(`could not check scratchpad ${record.rootStreamId}: ${messageOf(error)}`)
        }
      }
    },
  }
}
