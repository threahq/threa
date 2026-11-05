import { BotSupervisorTransport } from "@threahq/harness-client"
import { ThreaClient } from "@threahq/remote-session"
import type { T3RemoteConfig } from "./config"
import { Hibernation, hibernationDir, systemctlUser, type HibernationRecord } from "./hibernation"

export interface WakerOptions {
  hibernating: () => HibernationRecord[]
  isArchived: (rootStreamId: string) => Promise<boolean>
  start: (unit: string) => void
  log: (message: string) => void
}

/**
 * Starts hibernating connector units again. It holds no session and no T3 client: one supervisor socket hears every
 * restore and every message for the bot's sessions, and starting a unit that is already up is a no-op.
 */
export function createWaker(options: WakerOptions) {
  const startUnit = (record: HibernationRecord, why: string) => {
    options.log(`${why}; starting ${record.unit}`)
    try {
      options.start(record.unit)
    } catch (error) {
      options.log(`starting ${record.unit} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    /** A restore or a message named this session. */
    nudge(runtimeSessionId: string): void {
      const record = options.hibernating().find((entry) => entry.runtimeSessionId === runtimeSessionId)
      if (record) startUnit(record, `session ${runtimeSessionId} wanted again`)
    },
    /** Catch restores no push reached this waker for. */
    async sweep(): Promise<void> {
      for (const record of options.hibernating()) {
        if (!record.rootStreamId) continue
        try {
          const archived = await options.isArchived(record.rootStreamId)
          if (!archived) startUnit(record, `scratchpad ${record.rootStreamId} restored`)
        } catch (error) {
          options.log(
            `could not check scratchpad ${record.rootStreamId}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    },
  }
}

const WAKE_RECONNECT_MS = 60_000
/** A restore pushed while its connector was still winding down, before its record existed, wakes nothing. */
const WAKE_SWEEP_MS = 10 * 60_000

/** `threa-t3code wake`: the one resident process while connectors hibernate, starting each again when it is wanted. */
export function createWakeService(config: T3RemoteConfig, deps: { log: (message: string) => void }) {
  const { log } = deps
  const dir = hibernationDir()
  const client = new ThreaClient(config)
  const hibernation = new Hibernation(dir, systemctlUser, log)
  const waker = createWaker({
    hibernating: () => hibernation.list(),
    isArchived: async (rootStreamId) => Boolean(await client.getStreamArchivedAt(rootStreamId)),
    start: (unit) => systemctlUser(["start", unit]),
    log,
  })
  const transport = new BotSupervisorTransport({
    baseUrl: config.baseUrl,
    workspaceId: config.workspaceId,
    apiKey: config.apiKey,
    onReady: () => {
      log("listening for restores")
      void waker.sweep()
    },
    onSessionRestored: (payload) => waker.nudge(payload.runtimeSessionId),
    onInvocationAvailable: (payload) => waker.nudge(payload.runtimeSessionId),
    log,
  })
  let timers: ReturnType<typeof setInterval>[] = []
  return {
    start(): void {
      log(`waking hibernating connectors (${hibernation.list().length} now) from ${dir}`)
      // A refused or failed connect drops the socket; connecting again is a no-op while one is up.
      timers = [
        setInterval(() => void transport.connect(), WAKE_RECONNECT_MS),
        setInterval(() => void waker.sweep(), WAKE_SWEEP_MS),
      ]
      void transport.connect()
    },
    async shutdown(): Promise<void> {
      for (const timer of timers) clearInterval(timer)
      transport.disconnect()
    },
  }
}
