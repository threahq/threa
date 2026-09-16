import { describe, expect, test } from "bun:test"
import type { SessionControlInvocationContext } from "@threahq/remote-session"
import { HermesApiError, type HermesRunsClient, type ModelOptions } from "./hermes-client"
import type { HermesTurnRunner } from "./run-bridge"
import { createHermesSessionControl, matchModel } from "./session-control"

const CONTEXT: SessionControlInvocationContext = { rootStreamId: "stream_root", sourceMessageId: "msg_1" }

const OPTIONS: ModelOptions = {
  provider: "openrouter",
  model: "hermes-4",
  providers: [
    { slug: "openrouter", name: "OpenRouter", models: ["hermes-4", "glm-4.6"] },
    { slug: "local", name: "Local vLLM", models: ["hermes-4"] },
  ],
}

function makeRunner(open: Array<{ runId: string; streamId: string }> = []) {
  const bumps: string[] = []
  let generation = 0
  const runner = {
    conversationFor: (streamId: string) => (generation === 0 ? streamId : `${streamId}.${generation}`),
    bumpConversation: (streamId: string) => {
      bumps.push(streamId)
      generation += 1
      return `${streamId}.${generation}`
    },
    openRuns: () => open.map((run, index) => ({ invocationId: `binv_${index}`, ...run })),
    hasOpenRunOn: (streamId: string) => open.some((run) => run.streamId === streamId),
    steer: async () => true,
    interrupt: () => true,
  }
  return { runner: runner as unknown as HermesTurnRunner, bumps }
}

function makeClient(overrides: Partial<Record<string, unknown>> = {}) {
  const created: string[] = []
  const locks: Array<{ id: string; provider: string; model: string }> = []
  const client = {
    baseUrl: "http://127.0.0.1:8642",
    getRun: async (runId: string) => ({ runId, status: "running" }),
    listModelOptions: async () => OPTIONS,
    createSession: async (id: string) => {
      created.push(id)
    },
    lockSessionModel: async (id: string, runtime: { provider: string; model: string }) => {
      locks.push({ id, ...runtime })
      return { sessionId: id, ...runtime }
    },
    ...overrides,
  }
  return { client: client as unknown as HermesRunsClient, created, locks }
}

describe("matchModel", () => {
  test("resolves exact pairs, unique model ids, substrings, and reports ambiguity", () => {
    const choices = [
      { provider: "openrouter", model: "hermes-4" },
      { provider: "openrouter", model: "glm-4.6" },
      { provider: "local", model: "hermes-4" },
    ]
    expect({
      pair: matchModel(choices, "local::hermes-4"),
      unique: matchModel(choices, "glm-4.6"),
      substring: matchModel(choices, "GLM"),
      ambiguous: matchModel(choices, "hermes-4").length,
      unknown: matchModel(choices, "sonnet"),
    }).toEqual({
      pair: [{ provider: "local", model: "hermes-4" }],
      unique: [{ provider: "openrouter", model: "glm-4.6" }],
      substring: [{ provider: "openrouter", model: "glm-4.6" }],
      ambiguous: 2,
      unknown: [],
    })
  })
})

