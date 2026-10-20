import { describe, expect, test } from "bun:test"
import { T3AuthError } from "./auth"
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
    await control.loadOptions()
    expect(control.modelSuggestions?.map((suggestion) => suggestion.value)).toEqual([
      "codex::gpt-5.5",
      "codex::gpt-5.5-mini",
      "claudeAgent::claude-opus-5-5",
    ])
  })

  test("a rejected token rejects the load and leaves the picker empty", async () => {
    const { t3, control } = setup()
    t3.failNext("orchestrator_capabilities", new T3AuthError("T3 Code rejected the saved token"))

    await expect(control.loadOptions()).rejects.toThrow("T3 Code rejected the saved token")
    expect(control.modelSuggestions).toEqual([])
  })

  test("/status lists the thread, its model and the T3 server as markdown bullets", async () => {
    const { control } = setup({ threads: { stream_root: "thread_a" } })

    expect(await control.runCommand("status", "", CONTEXT)).toEqual({
      ok: true,
      message: [
        "- Thread: Fake thread (`thread_a`, idle)",
        "- Model: `codex::gpt-5.5`",
        "- No run is open.",
        "- T3 Code: http://t3.test",
      ].join("\n"),
    })
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
          "Set the model to claudeAgent::claude-opus-5-5 for new threads, but `thread_a` keeps its own: thread is running",
      },
    })
  })

  test("/model with an ambiguous name changes nothing", async () => {
    const { t3, saved, control } = setup({ threads: { stream_root: "thread_a" } })

    const result = await control.runCommand("model", "gpt", CONTEXT)

    expect(result).toEqual({ ok: false, message: '"gpt" matches several models: codex::gpt-5.5, codex::gpt-5.5-mini' })
    expect({ configured: t3.callsOf("t3_thread_configure"), saved }).toEqual({ configured: [], saved: [] })
  })

  test("/thinking sets the level on the scratchpad's thread and the next launch", async () => {
    const { t3, saved, control } = setup({
      threads: { stream_root: "thread_a" },
      model: { instanceId: "codex", model: "gpt-5.5" },
    })
    await control.loadOptions()

    const levels = control.thinkingLevels
    const result = await control.runCommand("thinking", "HIGH", CONTEXT)

    const selection = { instanceId: "codex", model: "gpt-5.5", options: [{ id: "reasoningEffort", value: "high" }] }
    expect({ levels, configured: t3.callsOf("t3_thread_configure"), model: saved.at(-1)?.model, result }).toEqual({
      levels: ["low", "medium", "high", "xhigh"],
      configured: [{ threadId: "thread_a", modelSelection: selection }],
      model: selection,
      result: { ok: true, summary: "Set thinking to high" },
    })
  })

  test.each([
    [undefined, "nope", "Pick a model with /model first."],
    [{ instanceId: "codex", model: "gpt-5.5-mini" }, "high", "codex::gpt-5.5-mini has no thinking levels."],
    [{ instanceId: "codex", model: "gpt-5.5" }, "max", "codex::gpt-5.5 thinks at one of: low, medium, high, xhigh."],
  ])("/thinking on %p with %p changes nothing", async (model, arg, message) => {
    const { t3, saved, control } = setup({ threads: { stream_root: "thread_a" }, ...(model ? { model } : {}) })

    const result = await control.runCommand("thinking", arg, CONTEXT)

    expect({ result, configured: t3.callsOf("t3_thread_configure"), saved }).toEqual({
      result: { ok: false, message },
      configured: [],
      saved: [],
    })
  })

  test.each([
    ["high", [{ id: "effort", value: "high" }]],
    ["xhigh", undefined],
  ])("/model keeps thinking %p only where the new model offers it", async (level, options) => {
    const { saved, control } = setup({
      threads: {},
      model: { instanceId: "codex", model: "gpt-5.5", options: [{ id: "reasoningEffort", value: level }] },
    })

    await control.runCommand("model", "opus", CONTEXT)

    expect(saved.at(-1)?.model).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      ...(options ? { options } : {}),
    })
    expect(control.thinkingLevels).toEqual(["low", "medium", "high", "max"])
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
    const { t3, fake, runner, control } = setup({ threads: {}, model: { instanceId: "codex", model: "gpt-5.5" } })
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
