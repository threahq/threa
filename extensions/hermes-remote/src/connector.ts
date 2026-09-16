import { RemoteSession, ThreaClient, type ShutdownOptions } from "@threahq/remote-session"
import type { HermesRemoteConfig } from "./config"
import { HermesRunsClient, type FetchLike } from "./hermes-client"
import { HERMES_RUNTIME, HermesTurnRunner } from "./run-bridge"

export interface HermesConnectorOptions {
  fetch?: FetchLike
  log?: (message: string) => void
}

export interface HermesConnector {
  session: RemoteSession
  start(): Promise<void>
  shutdown(options?: ShutdownOptions): Promise<void>
}

export function createHermesConnector(
  config: HermesRemoteConfig,
  options: HermesConnectorOptions = {}
): HermesConnector {
  const log = options.log ?? (() => {})
  const client = new ThreaClient(config)
  const hermes = new HermesRunsClient({
    baseUrl: config.hermes.apiUrl,
    apiKey: config.hermes.apiKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  let session: RemoteSession
  const runner = new HermesTurnRunner({
    client: hermes,
    // The session is constructed below; the runner only reaches it once a turn runs.
    session: {
      get rootStreamId() {
        return session.rootStreamId
      },
      recordSteps: (id, frames, statusText) => session.recordSteps(id, frames, statusText),
      reply: (id, text) => session.reply(id, text),
      failTurn: (id, message) => session.failTurn(id, message),
    },
    // Long-term memory scope (X-Hermes-Session-Key): one per Threa scratchpad. The
    // conversation itself is selected by session_id, the stream the turn arrived on.
    sessionKeyFor: (streamId) => `threa:${config.workspaceId}:${session.rootStreamId ?? streamId}`,
    log,
  })

  session = new RemoteSession({
    config,
    client,
    delegate: { deliverTurn: (turn) => runner.deliverTurn(turn) },
    runtime: HERMES_RUNTIME,
    log,
  })

  return {
    session,
    start: () => session.start(),
    shutdown: async (shutdownOptions?: ShutdownOptions) => {
      runner.shutdown()
      await session.shutdown(shutdownOptions)
    },
  }
}
