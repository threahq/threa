import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  discardCommandClaim,
  discardSpawnBrief,
  readCommandClaim,
  type HarnessSpawnSpec,
  type SpawnRuntimeOption,
} from "@threahq/harness-client"
import { ThreaApiError } from "@threahq/remote-session"
import { T3AuthError } from "./auth"
import { T3TurnRunner, type ThreadState } from "./run-bridge"
import { createT3SessionControl, matchModel } from "./session-control"
import { fakeSession, fakeT3, item, turn, until } from "./t3.test-support"

const CONTEXT = { rootStreamId: "stream_root", streamId: "stream_root", sourceMessageId: "msg_spawn" }
const IN_THREAD = { ...CONTEXT, streamId: "stream_thread" }
const CLAIM = { workspaceId: "ws_1", invocationId: "binv_cmd", instanceId: "inst_1", claimToken: "claim_secret" }
const RUNTIMES: SpawnRuntimeOption[] = [
  { value: "claude", label: "Claude Code", installed: true, thinkingLevels: ["high"], models: [] },
  { value: "pi", label: "Pi", installed: false, thinkingLevels: [], models: [] },
]

function setup(state: ThreadState = { threads: {} }, runtimes: SpawnRuntimeOption[] = RUNTIMES) {
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
  const launched: Array<{ spec: HarnessSpawnSpec; claim: unknown; brief: string | undefined }> = []
  const briefs: unknown[] = []
  const briefFailures: Error[] = []
  const control = createT3SessionControl(runner, t3.client, {
    threa: { baseUrl: "https://threa.example", apiKey: "bot_key" },
    spawnRuntimes: () => runtimes,
    brief: async (input) => {
      const failure = briefFailures.shift()
      if (failure) throw failure
      briefs.push(input)
    },
    spawnLauncher: (spec) => () => {
      launched.push({
        spec,
        claim: readCommandClaim(spec.claimFile!),
        brief: spec.briefFile && readFileSync(spec.briefFile, "utf8"),
      })
      discardCommandClaim(spec.claimFile)
      discardSpawnBrief(spec.briefFile)
    },
  })
  return { t3, saved, fake, runner, control, launched, briefs, briefFailures }
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
    const { t3, control } = setup({ threads: { stream_root: "thread_a" } })
    t3.threadModel("thread_a", { instanceId: "claudeAgent", model: "claude-opus-5-5" })

    expect(await control.runCommand("status", "", CONTEXT)).toEqual({
      ok: true,
      message: [
        "- Thread: Fake thread (`thread_a`, idle)",
        "- Model: `claudeAgent::claude-opus-5-5`",
        "- Access: full-access",
        "- No run is open.",
        "- T3 Code: http://t3.test",
      ].join("\n"),
    })
  })

  test("/status in a thread shows that thread's own T3 thread", async () => {
    const { t3, control } = setup({ threads: { stream_root: "thread_a", stream_thread: "thread_b" } })

    const message = (await control.runCommand("status", "", IN_THREAD)).message ?? ""

    expect(message.split("\n")[0]).toBe("- Thread: Fake thread (`thread_b`, idle)")
    expect(t3.callsOf("t3_thread_read")).toEqual([{ threadId: "thread_b", limit: 1 }])
  })

  test("/status names the latest run of a running thread, and the thread when its model can't be read", async () => {
    const { t3, runner, control } = setup({ threads: {}, model: { instanceId: "codex", model: "gpt-5.5" } })
    t3.script("run_1", [{ status: "running" }])
    await runner.deliverTurn(turn())
    t3.failNext("t3_thread_configuration", new Error("busy"))

    expect(await control.runCommand("status", "", CONTEXT)).toEqual({
      ok: true,
      message: [
        "- Thread: Fake thread (`thread_1`, running, latest run `run_1`)",
        "- Model: unavailable (busy)",
        "- Open runs: `run_1`",
        "- New threads launch on `codex::gpt-5.5`",
        "- T3 Code: http://t3.test",
      ].join("\n"),
    })
    runner.interrupt()
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
        "- Thread: Fake thread (`thread_1`, waiting, latest run `run_1`)",
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
    expect(saved.at(-1)).toEqual({ threads: { stream_thread: "thread_b" }, delivered: {} })
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

  test("/compact and /clear typed in a thread act on that thread's own T3 thread", async () => {
    const { t3, saved, control } = setup({ threads: { stream_root: "thread_a", stream_thread: "thread_b" } })

    await control.runCommand("compact", "", IN_THREAD)
    await control.runCommand("clear", "", IN_THREAD)

    expect({ compacted: t3.callsOf("t3_thread_send"), threads: saved.at(-1)?.threads }).toEqual({
      compacted: [{ threadId: "thread_b", message: "/compact", mode: "queue" }],
      threads: { stream_root: "thread_a" },
    })
  })

  test("/spawn hands the command to harnessd with the bot's own Threa target", async () => {
    const { control, launched } = setup()

    const outcome = await control.runCommand("spawn", "claude /thinking high helper\nFix the flaky test", CONTEXT)
    await outcome.handoff?.(CLAIM)

    expect({ keepsRunning: outcome.handoffKeepsSessionRunning, launched }).toEqual({
      keepsRunning: true,
      launched: [
        {
          spec: {
            runtime: "claude",
            name: "helper",
            rootStreamId: "stream_root",
            anchorId: "msg_spawn",
            briefFile: expect.any(String),
            claimFile: expect.any(String),
            thinking: "high",
          },
          claim: { runtime: "t3code", baseUrl: "https://threa.example", apiKey: "bot_key", ...CLAIM },
          brief: "Fix the flaky test",
        },
      ],
    })
  })

  test("/spawn is refused inside a thread and for a runtime that isn't installed", async () => {
    const { control } = setup()

    expect(await control.runCommand("spawn", "helper", IN_THREAD)).toEqual({
      ok: false,
      message: "Spawn is only available at the scratchpad itself, not inside a thread.",
    })
    expect(await control.runCommand("spawn", "pi helper", CONTEXT)).toEqual({
      ok: false,
      message: "`pi` is not installed on this machine. Installed: t3code, claude.",
    })
  })

  test("advertises /spawn with T3 Code first, also without harnessd, and defaults to it", async () => {
    const withHarness = setup().control
    const without = setup(undefined, []).control
    await withHarness.loadOptions()

    expect({
      commands: without.commands,
      defaults: without.spawnDefaultRuntime,
      runtimes: [withHarness, without].map((control) => control.spawnRuntimes?.map((runtime) => runtime.value)),
      t3: withHarness.spawnRuntimes?.[0],
    }).toEqual({
      commands: ["stop", "status", "model", "thinking", "compact", "clear", "spawn", "done"],
      defaults: "t3code",
      runtimes: [["t3code", "claude"], ["t3code"]],
      t3: {
        value: "t3code",
        label: "T3 Code",
        thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
        models: withHarness.modelSuggestions ?? [],
      },
    })
  })

  test("/spawn t3code queues a fresh thread on the launch model and briefs it under the /spawn message", async () => {
    const { saved, control, briefs, launched } = setup({
      threads: {},
      model: { instanceId: "codex", model: "gpt-5.5" },
    })

    const outcome = await control.runCommand("spawn", "t3code helper bot\nFix the flaky test", CONTEXT)

    expect({ outcome, spawns: saved.at(-1)?.spawns, briefs, launched }).toEqual({
      outcome: { ok: true, summary: "Spawned helper bot in a new T3 Code thread" },
      spawns: { msg_spawn: { title: "helper bot", model: { instanceId: "codex", model: "gpt-5.5" } } },
      briefs: [{ content: "Fix the flaky test", thread: { anchorId: "msg_spawn", displayName: "helper bot" } }],
      launched: [],
    })
  })

  test("/spawn t3code launches on its /model at its /thinking, carried over like /model", async () => {
    const thinking = { instanceId: "codex", model: "gpt-5.5", options: [{ id: "reasoningEffort", value: "high" }] }
    const picks = [
      [
        "/model opus helper",
        { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] },
      ],
      [
        "/model opus /thinking MAX helper",
        { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "max" }] },
      ],
      ["/thinking low helper", { ...thinking, options: [{ id: "reasoningEffort", value: "low" }] }],
    ] as const
    const spawned: unknown[] = []
    for (const [args] of picks) {
      const { saved, control } = setup({ threads: {}, model: thinking })
      await control.runCommand("spawn", `t3code ${args}\nGo`, CONTEXT)
      spawned.push(saved.at(-1)?.spawns)
    }

    expect(spawned).toEqual(picks.map(([, model]) => ({ msg_spawn: { title: "helper", model } })))
  })

  test("/spawn t3code without a prompt, a model or a matching level changes nothing", async () => {
    const codex = { instanceId: "codex", model: "gpt-5.5-mini" }
    const cases = [
      [{ threads: {} }, "t3code helper\nGo", "T3 Code needs a model for new threads: pick one with /model."],
      [{ threads: {} }, "t3code /thinking high helper\nGo", "Pick a model with /model first."],
      [{ threads: {}, model: codex }, "t3code helper", "T3 Code needs a prompt to start the thread."],
      [
        { threads: {}, model: codex },
        "t3code /model gpt helper\nGo",
        '"gpt" matches several models: codex::gpt-5.5, codex::gpt-5.5-mini',
      ],
      [
        { threads: {}, model: codex },
        "t3code /thinking high helper\nGo",
        "codex::gpt-5.5-mini has no thinking levels.",
      ],
    ] as const
    const outcomes: unknown[] = []
    for (const [state, args] of cases) {
      const { saved, control, briefs } = setup(state)
      await control.loadOptions()
      outcomes.push({ result: await control.runCommand("spawn", args, CONTEXT), saved, briefs })
    }

    expect(outcomes).toEqual(cases.map(([, , message]) => ({ result: { ok: false, message }, saved: [], briefs: [] })))
  })

  test("/spawn t3code whose brief fails drops the pending spawn", async () => {
    const { saved, control, briefFailures } = setup({ threads: {}, model: { instanceId: "codex", model: "gpt-5.5" } })
    briefFailures.push(new ThreaApiError("Threa API 400 (BRIEF_ANCHOR_INVALID)", 400, "BRIEF_ANCHOR_INVALID"))

    const outcome = await control.runCommand("spawn", "t3code helper\nGo", CONTEXT)

    expect({ outcome, spawns: saved.map((state) => state.spawns) }).toEqual({
      outcome: { ok: false, message: "Could not start helper: Threa API 400 (BRIEF_ANCHOR_INVALID)" },
      spawns: [{ msg_spawn: { title: "helper", model: { instanceId: "codex", model: "gpt-5.5" } } }, {}],
    })
  })

  test("/spawn t3code whose brief may have been stored keeps the pending spawn", async () => {
    const pending = { msg_spawn: { title: "helper", model: { instanceId: "codex", model: "gpt-5.5" } } }
    const failures = [new ThreaApiError("Threa API 503", 503), new Error("The operation timed out.")]
    const outcomes: unknown[] = []
    for (const failure of failures) {
      const { saved, control, briefFailures } = setup({ threads: {}, model: { instanceId: "codex", model: "gpt-5.5" } })
      briefFailures.push(failure)
      outcomes.push({
        outcome: await control.runCommand("spawn", "t3code helper\nGo", CONTEXT),
        spawns: saved.map((state) => state.spawns),
      })
    }

    expect(outcomes).toEqual(
      failures.map((failure) => ({
        outcome: { ok: false, message: `Could not confirm helper started: ${failure.message}` },
        spawns: [pending],
      }))
    )
  })

  test("/done archives the thread's T3 thread and unlinks it", async () => {
    const { t3, saved, control } = setup({ threads: { stream_root: "thread_a", stream_thread: "thread_b" } })

    expect(await control.runCommand("done", "", IN_THREAD)).toEqual({
      ok: true,
      summary: "Archived the T3 Code thread `thread_b`",
    })
    expect({ archived: t3.callsOf("t3_thread_organize"), threads: saved.at(-1)?.threads }).toEqual({
      archived: [{ threadId: "thread_b", action: "archive" }],
      threads: { stream_root: "thread_a" },
    })
  })

  test("/done is refused on the scratchpad, while a turn runs, and when T3 refuses the archive", async () => {
    const { t3, saved, runner, control } = setup({ threads: { stream_root: "thread_a", stream_thread: "thread_b" } })
    t3.script("run_1", [{ status: "running" }])
    await runner.deliverTurn(turn({ streamId: "stream_thread" }))

    const onScratchpad = await control.runCommand("done", "", CONTEXT)
    const whileRunning = await control.runCommand("done", "", IN_THREAD)
    runner.interrupt()
    t3.failNext("t3_thread_organize", new Error("thread is busy"))
    const refused = await control.runCommand("done", "", IN_THREAD)

    expect({ onScratchpad, whileRunning, refused, threads: saved.at(-1)?.threads }).toEqual({
      onScratchpad: { ok: false, message: "/done is only available inside a thread." },
      whileRunning: { ok: false, message: "Stop the running turn first (/stop)." },
      refused: { ok: false, message: "Could not archive `thread_b`: thread is busy" },
      threads: { stream_root: "thread_a", stream_thread: "thread_b" },
    })
  })

  test("/done is refused while T3 runs a turn it started itself in the thread", async () => {
    const { t3, fake, saved, runner, control } = setup({
      threads: { stream_root: "thread_a", stream_thread: "thread_b" },
    })
    t3.script("run_1", [{ status: "completed" }])
    await runner.deliverTurn(turn({ streamId: "stream_thread" }))
    await fake.settled()
    await runner.watch()
    t3.startInT3("thread_b")
    t3.script("run_2", [{ status: "running" }])
    await runner.watch()
    await until(() => runner.isRelaying("stream_thread"))

    const whileRelaying = await control.runCommand("done", "", IN_THREAD)
    t3.script("run_2", [{ status: "completed" }])
    await until(() => !runner.isRelaying("stream_thread"))
    const afterwards = await control.runCommand("done", "", IN_THREAD)

    expect({ whileRelaying, afterwards, threads: saved.at(-1)?.threads }).toEqual({
      whileRelaying: {
        ok: false,
        message: "T3 Code is running a turn it started itself here; try again once it finishes.",
      },
      afterwards: { ok: true, summary: "Archived the T3 Code thread `thread_b`" },
      threads: { stream_root: "thread_a" },
    })
  })

  test("/done unlinks a thread already archived in T3", async () => {
    const { t3, saved, control } = setup({ threads: { stream_root: "thread_a", stream_thread: "thread_b" } })
    t3.archiveInT3("thread_b")

    expect(await control.runCommand("done", "", IN_THREAD)).toEqual({
      ok: true,
      summary: "Archived the T3 Code thread `thread_b`",
    })
    expect(saved.at(-1)?.threads).toEqual({ stream_root: "thread_a" })
  })
})
