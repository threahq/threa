import { join } from "node:path"
import { BotSupervisorTransport, heldPresenceBody } from "@threahq/harness-client"
import {
  RemoteSession,
  ThreaClient,
  writeFileAtomic,
  type RuntimePresenceReport,
  type ShutdownOptions,
} from "@threahq/remote-session"
import { T3Auth, type FetchLike } from "./auth"
import { readJsonFile, type T3RemoteConfig } from "./config"
import { DormantLink } from "./dormant-link"
import { T3CODE_RUNTIME, T3TurnRunner, type ThreadStore } from "./run-bridge"
import { createT3SessionControl } from "./session-control"
import { T3Client, type ModelOption } from "./t3-client"

function isModelOption(option: unknown): option is ModelOption {
  const { id, value } = (option ?? {}) as { id?: unknown; value?: unknown }
  return typeof id === "string" && (typeof value === "string" || typeof value === "boolean")
}

/** Stream → thread links and the `/model` default, swapped in whole so a crash cannot truncate it. */
export function createFileThreadStore(path: string): ThreadStore {
  return {
    load: () => {
      const parsed = readJsonFile(path) ?? {}
      const threads = Object.fromEntries(
        Object.entries((parsed.threads ?? {}) as Record<string, unknown>).flatMap(([streamId, threadId]) =>
          typeof threadId === "string" && threadId.length > 0 ? [[streamId, threadId] as const] : []
        )
      )
      const { instanceId, model, options } = (parsed.model ?? {}) as {
        instanceId?: unknown
        model?: unknown
        options?: unknown
      }
      if (typeof instanceId !== "string" || typeof model !== "string") return { threads }
      const kept = Array.isArray(options) ? options.filter(isModelOption) : []
      return { threads, model: { instanceId, model, ...(kept.length > 0 ? { options: kept } : {}) } }
    },
    save: (state) => writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`),
  }
}

export interface T3ConnectorOptions {
  fetch?: FetchLike
  log?: (message: string) => void
}

const IDLE_WIND_DOWN_AFTER_MS = 90 * 60_000
const IDLE_TICK_MS = 60_000

export interface T3Connector {
  start(): Promise<void>
  shutdown(options?: ShutdownOptions): Promise<void>
}

export function createT3Connector(config: T3RemoteConfig, options: T3ConnectorOptions = {}): T3Connector {
  const log = options.log ?? (() => {})
  const auth = new T3Auth({
    url: config.t3.url,
    access: config.t3.access,
    tokenPath: config.install.tokenPath,
    autoLogin: config.t3.autoLogin,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    log,
  })
  const t3 = new T3Client(config.t3.url, auth, options.fetch)

  let session: RemoteSession
  const runner = new T3TurnRunner({
    client: t3,
    // The session is constructed below; the runner only reaches it once a turn runs.
    session: {
      get rootStreamId() {
        return session.rootStreamId
      },
      recordSteps: (id, frames, statusText) => session.recordSteps(id, frames, statusText),
      reply: (id, text) => session.reply(id, text),
      failTurn: (id, message) => session.failTurn(id, message),
      requestDecision: (input, opts) => session.requestDecision(input, opts),
    },
    access: config.t3.access,
    ...(config.t3.projectId === undefined ? {} : { projectId: config.t3.projectId }),
    traceMode: config.traceMode,
    sealedFullTrace: config.sealedFullTrace,
    threadStore: createFileThreadStore(join(config.install.workDir, "threads.json")),
    log,
  })
  const sessionControl = createT3SessionControl(runner, t3)
  const client = new ThreaClient(config)
  let presence: RuntimePresenceReport | undefined

  // An archived scratchpad, or 90 minutes without a turn, ends the session. The process stays up and links it again
  // once the scratchpad is restored or a message arrives, holding the session's presence meanwhile when it went idle.
  const dormant = new DormantLink({
    runtimeSessionId: config.runtimeSessionId,
    watch: (nudge) => {
      const watcher = new BotSupervisorTransport({
        baseUrl: config.baseUrl,
        workspaceId: config.workspaceId,
        apiKey: config.apiKey,
        onReady: () => nudge(),
        onSessionRestored: (payload) => nudge(payload.runtimeSessionId),
        onInvocationAvailable: (payload) => nudge(payload.runtimeSessionId),
        log,
      })
      void watcher.connect()
      return watcher
    },
    isArchived: async (rootStreamId) => Boolean(await client.getStreamArchivedAt(rootStreamId)),
    revive: async (rootStreamId) => {
      // Wait rather than replace: an archive landing between the check and the link must not mint a new scratchpad.
      session = createSession({ coldStartIfArchived: "wait", expectedRootStreamId: rootStreamId })
      try {
        await session.start()
      } catch (error) {
        await session.shutdown()
        throw error
      }
    },
    isBusy: () => runner.busy,
    // Without the presence the session last published there is nothing honest to hold, so it stays up (INV-11).
    windDownTarget: () => (presence ? session.rootStreamId : undefined),
    windDown: async () => {
      runner.shutdown()
      await session.shutdown()
    },
    holdPresence: async () => {
      if (presence) await client.updatePresence(heldPresenceBody(presence))
    },
    idleAfterMs: IDLE_WIND_DOWN_AFTER_MS,
    log,
  })
  const idleTimer = setInterval(() => void dormant.tick(), IDLE_TICK_MS)

  const createSession = (link: Partial<T3RemoteConfig> = {}) =>
    new RemoteSession({
      config: { ...config, ...link },
      client,
      delegate: {
        deliverTurn: (turn) => {
          dormant.touch()
          return runner.deliverTurn(turn)
        },
        sessionControl,
        onArchived: ({ rootStreamId }) => {
          runner.shutdown()
          log(`scratchpad ${rootStreamId} archived; waiting for it to be restored`)
          dormant.sleep(rootStreamId)
        },
      },
      runtime: T3CODE_RUNTIME,
      onPresence: (report) => {
        if (report.status !== "offline") presence = report
      },
      log,
    })
  session = createSession()

  return {
    start: async () => {
      // Fails before linking when there is no token and auto-login is off.
      await auth.token()
      await session.start()
    },
    shutdown: async (shutdownOptions?: ShutdownOptions) => {
      clearInterval(idleTimer)
      await dormant.stop()
      runner.shutdown()
      await session.shutdown(shutdownOptions)
    },
  }
}
