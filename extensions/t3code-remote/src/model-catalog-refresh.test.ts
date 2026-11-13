import { afterEach, expect, jest, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RemoteSession, ThreaClient } from "@threahq/remote-session"
import { T3CODE_RUNTIME, T3TurnRunner } from "./run-bridge"
import { createT3SessionControl } from "./session-control"
import { fakeSession, fakeT3, fakeTransport, sessionConfig } from "./t3.test-support"

const REFRESH_MS = 2 * 60 * 1000
const RETRY_MS = 2_000
const BOOT_MODELS = ["codex::gpt-5.5", "codex::gpt-5.5-mini", "claudeAgent::claude-opus-5-5"]

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  jest.useRealTimers()
})

async function flush(): Promise<void> {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}

/** The connector as it runs: the SDK session advertising the T3 session control, against a fake T3 and Threa. */
async function startConnector() {
  jest.useFakeTimers()
  const t3 = fakeT3()
  const runner = new T3TurnRunner({
    client: t3.client,
    session: fakeSession().session,
    access: "full-access",
    traceMode: "commands",
    sealedFullTrace: false,
    threadStore: { load: () => ({ threads: {} }), save: () => {} },
    sleep: async () => {},
  })
  const control = createT3SessionControl(runner, t3.client, {
    threa: { baseUrl: "https://threa.example", apiKey: "bot_key" },
    spawnRuntimes: () => [],
    brief: async () => {},
  })
  const published: string[][] = []
  const transport = fakeTransport({
    updatePresence: async (body: { capabilities: { modelSuggestions?: Array<{ value: string }> } }) => {
      published.push((body.capabilities.modelSuggestions ?? []).map((suggestion) => suggestion.value))
    },
  })
  const client = {
    getMe: async () => ({ kind: "bot" }),
    createSession: async () => ({
      linkId: "brsl_1",
      rootStreamId: "stream_root",
      activeStreamId: "stream_root",
      runtimeSessionId: "rts_test",
      streamUrlPath: "/w/ws_test/s/stream_root",
    }),
    claim: async () => null,
    getStream: async () => ({ e2eEnabled: false, archivedAt: null }),
  } as unknown as ThreaClient
  const keyDir = mkdtempSync(join(tmpdir(), "t3-model-refresh-"))
  const logs: string[] = []
  const session = new RemoteSession({
    config: sessionConfig({ keyStore: "file", keyDir }),
    client,
    transport,
    runtime: T3CODE_RUNTIME,
    delegate: { deliverTurn: async () => {}, sessionControl: control },
    log: (message) => logs.push(message),
  })
  cleanups.push(
    () => session.shutdown(),
    () => rmSync(keyDir, { recursive: true, force: true })
  )
  await session.start()
  await flush()
  const tick = async (ms: number) => {
    jest.advanceTimersByTime(ms)
    await flush()
  }
  return { t3, control, published, logs, tick }
}

test("a model T3 starts offering reaches the picker on the next refresh, without a restart", async () => {
  const connector = await startConnector()
  const atStart = [...connector.published]

  connector.t3.addModel("claudeAgent", { id: "claude-fable-5-2", label: "Claude Fable 5.2" })
  await connector.tick(REFRESH_MS)

  expect({ atStart, afterRefresh: connector.published.slice(atStart.length) }).toEqual({
    atStart: [BOOT_MODELS],
    afterRefresh: [[...BOOT_MODELS, "claudeAgent::claude-fable-5-2"]],
  })
})

test("while T3 is unreachable the picker keeps the models it last loaded, then catches up and keeps refreshing", async () => {
  const connector = await startConnector()
  const atStart = [...connector.published]

  connector.t3.addModel("claudeAgent", { id: "claude-fable-5-2" })
  connector.t3.failNext("orchestrator_capabilities", new Error("connect ECONNREFUSED 127.0.0.1:3773"))
  await connector.tick(REFRESH_MS)
  const whileDown = {
    published: connector.published.slice(atStart.length),
    suggestions: connector.control.modelSuggestions?.map((suggestion) => suggestion.value),
    logs: connector.logs.filter((line) => line.startsWith("session-control")),
  }

  await connector.tick(RETRY_MS)
  const afterRetry = connector.published.slice(atStart.length)

  connector.t3.addModel("codex", { id: "gpt-6.1-sol" })
  await connector.tick(REFRESH_MS)

  expect({ atStart, whileDown, afterRetry, nextRefresh: connector.published.at(-1) }).toEqual({
    atStart: [BOOT_MODELS],
    whileDown: {
      published: [],
      suggestions: BOOT_MODELS,
      logs: ["session-control options unavailable, retrying in 2000ms: connect ECONNREFUSED 127.0.0.1:3773"],
    },
    afterRetry: [[...BOOT_MODELS, "claudeAgent::claude-fable-5-2"]],
    nextRefresh: [
      "codex::gpt-5.5",
      "codex::gpt-5.5-mini",
      "codex::gpt-6.1-sol",
      "claudeAgent::claude-opus-5-5",
      "claudeAgent::claude-fable-5-2",
    ],
  })
})
