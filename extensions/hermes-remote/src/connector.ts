import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { RemoteSession, ThreaClient, type ShutdownOptions } from "@threahq/remote-session"
import { WORK_DIR, type HermesRemoteConfig } from "./config"
import { HermesRunsClient, type FetchLike } from "./hermes-client"
import { HERMES_RUNTIME, HermesTurnRunner, type ConversationStore } from "./run-bridge"
import { createHermesSessionControl } from "./session-control"

/** `/clear` generations and thread forks, written through a temp file so a crash cannot truncate it. */
export function createFileConversationStore(path: string): ConversationStore {
  return {
    load: () => {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
        // A file without `generations` or `forked` is a legacy bare generation map.
        const legacy = !("generations" in parsed) && !("forked" in parsed)
        const raw = (legacy ? parsed : (parsed.generations ?? {})) as Record<string, unknown>
        const generations = Object.fromEntries(
          Object.entries(raw).flatMap(([key, value]) =>
            typeof value === "number" && Number.isFinite(value) ? [[key, value] as const] : []
          )
        )
        const forked = Array.isArray(parsed.forked)
          ? parsed.forked.flatMap((entry) => (typeof entry === "string" && entry.length > 0 ? [entry] : []))
          : []
        return { generations, forked }
      } catch {
        return { generations: {}, forked: [] }
      }
    },
    save: (state) => {
      const tmp = `${path}.tmp`
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, path)
    },
  }
}

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
      requestDecision: (input, opts) => session.requestDecision(input, opts),
    },
    // Long-term memory scope (X-Hermes-Session-Key): one per stream tree, so a
    // channel mention never reads the scratchpad's memory. The conversation itself
    // is selected by session_id, the stream the turn arrived on.
    sessionKeyFor: (rootStreamId) => `threa:${config.workspaceId}:${rootStreamId}`,
    conversationStore: createFileConversationStore(join(WORK_DIR, "conversations.json")),
    log,
  })

  const sessionControl = createHermesSessionControl(runner, hermes, log)

  session = new RemoteSession({
    config,
    client,
    delegate: { deliverTurn: (turn) => runner.deliverTurn(turn), sessionControl },
    runtime: HERMES_RUNTIME,
    log,
  })

  return {
    session,
    start: async () => {
      await sessionControl.refresh()
      await session.start()
    },
    shutdown: async (shutdownOptions?: ShutdownOptions) => {
      runner.shutdown()
      await session.shutdown(shutdownOptions)
    },
  }
}
