import { readFileSync } from "node:fs"
import { join } from "node:path"
import { RemoteSession, ThreaClient, writeFileAtomic, type ShutdownOptions } from "@threahq/remote-session"
import type { HermesRemoteConfig } from "./config"
import { HermesRunsClient, type FetchLike } from "./hermes-client"
import { HERMES_RUNTIME, HermesTurnRunner, type ConversationStore } from "./run-bridge"
import { createHermesSessionControl } from "./session-control"

/** `/clear` generations, thread forks and `/model` locks, swapped in whole so a crash cannot truncate it. */
export function createFileConversationStore(path: string): ConversationStore {
  return {
    load: () => {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
        const generations = Object.fromEntries(
          Object.entries((parsed.generations ?? {}) as Record<string, unknown>).flatMap(([key, value]) =>
            typeof value === "number" && Number.isFinite(value) ? [[key, value] as const] : []
          )
        )
        const forked = Array.isArray(parsed.forked)
          ? parsed.forked.flatMap((entry) => (typeof entry === "string" && entry.length > 0 ? [entry] : []))
          : []
        const models = Object.fromEntries(
          Object.entries((parsed.models ?? {}) as Record<string, unknown>).flatMap(([key, value]) => {
            const { provider, model } = (value ?? {}) as { provider?: unknown; model?: unknown }
            return typeof provider === "string" && typeof model === "string"
              ? [[key, { provider, model }] as const]
              : []
          })
        )
        return { generations, forked, models }
      } catch {
        return { generations: {}, forked: [], models: {} }
      }
    },
    save: (state) => writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`),
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
    // X-Hermes-Session-Key scopes an external memory provider and the prompt cache
    // per stream tree. Built-in memory (MEMORY.md, USER.md) is profile-wide and
    // ignores it. The conversation itself is selected by session_id.
    sessionKeyFor: (rootStreamId) => `threa:${config.workspaceId}:${rootStreamId}`,
    conversationStore: createFileConversationStore(join(config.install.workDir, "conversations.json")),
    // The session control is constructed below; a fork only happens once a turn runs.
    onForked: (sourceId, forkId) => sessionControl.inheritModel(sourceId, forkId),
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
