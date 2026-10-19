import { describe, expect, test } from "bun:test"
import { T3TurnRunner, type ThreadState } from "./run-bridge"
import { createT3SessionControl, matchModel } from "./session-control"
import { fakeSession, fakeT3, item, turn } from "./t3.test-support"

const CONTEXT = { rootStreamId: "stream_root" } as Parameters<
  ReturnType<typeof createT3SessionControl>["runCommand"]
>[2]

function setup(state: ThreadState = { threads: {} }) {
  const t3 = fakeT3()
  const saved: ThreadState[] = []
  const fake = fakeSession()
  const runner = new T3TurnRunner({
    client: t3.client,
    session: fake.session,
    access: "full-access",
    traceMode: "commands",
    sealedFullTrace: false,
    threadStore: { load: () => state, save: (next) => saved.push(next) },
    sleep: async () => {},
  })
  return { t3, saved, fake, runner, control: createT3SessionControl(runner, t3.client) }
}

const CHOICES = [
  { instanceId: "codex", model: "gpt-5.5" },
  { instanceId: "codex", model: "gpt-5.5-mini" },
  { instanceId: "claudeAgent", model: "claude-opus-5-5" },
  { instanceId: "opencode", model: "claude-opus-5-5" },
]

describe("matchModel", () => {
  test.each([
    ["codex::gpt-5.5", ["codex::gpt-5.5"]],
    ["gpt-5.5", ["codex::gpt-5.5"]],
    ["claude-opus-5-5", ["claudeAgent::claude-opus-5-5", "opencode::claude-opus-5-5"]],
    ["MINI", ["codex::gpt-5.5-mini"]],
    ["  ", []],
  ])("%p", (arg, expected) => {
    expect(matchModel(CHOICES, arg).map((choice) => `${choice.instanceId}::${choice.model}`)).toEqual(expected)
  })
})

describe("T3 session control", () => {
  test("loads model suggestions from the orchestrator", async () => {
    const { control } = setup()
    await control.refresh()
    expect(control.modelSuggestions?.map((suggestion) => suggestion.value)).toEqual([
      "codex::gpt-5.5",
      "codex::gpt-5.5-mini",
      "claudeAgent::claude-opus-5-5",
    ])
  })

  test("/model moves the scratchpad's thread and the next launch to the model", async () => {
    const { t3, saved, control } = setup({ threads: { stream_root: "thread_a", stream_thread: "thread_b" } })

    const result = await control.runCommand("model", "opus", CONTEXT)

    expect({ configured: t3.callsOf("t3_thread_configure"), model: saved.at(-1)?.model, result }).toEqual({
      configured: [{ threadId: "thread_a", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } }],
      model: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      result: { ok: true, summary: "Set the model to claudeAgent::claude-opus-5-5" },
    })
  })

  test("/model a running thread refuses still moves the next launch", async () => {
    const { t3, saved, control } = setup({ threads: { stream_root: "thread_a" } })
    t3.failNext("t3_thread_configure", new Error("thread is running"))

    const result = await control.runCommand("model", "opus", CONTEXT)

    expect({ model: saved.at(-1)?.model, result }).toEqual({
      model: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      result: {
        ok: true,
        message:
          "New threads launch on claudeAgent::claude-opus-5-5, but `thread_a` keeps its model: thread is running",
      },
    })
  })

  test("/model with an ambiguous name changes nothing", async () => {
    const { t3, saved, control } = setup({ threads: { stream_root: "thread_a" } })

    const result = await control.runCommand("model", "gpt", CONTEXT)

    expect(result).toEqual({ ok: false, message: '"gpt" matches several models: codex::gpt-5.5, codex::gpt-5.5-mini' })
    expect({ configured: t3.callsOf("t3_thread_configure"), saved }).toEqual({ configured: [], saved: [] })
  })

  test("/clear forgets the scratchpad's thread, but not while a turn runs", async () => {
    const { t3, saved, runner, control } = setup({ threads: { stream_root: "thread_a", stream_thread: "thread_b" } })
    t3.script("run_1", [{ status: "running" }])
    await runner.deliverTurn(turn())

    expect(await control.runCommand("clear", "", CONTEXT)).toEqual({
      ok: false,
      message: "Stop the running turn first (/stop).",
    })
    runner.interrupt()
    expect(await control.runCommand("clear", "", CONTEXT)).toEqual({
      ok: true,
      summary: "Started a new T3 Code thread",
    })
    expect(saved.at(-1)).toEqual({ threads: { stream_thread: "thread_b" } })
  })

  test("/clear right after the reply is not refused", async () => {
    const { t3, fake, runner, control } = setup()
    const reply = fake.session.reply
    let cleared: unknown
    fake.session.reply = async (invocationId, text) => {
      cleared = await control.runCommand("clear", "", CONTEXT)
      return reply(invocationId, text)
    }
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "Done" })] }])

    await runner.deliverTurn(turn())
    await fake.settled()

    expect(cleared).toEqual({ ok: true, summary: "Started a new T3 Code thread" })
  })
})
