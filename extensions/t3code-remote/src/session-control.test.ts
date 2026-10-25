import { describe, expect, test } from "bun:test"
import { T3AuthError } from "./auth"
import { T3TurnRunner, type ThreadState } from "./run-bridge"
import { createT3SessionControl, matchModel } from "./session-control"
import { fakeSession, fakeT3, item, turn, until } from "./t3.test-support"

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

  test("/status lists the thread, its model, the access and the T3 server as markdown bullets", async () => {
    const { control } = setup({ threads: { stream_root: "thread_a" } })

    expect(await control.runCommand("status", "", CONTEXT)).toEqual({
      ok: true,
      message: [
        "- Thread: Fake thread (`thread_a`, idle)",
        "- Model: `codex::gpt-5.5`",
        "- Access: full-access",
        "- No run is open.",
        "- T3 Code: http://t3.test",
      ].join("\n"),
    })
  })

  test("/status shows the thinking level and the questions an open run waits on", async () => {
    const thinking = { instanceId: "codex", model: "gpt-5.5", options: [{ id: "reasoningEffort", value: "high" }] }
    const { t3, runner, control } = setup({ threads: {}, model: thinking })
    t3.script("run_1", [{ status: "waiting", items: [item(1, "user_input_request", { status: "pending" })] }])
    await runner.deliverTurn(turn())
    await until(() => runner.openRuns()[0]?.trace.questions.size === 1)

    expect(await control.runCommand("status", "", CONTEXT)).toEqual({
      ok: true,
      message: [
        "- Thread: Fake thread (`thread_1`, idle)",
        "- Model: `codex::gpt-5.5`, thinking high",
        "- Access: full-access",
        "- Open runs: `run_1` (waiting on 1 answer)",
        "- New threads launch on `codex::gpt-5.5`, thinking high",
        "- T3 Code: http://t3.test",
      ].join("\n"),
    })
    runner.interrupt()
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
    const codex = { instanceId: "codex", model: "gpt-5.5" }
    const { t3, saved, control } = setup({ threads: { stream_root: "thread_a" }, model: codex })
    t3.threadModel("thread_a", codex)
    await control.loadOptions()

    const levels = control.thinkingLevels
    const result = await control.runCommand("thinking", "HIGH", CONTEXT)

    const selection = { ...codex, options: [{ id: "reasoningEffort", value: "high" }] }
    expect({ levels, configured: t3.callsOf("t3_thread_configure"), model: saved.at(-1)?.model, result }).toEqual({
      levels: ["low", "medium", "high", "xhigh"],
      configured: [{ threadId: "thread_a", modelSelection: selection }],
      model: selection,
      result: { ok: true, summary: "Set thinking to high" },
    })
  })

  test("/thinking keeps the thread's other options, like Claude's context window", async () => {
    const opus = { instanceId: "claudeAgent", model: "claude-opus-5-5" }
    const { t3, saved, control } = setup({ threads: { stream_root: "thread_a" }, model: opus })
    t3.threadModel("thread_a", {
      ...opus,
      options: [
        { id: "contextWindow", value: "1m" },
        { id: "effort", value: "low" },
      ],
    })

    await control.runCommand("thinking", "max", CONTEXT)

    expect({ configured: t3.callsOf("t3_thread_configure"), model: saved.at(-1)?.model }).toEqual({
      configured: [
        {
          threadId: "thread_a",
          modelSelection: {
            ...opus,
            options: [
              { id: "contextWindow", value: "1m" },
              { id: "effort", value: "max" },
            ],
          },
        },
      ],
      model: { ...opus, options: [{ id: "effort", value: "max" }] },
    })
  })

  test("/thinking keeps a thread switched to another model on that model", async () => {
    const { t3, saved, control } = setup({
      threads: { stream_root: "thread_a" },
      model: { instanceId: "codex", model: "gpt-5.5" },
    })
    const opus = {
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "contextWindow", value: "1m" }],
    }
    t3.threadModel("thread_a", opus)

    const result = await control.runCommand("thinking", "high", CONTEXT)

    expect({ result, configured: t3.callsOf("t3_thread_configure"), model: saved.at(-1)?.model }).toEqual({
      result: { ok: true, summary: "Set thinking to high" },
      configured: [
        {
          threadId: "thread_a",
          modelSelection: { ...opus, options: [...opus.options, { id: "effort", value: "high" }] },
        },
      ],
      model: { instanceId: "codex", model: "gpt-5.5", options: [{ id: "reasoningEffort", value: "high" }] },
    })
  })

  test("/thinking leaves a thread whose model lacks the level alone", async () => {
    const { t3, saved, control } = setup({
      threads: { stream_root: "thread_a" },
      model: { instanceId: "codex", model: "gpt-5.5" },
    })
    t3.threadModel("thread_a", { instanceId: "codex", model: "gpt-5.5-mini" })

    const result = await control.runCommand("thinking", "high", CONTEXT)

    expect({ result, configured: t3.callsOf("t3_thread_configure"), model: saved.at(-1)?.model }).toEqual({
      result: {
        ok: true,
        message:
          "Set thinking to high for new threads, but `thread_a` runs codex::gpt-5.5-mini, which doesn't offer it.",
      },
      configured: [],
      model: { instanceId: "codex", model: "gpt-5.5", options: [{ id: "reasoningEffort", value: "high" }] },
    })
  })

  test("/thinking with no thread yet sets only the next launch", async () => {
    const { t3, saved, control } = setup({ threads: {}, model: { instanceId: "codex", model: "gpt-5.5" } })

    const result = await control.runCommand("thinking", "low", CONTEXT)

    expect({ result, configured: t3.callsOf("t3_thread_configure"), model: saved.at(-1)?.model }).toEqual({
      result: { ok: true, summary: "Set thinking to low" },
      configured: [],
      model: { instanceId: "codex", model: "gpt-5.5", options: [{ id: "reasoningEffort", value: "low" }] },
    })
  })

  test("/thinking a running thread refuses still sets the next launch", async () => {
    const codex = { instanceId: "codex", model: "gpt-5.5" }
    const { t3, saved, control } = setup({ threads: { stream_root: "thread_a" }, model: codex })
    t3.threadModel("thread_a", codex)
    t3.failNext("t3_thread_configure", new Error("thread is running"))

    const result = await control.runCommand("thinking", "high", CONTEXT)

    expect({ result, model: saved.at(-1)?.model }).toEqual({
      result: {
        ok: true,
        message: "Set thinking to high for new threads, but `thread_a` keeps its own: thread is running",
      },
      model: { ...codex, options: [{ id: "reasoningEffort", value: "high" }] },
    })
  })

  test.each(["model", "thinking"])("/%s changes nothing when the T3 models can't be read", async (command) => {
    const { t3, saved, control } = setup({
      threads: { stream_root: "thread_a" },
      model: { instanceId: "codex", model: "gpt-5.5" },
    })
    t3.failNext("orchestrator_capabilities", new Error("connection refused"))

    const result = await control.runCommand(command, "high", CONTEXT)

    expect({ result, configured: t3.callsOf("t3_thread_configure"), saved }).toEqual({
      result: { ok: false, message: "Could not read the T3 Code models: connection refused" },
      configured: [],
      saved: [],
    })
  })

  test("/thinking changes nothing when the thread's model can't be read", async () => {
    const { t3, saved, control } = setup({
      threads: { stream_root: "thread_a" },
      model: { instanceId: "codex", model: "gpt-5.5" },
    })
    t3.failNext("t3_thread_configuration", new Error("thread not found"))

    const result = await control.runCommand("thinking", "high", CONTEXT)

    expect({ result, configured: t3.callsOf("t3_thread_configure"), saved }).toEqual({
      result: { ok: false, message: "Could not read `thread_a`'s model: thread not found" },
      configured: [],
      saved: [],
    })
  })

  test.each([
    { $case: "no model", model: undefined, arg: "nope", message: "Pick a model with /model first." },
    {
      $case: "a model without levels",
      model: { instanceId: "codex", model: "gpt-5.5-mini" },
      arg: "high",
      message: "codex::gpt-5.5-mini has no thinking levels.",
    },
    {
      $case: "a level the model lacks",
      model: { instanceId: "codex", model: "gpt-5.5" },
      arg: "max",
      message: "codex::gpt-5.5 thinks at one of: low, medium, high, xhigh.",
    },
  ])("/thinking with $case changes nothing", async ({ model, arg, message }) => {
    const { t3, saved, control } = setup({ threads: { stream_root: "thread_a" }, ...(model ? { model } : {}) })

    const result = await control.runCommand("thinking", arg, CONTEXT)

    expect({ result, configured: t3.callsOf("t3_thread_configure"), saved }).toEqual({
      result: { ok: false, message },
      configured: [],
      saved: [],
    })
  })

  test.each([
    ["high", { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] }],
    ["xhigh", { instanceId: "claudeAgent", model: "claude-opus-5-5" }],
  ])("/model keeps thinking %p only where the new model offers it", async (level, expected) => {
    const { saved, control } = setup({
      threads: {},
      model: { instanceId: "codex", model: "gpt-5.5", options: [{ id: "reasoningEffort", value: level }] },
    })

    await control.runCommand("model", "opus", CONTEXT)

    expect({ model: saved.at(-1)?.model, levels: control.thinkingLevels }).toEqual({
      model: expected,
      levels: ["low", "medium", "high", "max"],
    })
  })

  test("/compact queues T3's own compaction on the scratchpad's thread", async () => {
    const { t3, control } = setup({ threads: { stream_root: "thread_a" } })

    expect(await control.runCommand("compact", "", CONTEXT)).toEqual({
      ok: true,
      summary: "Queued a compaction of the T3 Code thread",
    })
    expect(t3.callsOf("t3_thread_send")).toEqual([{ threadId: "thread_a", message: "/compact", mode: "queue" }])
  })

  test("/compact before the first message has nothing to compact", async () => {
    const { control } = setup()

    expect(await control.runCommand("compact", "", CONTEXT)).toEqual({
      ok: false,
      message: "No T3 Code thread to compact yet.",
    })
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