describe("createHermesSessionControl", () => {
  test("advertises the catalog command names", () => {
    const { runner } = makeRunner()
    expect(createHermesSessionControl(runner, makeClient().client).commands).toEqual([
      "stop",
      "steer",
      "status",
      "model",
      "clear",
    ])
  })

  test("refresh loads the model suggestions from the options payload", async () => {
    const { runner } = makeRunner()
    const control = createHermesSessionControl(runner, makeClient().client)
    await control.refresh()
    expect(control.modelSuggestions).toEqual([
      { value: "openrouter::hermes-4", label: "hermes-4", description: "OpenRouter" },
      { value: "openrouter::glm-4.6", label: "glm-4.6", description: "OpenRouter" },
      { value: "local::hermes-4", label: "hermes-4", description: "Local vLLM" },
    ])
  })

  test("an options fetch failure leaves the suggestions empty and logs", async () => {
    const { runner } = makeRunner()
    const logs: string[] = []
    const { client } = makeClient({
      listModelOptions: async () => {
        throw new Error("connect ECONNREFUSED")
      },
    })
    const control = createHermesSessionControl(runner, client, (message) => logs.push(message))
    await control.refresh()
    expect({ suggestions: control.modelSuggestions, logs }).toEqual({
      suggestions: [],
      logs: ["model options unavailable, /model will suggest nothing: connect ECONNREFUSED"],
    })
  })

  test("status names the conversation, each open run with its status, and the gateway", async () => {
    const { runner } = makeRunner([{ runId: "run_1", streamId: "stream_root" }])
    const control = createHermesSessionControl(runner, makeClient().client)
    expect(await control.runCommand("status", "", CONTEXT)).toEqual({
      ok: true,
      message: "Conversation: `stream_root`\nRun `run_1` (running)\nGateway: http://127.0.0.1:8642",
    })
  })

  test("status says so when no run is open", async () => {
    const { runner } = makeRunner()
    const control = createHermesSessionControl(runner, makeClient().client)
    const result = await control.runCommand("status", "", CONTEXT)
    expect(result.message?.includes("No run is open.")).toBe(true)
  })

  test("model creates the session, locks the runtime and remembers it for status", async () => {
    const { runner } = makeRunner()
    const { client, created, locks } = makeClient()
    const control = createHermesSessionControl(runner, client)

    const result = await control.runCommand("model", "local::hermes-4", CONTEXT)
    const status = await control.runCommand("status", "", CONTEXT)

    expect({ result, created, locks, model: status.message?.includes("Model: `local::hermes-4`") }).toEqual({
      result: { ok: true, summary: "Set the model to local::hermes-4" },
      created: ["stream_root"],
      locks: [{ id: "stream_root", provider: "local", model: "hermes-4" }],
      model: true,
    })
  })

  test("a session that already exists is not a failure", async () => {
    const { runner } = makeRunner()
    const { client, locks } = makeClient({
      createSession: async () => {
        throw new HermesApiError("Session already exists", { status: 409, code: "session_exists" })
      },
    })
    const control = createHermesSessionControl(runner, client)
    expect(await control.runCommand("model", "glm", CONTEXT)).toEqual({
      ok: true,
      summary: "Set the model to openrouter::glm-4.6",
    })
    expect(locks).toEqual([{ id: "stream_root", provider: "openrouter", model: "glm-4.6" }])
  })

  test("an ambiguous model lists its candidates and changes nothing", async () => {
    const { runner } = makeRunner()
    const { client, locks } = makeClient()
    const control = createHermesSessionControl(runner, client)
    expect({ result: await control.runCommand("model", "hermes-4", CONTEXT), locks }).toEqual({
      result: {
        ok: false,
        message: '"hermes-4" matches several models: openrouter::hermes-4, local::hermes-4',
      },
      locks: [],
    })
  })

  test("an unknown model is refused", async () => {
    const { runner } = makeRunner()
    const { client, locks } = makeClient()
    const control = createHermesSessionControl(runner, client)
    expect({ result: await control.runCommand("model", "sonnet", CONTEXT), locks }).toEqual({
      result: { ok: false, message: 'No model matches "sonnet".' },
      locks: [],
    })
  })

  test("clear is refused while a run is open on the root stream", async () => {
    const { runner, bumps } = makeRunner([{ runId: "run_1", streamId: "stream_root" }])
    const control = createHermesSessionControl(runner, makeClient().client)
    expect({ result: await control.runCommand("clear", "", CONTEXT), bumps }).toEqual({
      result: { ok: false, message: "Stop the running turn first (/stop)." },
      bumps: [],
    })
  })

  test("clear drops the model lock, which belonged to the old conversation", async () => {
    const { runner } = makeRunner()
    const control = createHermesSessionControl(runner, makeClient().client)
    await control.runCommand("model", "local::hermes-4", CONTEXT)
    await control.runCommand("clear", "", CONTEXT)
    const status = await control.runCommand("status", "", CONTEXT)
    expect(status.message?.includes("Model:")).toBe(false)
  })

  test("clear bumps the conversation generation", async () => {
    const { runner, bumps } = makeRunner()
    const control = createHermesSessionControl(runner, makeClient().client)
    const result = await control.runCommand("clear", "--force", CONTEXT)
    const status = await control.runCommand("status", "", CONTEXT)
    expect({ result, bumps, conversation: status.message?.includes("`stream_root.1`") }).toEqual({
      result: { ok: true, summary: "Started a new conversation" },
      bumps: ["stream_root"],
      conversation: true,
    })
  })

  test("a command the connector does not implement is refused", async () => {
    const { runner } = makeRunner()
    const control = createHermesSessionControl(runner, makeClient().client)
    expect(await control.runCommand("compact", "", CONTEXT)).toEqual({
      ok: false,
      message: "The Hermes connector does not run /compact.",
    })
  })
})
