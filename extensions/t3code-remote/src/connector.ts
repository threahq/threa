import { join } from "node:path"
import { RemoteSession, ThreaClient, writeFileAtomic, type ShutdownOptions } from "@threahq/remote-session"
import { T3Auth, type FetchLike } from "./auth"
import { readJsonFile, type T3RemoteConfig } from "./config"
import { T3CODE_RUNTIME, T3TurnRunner, type ThreadStore } from "./run-bridge"
import { createT3SessionControl } from "./session-control"
import { T3Client } from "./t3-client"

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
      const { instanceId, model } = (parsed.model ?? {}) as { instanceId?: unknown; model?: unknown }
      return typeof instanceId === "string" && typeof model === "string"
        ? { threads, model: { instanceId, model } }
        : { threads }
    },
    save: (state) => writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`),
  }
}

export interface T3ConnectorOptions {
  fetch?: FetchLike
  log?: (message: string) => void
}

export interface T3Connector {
  session: RemoteSession
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
    },
    access: config.t3.access,
    ...(config.t3.projectId === undefined ? {} : { projectId: config.t3.projectId }),
    traceMode: config.traceMode,
    sealedFullTrace: config.sealedFullTrace,
    threadStore: createFileThreadStore(join(config.install.workDir, "threads.json")),
    log,
  })
  const sessionControl = createT3SessionControl(runner, t3)

  session = new RemoteSession({
    config,
    client: new ThreaClient(config),
    delegate: { deliverTurn: (turn) => runner.deliverTurn(turn), sessionControl },
    runtime: T3CODE_RUNTIME,
    log,
  })

  return {
    session,
    start: async () => {
      // Fails before linking when there is no token and auto-login is off.
      await auth.token()
      await session.start()
    },
    shutdown: async (shutdownOptions?: ShutdownOptions) => {
      runner.shutdown()
      await session.shutdown(shutdownOptions)
    },
  }
}
