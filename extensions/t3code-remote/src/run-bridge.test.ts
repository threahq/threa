import { describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ThreaApiError, type DownloadedAttachment } from "@threahq/remote-session"
import { T3AuthError } from "./auth"
import { createFileThreadStore } from "./connector"
import { RunTrace, T3TurnRunner, type RunTraceMode, type ThreadState } from "./run-bridge"
import { T3ToolError, type PendingQuestion, type T3ToolName, type T3Tools } from "./t3-client"
import { DECISION, fakeSession, fakeT3, item, picked, turn, until } from "./t3.test-support"

const MODEL = { instanceId: "codex", model: "gpt-5.5" }

const idle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function setup(
  options: { state?: ThreadState; sealedFullTrace?: boolean; projectId?: string; t3?: ReturnType<typeof fakeT3> } = {}
) {
  const t3 = options.t3 ?? fakeT3()
  const session = fakeSession()
  const saved: ThreadState[] = []
  const logs: string[] = []
  const runner = new T3TurnRunner({
    client: t3.client,
    session: session.session,
    access: "full-access",
    traceMode: "commands",
    sealedFullTrace: options.sealedFullTrace ?? false,
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    threadStore: { load: () => options.state ?? { threads: {}, model: MODEL }, save: (state) => saved.push(state) },
    sleep: () => idle(),
    log: (message) => logs.push(message),
  })
  return { t3, session, saved, logs, runner }
}

function refuseRunWait(t3: ReturnType<typeof fakeT3>, runId: string): () => void {
  const call = t3.client.call
  t3.client.call = (async <K extends T3ToolName>(name: K, args: T3Tools[K]["args"]) => {
    if (name === "t3_thread_wait" && (args as { runId?: string }).runId === runId)
      throw new T3AuthError("Run `threa-t3code login`")
    return call(name, args)
  }) as typeof call
  return () => {
    t3.client.call = call
  }
}

function downloaded(
  filename: string,
  mimeType: string,
  content: string | { sizeBytes: number },
  isSource = true
): DownloadedAttachment {
  const localPath = join(mkdtempSync(join(tmpdir(), "t3-attachment-")), filename)
  if (typeof content === "string") writeFileSync(localPath, content)
  else {
    writeFileSync(localPath, "")
    truncateSync(localPath, content.sizeBytes)
  }
  const sizeBytes = typeof content === "string" ? content.length : content.sizeBytes
  return {
    attachment: { id: `att_${filename}`, filename, mimeType, sizeBytes },
    messageId: isSource ? "msg_1" : "msg_0",
    isSource,
    localPath,
  }
}

function question(id: string, fields: Partial<PendingQuestion> = {}): PendingQuestion {
  return {
    id,
    header: "Test runner",
    question: "Which runner should the suite use?",
    options: [
      { label: "Bun", description: "Fast startup" },
      { label: "Vitest", description: "Watch mode", value: "vitest" },
    ],
    ...fields,
  }
}

const asking = (position = 1) => item(position, "user_input_request", { status: "pending" })
const answered = (position = 1) => item(position, "user_input_request", { status: "completed" })

function traceOf(content: string): { headline: string; sections: unknown[] } {
  const { headline, sections } = JSON.parse(content) as { headline: string; sections: unknown[] }
  return { headline, sections }
}

describe("T3TurnRunner", () => {
  test("launches a scratch thread on the /model selection with the preamble, traces its tools and replies with the last message", async () => {
    const { t3, session, saved, runner } = setup()
    t3.script("run_1", [
      { status: "running", items: [item(1, "command_execution", { status: "running", text: "$ bun test" })] },
      {
        status: "completed",
        items: [
          item(1, "command_execution", { text: "$ bun test\n3 pass" }),
          item(2, "assistant_message", { text: "All green." }),
        ],
      },
    ])

    await runner.deliverTurn(turn())
    await session.settled()

    expect(t3.callsOf("t3_thread_launch")).toEqual([
      {
        title: "Fix the flaky test",
        message: expect.stringMatching(/^You are answering through Threa.*\n\nFix the flaky test$/s),
        runtimeMode: "full-access",
        scratch: true,
        modelSelection: MODEL,
      },
    ])
    expect(saved).toEqual([
      { threads: { stream_root: "thread_1" }, model: MODEL },
      { threads: { stream_root: "thread_1" }, model: MODEL, owed: { thread_1: ["run_1"] } },
    ])
    const [started, final] = session.frames()
    const content = { headline: "bun test", sections: [{ label: "Details", body: "bun test", lang: "bash" }] }
    expect({ ...started!, content: traceOf(started!.content) }).toEqual({
      stepType: "tool_call",
      phase: "started",
      clientStepId: expect.stringMatching(/^t3_[0-9a-f]{32}$/),
      content,
    })
    expect({ ...final!, content: traceOf(final!.content) }).toEqual({
      stepType: "tool_call",
      clientStepId: started!.clientStepId!,
      content,
    })
    expect(session.steps.map((batch) => batch.statusText)).toEqual(["Running a command…", "Working in T3 Code…"])
    expect(session.replies).toEqual([{ invocationId: "binv_1", text: "All green." }])
  })

  test("a scratch launch with no /model refuses before T3 sees it", async () => {
    const { t3, runner } = setup({ state: { threads: {} } })

    await expect(runner.deliverTurn(turn())).rejects.toThrow("pick one with /model")
    expect(t3.callsOf("t3_thread_launch")).toEqual([])
  })

  test("launches into the configured project on its default model, which later launches keep", async () => {
    const { t3, session, saved, runner } = setup({ projectId: "project_1", state: { threads: {} } })
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "Hi" })] }])

    await runner.deliverTurn(turn())
    await session.settled()

    expect(t3.callsOf("t3_thread_launch")).toEqual([
      {
        title: "Fix the flaky test",
        message: expect.stringContaining("Fix the flaky test"),
        runtimeMode: "full-access",
        projectId: "project_1",
      },
    ])
    expect(saved.at(-1)).toEqual({ threads: { stream_root: "thread_1" }, model: MODEL, owed: { thread_1: ["run_1"] } })
  })

  test.each([
    { mode: "worktree", worktree: true },
    { mode: "local", worktree: false },
    { mode: undefined, worktree: false },
  ] as const)(
    "a project thread gets a T3 worktree when the environment's default is one: $mode",
    async ({ mode, worktree }) => {
      const { t3, session, runner } = setup({ projectId: "project_1" })
      t3.defaultEnvMode(mode)
      t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "Hi" })] }])

      await runner.deliverTurn(turn())
      await session.settled()

      expect(t3.callsOf("t3_thread_launch")[0]?.workspaceStrategy).toEqual(
        worktree ? { type: "worktree", baseRef: "HEAD", startFromOrigin: true } : undefined
      )
    }
  )

  test("a project thread whose T3 defaults can't be read fails its turn instead of launching", async () => {
    const { t3, runner } = setup({ projectId: "project_1" })
    t3.failNext("t3_environment_read", new Error("T3 is down"))

    await expect(runner.deliverTurn(turn())).rejects.toThrow("T3 is down")
    expect(t3.callsOf("t3_thread_launch")).toEqual([])
  })

  test("a model the thread is switched to in T3 itself becomes the one new threads launch on", async () => {
    const opus = { instanceId: "claudeAgent", model: "claude-opus-5-5" }
    const { t3, session, saved, runner } = setup({ state: { threads: { stream_root: "thread_root" }, model: opus } })
    t3.script("run_1", [
      { status: "running", model: opus },
      { status: "completed", model: MODEL, items: [item(1, "assistant_message", { text: "Hi" })] },
    ])

    await runner.deliverTurn(turn())
    await session.settled()

    expect({ model: runner.model, saved: saved.at(-1) }).toEqual({
      model: MODEL,
      saved: { threads: { stream_root: "thread_root" }, model: MODEL, owed: { thread_root: ["run_1"] } },
    })
  })

  test("a thread that keeps its old model doesn't undo a /model T3 couldn't apply to it", async () => {
    const opus = { instanceId: "claudeAgent", model: "claude-opus-5-5" }
    const { t3, session, runner } = setup({ state: { threads: { stream_root: "thread_root" }, model: MODEL } })
    t3.script("run_1", [{ status: "running", model: MODEL }])

    await runner.deliverTurn(turn())
    while (t3.callsOf("t3_thread_read").length === 0) await idle()
    runner.setModel(opus)
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "Hi" })] }])
    await session.settled()

    expect(runner.model).toEqual(opus)
  })

  test("uploads the images T3 takes natively and launches with them", async () => {
    const { t3, session, logs, runner } = setup()
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "A cat." })] }])
    const cat = downloaded("cat.png", "image/png", "png-bytes")

    await runner.deliverTurn(
      turn({
        attachments: [
          downloaded("earlier.png", "image/png", "context-bytes", false),
          cat,
          cat,
          downloaded("notes.pdf", "application/pdf", "pdf-bytes"),
          downloaded("empty.gif", "image/gif", ""),
          downloaded("huge.webp", "image/webp", { sizeBytes: 10 * 1024 * 1024 + 1 }),
        ],
      })
    )
    await session.settled()

    expect({
      prepared: t3.callsOf("t3_attachment_prepare_upload"),
      uploads: t3.uploads,
      launched: t3.callsOf("t3_thread_launch").map((call) => call.attachments),
      logs,
    }).toEqual({
      prepared: [{ upload: { type: "image", name: "cat.png", mimeType: "image/png", sizeBytes: 9 } }],
      uploads: [{ relativeUrl: "/api/attachments/upload/tok_1", bytes: "png-bytes" }],
      launched: [[{ type: "image", id: "t3att_1", name: "cat.png", mimeType: "image/png", sizeBytes: 9 }]],
      logs: ["empty.gif reaches T3 only by path: it is empty", "huge.webp reaches T3 only by path: it is over 10 MiB"],
    })
  })

  test("posts earlier assistant messages as narration with attachment paths hidden and reasoning dropped", async () => {
    const { t3, session, runner } = setup()
    t3.script("run_1", [
      {
        status: "completed",
        items: [
          item(1, "assistant_message", { text: "Looking.\nTHREA_ATTACH: /home/someone/shot.png" }),
          item(2, "reasoning", { text: "private chain of thought" }),
          item(3, "assistant_message", { text: "Fixed." }),
        ],
      },
    ])

    await runner.deliverTurn(turn())
    await session.settled()

    expect(session.frames()).toEqual([
      { stepType: "thinking", content: "Looking.\nTHREA_ATTACH: [local path omitted]" },
    ])
    expect(session.replies).toEqual([{ invocationId: "binv_1", text: "Fixed." }])
  })

  test("posts a THREA_UPDATE message while the run goes on, and replies without the prefix", async () => {
    const { t3, session, runner } = setup()
    t3.script("run_1", [
      {
        status: "running",
        items: [
          item(1, "assistant_message", { text: "THREA_UPDATE: Halfway, tests are running." }),
          item(2, "command_execution", { status: "running", text: "$ bun test" }),
        ],
      },
    ])
    const delivered = runner.deliverTurn(turn())
    await until(() => session.interims.length > 0)
    const whileRunning = { interims: [...session.interims], replies: [...session.replies] }

    t3.script("run_1", [
      {
        status: "completed",
        items: [
          item(2, "command_execution", { text: "$ bun test" }),
          item(3, "assistant_message", { text: "THREA_UPDATE: All green." }),
        ],
      },
    ])
    await delivered
    await session.settled()

    expect({
      whileRunning,
      interims: session.interims,
      replies: session.replies,
      stepTypes: session.frames().map((frame) => frame.stepType),
    }).toEqual({
      whileRunning: { interims: [{ invocationId: "binv_1", text: "Halfway, tests are running." }], replies: [] },
      interims: [{ invocationId: "binv_1", text: "Halfway, tests are running." }],
      replies: [{ invocationId: "binv_1", text: "All green." }],
      stepTypes: ["tool_call", "tool_call"],
    })
  })

  test("keeps an update a post failed on, and posts it and the ones after it in order", async () => {
    const { t3, session, runner } = setup()
    session.interimResults.push({ ok: false, retryable: true, message: "Input update is still in progress" })
    t3.script("run_1", [
      {
        status: "running",
        items: [
          item(1, "assistant_message", { text: "THREA_UPDATE: First." }),
          item(2, "assistant_message", { text: "THREA_UPDATE: Second." }),
          item(3, "command_execution", { status: "running", text: "$ bun test" }),
        ],
      },
      { status: "running", items: [] },
    ])
    const delivered = runner.deliverTurn(turn())
    await until(() => session.interims.length === 2)
    t3.script("run_1", [{ status: "completed", items: [item(4, "assistant_message", { text: "Done." })] }])
    await delivered
    await session.settled()

    expect(session.interims).toEqual([
      { invocationId: "binv_1", text: "First." },
      { invocationId: "binv_1", text: "Second." },
    ])
  })

  test("shows reasoning on sealed turns when sealedFullTrace is on", async () => {
    const { t3, session, runner } = setup({ sealedFullTrace: true })
    t3.script("run_1", [
      {
        status: "completed",
        items: [item(1, "reasoning", { text: "chain of thought" }), item(2, "assistant_message", { text: "Done" })],
      },
    ])

    await runner.deliverTurn(turn({ sealed: true }))
    await session.settled()

    expect(session.frames()).toEqual([{ stepType: "thinking", content: "chain of thought" }])
  })

  test("continues a capped reply from its text offset", async () => {
    const { t3, session, runner } = setup()
    t3.continueText("turn-item:1", "Hello world, at length")
    t3.script("run_1", [
      { status: "completed", items: [item(1, "assistant_message", { text: "Hello", nextTextOffset: 5 })] },
    ])

    await runner.deliverTurn(turn())
    await session.settled()

    expect(session.replies).toEqual([{ invocationId: "binv_1", text: "Hello world, at length" }])
  })

  test("queues a follow-up turn on the stream's thread and reads past the previous run", async () => {
    const { t3, session, runner } = setup()
    t3.script("run_1", [
      {
        status: "completed",
        items: [item(1, "user_message", { text: "Fix it" }), item(2, "assistant_message", { text: "Fixed." })],
      },
    ])
    await runner.deliverTurn(turn())
    await session.settled()
    await idle()
    const readsBefore = t3.callsOf("t3_thread_read").length

    t3.script("run_2", [
      { status: "completed", items: [item(3, "assistant_message", { runId: "run_2", text: "Docs updated." })] },
    ])
    await runner.deliverTurn(turn({ invocationId: "binv_2", content: "Now the docs" }))
    await session.settled()

    expect(t3.callsOf("t3_thread_send")).toEqual([
      {
        threadId: "thread_1",
        message: expect.stringContaining("\n\nNow the docs"),
        mode: "queue",
        clientRequestId: "binv_2",
      },
    ])
    expect(
      t3
        .callsOf("t3_thread_read")
        .slice(readsBefore)
        .filter((args) => args.view === "activity")
    ).toEqual([
      expect.objectContaining({ threadId: "thread_1", afterPosition: 1, maxCharsPerItem: 1 }),
      expect.objectContaining({ threadId: "thread_1", afterPosition: 1, maxCharsPerItem: 8000 }),
    ])
    expect(session.replies.at(-1)).toEqual({ invocationId: "binv_2", text: "Docs updated." })
  })

  test("a follow-up with an image goes through T3's attachment send", async () => {
    const { t3, session, runner } = setup({ state: { threads: { stream_root: "thread_1" } } })
    t3.steerAs("started")
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "A cat." })] }])

    await runner.deliverTurn(turn({ attachments: [downloaded("cat.png", "image/png", "png-bytes")] }))
    await session.settled()

    expect({ sends: t3.callsOf("t3_thread_send"), attachmentSends: t3.callsOf("t3_thread_send_attachments") }).toEqual({
      sends: [],
      attachmentSends: [
        {
          threadId: "thread_1",
          message: expect.stringContaining("\n\nFix the flaky test"),
          attachments: [{ type: "image", id: "t3att_1", name: "cat.png", mimeType: "image/png", sizeBytes: 9 }],
        },
      ],
    })
    expect(session.replies).toEqual([{ invocationId: "binv_1", text: "A cat." }])
  })

  test("forks the scratchpad's thread for a thread under the scratchpad", async () => {
    const { t3, session, saved, runner } = setup({ state: { threads: { stream_root: "thread_root" } } })
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "On it" })] }])

    await runner.deliverTurn(turn({ streamId: "stream_thread", content: "Branch off here" }))
    await session.settled()

    expect(t3.callsOf("t3_thread_transfer")).toEqual([
      { action: "fork", threadId: "thread_root", sourcePoint: { type: "latest_stable" }, title: "Branch off here" },
    ])
    expect(t3.callsOf("t3_thread_send")).toEqual([expect.objectContaining({ threadId: "thread_1" })])
    expect(saved.at(-1)).toEqual({
      threads: { stream_root: "thread_root", stream_thread: "thread_1" },
      model: MODEL,
      owed: { thread_1: ["run_1"] },
    })
  })

  test("a spawned thread launches a fresh T3 thread on the spawn's model instead of forking", async () => {
    const opus = { instanceId: "claudeAgent", model: "claude-opus-5-5" }
    const { t3, session, saved, runner } = setup({
      state: {
        threads: { stream_root: "thread_root" },
        model: MODEL,
        spawns: { msg_spawn: { title: "helper", model: opus } },
      },
    })
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "On it" })] }])

    await runner.deliverTurn(turn({ streamId: "stream_thread", sourceMessageId: "msg_spawn" }))
    await session.settled()

    expect({
      forks: t3.callsOf("t3_thread_transfer"),
      launches: t3.callsOf("t3_thread_launch"),
      saved: saved.at(-1),
    }).toEqual({
      forks: [],
      launches: [
        expect.objectContaining({
          title: "helper",
          message: expect.stringMatching(/\n\nFix the flaky test$/),
          modelSelection: opus,
          scratch: true,
        }),
      ],
      saved: {
        threads: { stream_root: "thread_root", stream_thread: "thread_1" },
        model: MODEL,
        spawns: {},
        owed: { thread_1: ["run_1"] },
      },
    })
  })

  test("a spawn whose first launch fails still launches fresh on its thread's next turn", async () => {
    const { t3, session, runner } = setup({
      state: { threads: { stream_root: "thread_root" }, model: MODEL, spawns: { msg_spawn: { title: "helper" } } },
    })
    t3.failNext("t3_thread_launch", new Error("T3 Code is restarting"))
    await expect(runner.deliverTurn(turn({ streamId: "stream_thread", sourceMessageId: "msg_spawn" }))).rejects.toThrow(
      "T3 Code is restarting"
    )
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "On it" })] }])

    await runner.deliverTurn(turn({ invocationId: "binv_2", streamId: "stream_thread", sourceMessageId: "msg_2" }))
    await session.settled()

    expect({ forks: t3.callsOf("t3_thread_transfer"), launches: t3.callsOf("t3_thread_launch") }).toEqual({
      forks: [],
      launches: [
        expect.objectContaining({ title: "helper", modelSelection: MODEL }),
        expect.objectContaining({ title: "helper", modelSelection: MODEL }),
      ],
    })
  })

  test("queues a spawn only when its thread can launch, and drops it on request", () => {
    const { saved, runner } = setup({ state: { threads: {} } })

    expect(() => runner.queueSpawn("msg_spawn", { title: "helper" })).toThrow(
      "T3 Code needs a model for new threads: pick one with /model."
    )
    runner.queueSpawn("msg_spawn", { title: "helper", model: MODEL })
    runner.dropSpawn("msg_spawn")

    expect(saved).toEqual([
      { threads: {}, spawns: { msg_spawn: { title: "helper", model: MODEL } } },
      { threads: {}, spawns: {} },
    ])
  })

  test("a mention outside the scratchpad launches its own thread", async () => {
    const { t3, session, runner } = setup({ state: { threads: { stream_root: "thread_root" }, model: MODEL } })
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "Hi" })] }])

    await runner.deliverTurn(turn({ streamId: "stream_channel", rootStreamId: "stream_channel" }))
    await session.settled()

    expect({ forks: t3.callsOf("t3_thread_transfer"), launches: t3.callsOf("t3_thread_launch") }).toEqual({
      forks: [],
      launches: [expect.objectContaining({ title: "Fix the flaky test", scratch: true })],
    })
  })

  test("a failed run fails the turn with its error", async () => {
    const { t3, session, runner } = setup()
    t3.script("run_1", [{ status: "failed", items: [item(1, "error", { text: "Provider rate limit reached" })] }])

    await runner.deliverTurn(turn())
    await session.settled()

    expect(session.fails).toEqual([{ invocationId: "binv_1", errorMessage: "Provider rate limit reached" }])
    expect(session.frames().map((frame) => frame.stepType)).toEqual(["tool_error"])
  })

  test("a run that ends without an error item fails the turn with its status", async () => {
    const { t3, session, runner } = setup()
    t3.script("run_1", [{ status: "rolled_back" }])

    await runner.deliverTurn(turn())
    await session.settled()

    expect(session.fails).toEqual([{ invocationId: "binv_1", errorMessage: "The T3 Code run was rolled back." }])
  })

  test("stops a run that waits on an approval and fails the turn", async () => {
    const { t3, session, runner } = setup()
    t3.script("run_1", [{ status: "waiting", items: [item(1, "approval_request", { status: "pending" })] }])

    await runner.deliverTurn(turn())
    await session.settled()

    expect(t3.callsOf("t3_thread_interrupt")).toEqual([
      { threadId: "thread_1", runId: "run_1", reason: "Stopped from Threa" },
    ])
    expect(session.fails).toEqual([
      { invocationId: "binv_1", errorMessage: expect.stringContaining("to ask for an approval") },
    ])
  })

  test("puts each question of a request on a card and sends the answers back to T3", async () => {
    const { t3, session, runner } = setup()
    t3.ask("thread_1", "req_1", [
      question("runner", { allowCustomAnswer: false }),
      question("watch", { header: "Watch", options: [] }),
      question("coverage", { header: "Coverage", required: false }),
    ])
    t3.script("run_1", [{ status: "waiting", items: [asking()] }])

    await runner.deliverTurn(turn())
    await idle()
    session.answer(picked("option_1"))
    await idle()
    session.answer(picked("other", "  "))
    await idle()
    session.answer(picked("other", " only on CI "))
    await idle()
    session.answer(picked("skip"))
    await idle()

    const ref = { streamId: "stream_root", invocationId: "binv_1", externalRef: "req_1" }
    const watch = {
      title: "Watch",
      body: "Which runner should the suite use?\n\nFor Other, write your answer in the note.",
      options: [{ id: "other", label: "Other" }],
      allowNote: true,
      ...ref,
    }
    expect(session.decisions.map(({ input }) => input)).toEqual([
      {
        title: "Test runner",
        body: "Which runner should the suite use?\n\n- **Bun**: Fast startup\n- **Vitest**: Watch mode",
        options: [
          { id: "option_0", label: "Bun" },
          { id: "option_1", label: "Vitest" },
        ],
        allowNote: false,
        ...ref,
      },
      watch,
      watch,
      {
        title: "Coverage",
        body: "Which runner should the suite use?\n\n- **Bun**: Fast startup\n- **Vitest**: Watch mode\n\nFor Other, write your answer in the note.",
        options: [
          { id: "option_0", label: "Bun" },
          { id: "option_1", label: "Vitest" },
          { id: "other", label: "Other" },
          { id: "skip", label: "Skip" },
        ],
        allowNote: true,
        ...ref,
      },
    ])
    expect(t3.callsOf("t3_pending_request", "respond")).toEqual([
      {
        action: "respond",
        threadId: "thread_1",
        requestId: "req_1",
        answers: { runner: "vitest", watch: "only on CI" },
      },
    ])

    t3.script("run_1", [
      { status: "completed", items: [answered(), item(2, "assistant_message", { text: "Switched to Vitest" })] },
    ])
    await session.settled()
    expect({ replies: session.replies, fails: session.fails }).toEqual({
      replies: [{ invocationId: "binv_1", text: "Switched to Vitest" }],
      fails: [],
    })
  })

  test("a question answered in T3 itself withdraws its card", async () => {
    const { t3, session, runner } = setup()
    t3.ask("thread_1", "req_1", [question("runner")])
    t3.script("run_1", [{ status: "waiting", items: [asking()] }])
    await runner.deliverTurn(turn())
    await idle()

    t3.answerInT3("req_1")
    t3.script("run_1", [{ status: "running", items: [answered()] }])
    await idle()

    expect(session.decisions.map(({ signal }) => signal?.aborted)).toEqual([true])
    t3.script("run_1", [{ status: "completed", items: [item(2, "assistant_message", { text: "Done" })] }])
    await session.settled()
    expect({ replies: session.replies, responds: t3.callsOf("t3_pending_request", "respond") }).toEqual({
      replies: [{ invocationId: "binv_1", text: "Done" }],
      responds: [],
    })
  })

  test("a card closed without an answer stops the run and fails the turn", async () => {
    const { t3, session, runner } = setup()
    t3.ask("thread_1", "req_1", [question("runner")])
    t3.script("run_1", [{ status: "waiting", items: [asking()] }])
    await runner.deliverTurn(turn())
    await idle()

    session.answer({ status: "expired", decision: DECISION })
    await idle()
    t3.script("run_1", [{ status: "waiting" }])
    await session.settled()

    expect({
      interrupts: t3.callsOf("t3_thread_interrupt"),
      responds: t3.callsOf("t3_pending_request", "respond"),
      fails: session.fails,
    }).toEqual({
      interrupts: [{ threadId: "thread_1", runId: "run_1", reason: "Stopped from Threa" }],
      responds: [],
      fails: [{ invocationId: "binv_1", errorMessage: "T3 Code asked a question that went unanswered." }],
    })
  })

  test("a card the session abandons, as archiving the scratchpad does, stops the run", async () => {
    const { t3, session, runner } = setup()
    t3.ask("thread_1", "req_1", [question("runner")])
    t3.script("run_1", [{ status: "waiting", items: [asking()] }])
    await runner.deliverTurn(turn())
    await idle()

    session.abandon()
    await idle()
    t3.script("run_1", [{ status: "waiting" }])
    await session.settled()

    expect({
      decisions: session.decisions.length,
      interrupts: t3.callsOf("t3_thread_interrupt"),
      fails: session.fails,
    }).toEqual({
      decisions: 1,
      interrupts: [{ threadId: "thread_1", runId: "run_1", reason: "Stopped from Threa" }],
      fails: [{ invocationId: "binv_1", errorMessage: "T3 Code asked a question that went unanswered." }],
    })
  })

  test("a question T3 won't read fails the turn with why", async () => {
    const { t3, session, runner } = setup()
    t3.failNext("t3_pending_request", new Error("request not found"), (args) => args.action === "read")
    t3.ask("thread_1", "req_1", [question("runner")])
    t3.script("run_1", [{ status: "waiting", items: [asking()] }])
    await runner.deliverTurn(turn())
    await idle()
    t3.script("run_1", [{ status: "waiting" }])
    await session.settled()

    expect(session.fails).toEqual([
      {
        invocationId: "binv_1",
        errorMessage: "T3 Code's question couldn't be answered from Threa: request not found",
      },
    ])
  })

  test("a run that ends on an open question follows the run its answer starts", async () => {
    const { t3, session, runner } = setup()
    t3.ask("thread_1", "req_1", [question("runner")], true)
    t3.script("run_1", [
      { status: "completed", items: [item(1, "assistant_message", { text: "One question first." }), asking(2)] },
    ])
    await runner.deliverTurn(turn())
    await idle()
    const busyWhileAsking = runner.busy

    session.answer(picked("option_0"))
    await idle()
    t3.script("run_2", [
      {
        status: "completed",
        items: [answered(2), item(3, "assistant_message", { runId: "run_2", text: "Bun it is" })],
      },
    ])
    await session.settled()

    await until(() => !runner.busy)
    expect({
      busyWhileAsking,
      busy: runner.busy,
      responds: t3.callsOf("t3_pending_request", "respond"),
      replies: session.replies,
      fails: session.fails,
    }).toEqual({
      busyWhileAsking: true,
      busy: false,
      responds: [{ action: "respond", threadId: "thread_1", requestId: "req_1", answers: { runner: "Bun" } }],
      replies: [{ invocationId: "binv_1", text: "Bun it is" }],
      fails: [],
    })
  })

  test("a question asked as a message and answered in T3 itself follows the run the answer starts", async () => {
    const { t3, session, runner } = setup()
    t3.ask("thread_1", "req_1", [question("runner")], true)
    t3.script("run_1", [{ status: "completed", items: [asking()] }])
    await runner.deliverTurn(turn())
    await idle()

    t3.answerInT3("req_1")
    t3.script("run_1", [{ status: "completed", items: [answered()] }])
    t3.script("run_2", [
      { status: "completed", items: [item(2, "assistant_message", { runId: "run_2", text: "Bun it is" })] },
    ])
    await session.settled()

    expect({
      withdrawn: session.decisions.map(({ signal }) => signal?.aborted),
      replies: session.replies,
    }).toEqual({ withdrawn: [true], replies: [{ invocationId: "binv_1", text: "Bun it is" }] })
  })

  test("an answer T3 steers into the running run is followed in that run", async () => {
    const { t3, session, runner } = setup()
    t3.ask("thread_1", "req_1", [question("runner")], true)
    t3.script("run_1", [{ status: "running", items: [asking()] }])
    await runner.deliverTurn(turn())
    await idle()

    session.answer(picked("option_0"))
    await idle()
    t3.script("run_1", [
      { status: "completed", items: [answered(), item(2, "assistant_message", { text: "Bun it is" })] },
    ])
    await session.settled()

    expect({
      replies: session.replies,
      followed: [...new Set(t3.callsOf("t3_thread_wait").map(({ runId }) => runId))],
    }).toEqual({ replies: [{ invocationId: "binv_1", text: "Bun it is" }], followed: ["run_1"] })
  })

  test("an answer T3 queues behind the run is followed once the run ends", async () => {
    const { t3, session, runner } = setup()
    t3.steerAs("queued")
    t3.ask("thread_1", "req_1", [question("runner")], true)
    t3.script("run_1", [{ status: "running", items: [asking()] }])
    await runner.deliverTurn(turn())
    await idle()

    session.answer(picked("option_0"))
    await idle()
    t3.script("run_1", [{ status: "completed", items: [answered()] }])
    t3.script("run_2", [
      { status: "completed", items: [item(2, "assistant_message", { runId: "run_2", text: "Bun it is" })] },
    ])
    await session.settled()

    expect(session.replies).toEqual([{ invocationId: "binv_1", text: "Bun it is" }])
  })

  test("each answer that starts a run keeps that run in the turn", async () => {
    const { t3, session, runner } = setup()
    t3.steerAs("queued")
    t3.ask("thread_1", "req_1", [question("runner")], true)
    t3.ask("thread_1", "req_2", [question("watch", { header: "Watch" })], true)
    t3.script("run_1", [{ status: "completed", items: [asking(), asking(2)] }])
    await runner.deliverTurn(turn())
    await idle()

    session.answer(picked("option_0"))
    await until(() => session.decisions.length === 2)
    session.answer(picked("option_0"))
    await until(() => t3.callsOf("t3_pending_request", "respond").length === 2)
    t3.script("run_3", [
      {
        status: "completed",
        items: [
          answered(),
          answered(2),
          item(3, "assistant_message", { runId: "run_2", text: "Runner noted" }),
          item(4, "assistant_message", { runId: "run_3", text: "Watching too" }),
        ],
      },
    ])
    await session.settled()

    expect({ frames: session.frames(), replies: session.replies }).toEqual({
      frames: [{ stepType: "thinking", content: "Runner noted" }],
      replies: [{ invocationId: "binv_1", text: "Watching too" }],
    })
  })

  test("a request answered in T3 before its card goes up is passed over", async () => {
    const { t3, session, runner } = setup()
    t3.ask("thread_1", "req_1", [question("runner")])
    t3.ask("thread_1", "req_2", [question("watch", { header: "Watch" })])
    t3.script("run_1", [{ status: "waiting", items: [asking(), asking(2)] }])
    await runner.deliverTurn(turn())
    await idle()

    t3.answerInT3("req_2")
    session.answer(picked("option_0"))
    await idle()
    t3.script("run_1", [
      { status: "completed", items: [answered(), answered(2), item(3, "assistant_message", { text: "Bun it is" })] },
    ])
    await session.settled()

    expect({
      cards: session.decisions.map(({ input }) => input.externalRef),
      interrupts: t3.callsOf("t3_thread_interrupt"),
      replies: session.replies,
      fails: session.fails,
    }).toEqual({
      cards: ["req_1"],
      interrupts: [],
      replies: [{ invocationId: "binv_1", text: "Bun it is" }],
      fails: [],
    })
  })

  test("a run that asked carries on alone when its answer starts no run, past one the user queued in T3", async () => {
    const { t3, session, runner } = setup()
    t3.ask("thread_1", "req_1", [question("runner")])
    t3.script("run_1", [{ status: "waiting", items: [asking()] }])
    await runner.deliverTurn(turn())
    await idle()

    session.answer(picked("option_0"))
    await until(() => t3.callsOf("t3_pending_request", "respond").length === 1)
    await t3.client.call("t3_thread_send", { threadId: "thread_1", message: "Unrelated", mode: "queue" })
    t3.script("run_1", [
      { status: "completed", items: [answered(), item(2, "assistant_message", { text: "Bun it is" })] },
    ])
    await session.settled()

    expect(session.replies).toEqual([{ invocationId: "binv_1", text: "Bun it is" }])
  })

  test("a question answered in T3 and Threa at once carries on", async () => {
    const { t3, session, runner } = setup()
    t3.ask("thread_1", "req_1", [question("runner")])
    t3.script("run_1", [{ status: "waiting", items: [asking()] }])
    await runner.deliverTurn(turn())
    await idle()

    t3.answerInT3("req_1")
    session.answer(picked("option_0"))
    await idle()
    t3.script("run_1", [
      { status: "completed", items: [answered(), item(2, "assistant_message", { text: "Bun it is" })] },
    ])
    await session.settled()

    expect({ replies: session.replies, fails: session.fails }).toEqual({
      replies: [{ invocationId: "binv_1", text: "Bun it is" }],
      fails: [],
    })
  })

  test("a request whose only question is optional can't be skipped, since T3 refuses an empty reply", async () => {
    const { t3, session, runner } = setup()
    t3.ask("thread_1", "req_1", [question("coverage", { required: false })])
    t3.script("run_1", [{ status: "waiting", items: [asking()] }])
    await runner.deliverTurn(turn())
    await idle()

    expect(session.decisions.map(({ input }) => input.options.map((option) => option.id))).toEqual([
      ["option_0", "option_1", "other"],
    ])
  })

  test("a request T3 swaps for another moves the card to the new one", async () => {
    const { t3, session, runner } = setup()
    t3.ask("thread_1", "req_1", [question("runner")])
    t3.script("run_1", [{ status: "waiting", items: [asking()] }])
    await runner.deliverTurn(turn())
    await idle()

    t3.answerInT3("req_1")
    t3.ask("thread_1", "req_2", [question("watch", { header: "Watch" })])
    t3.script("run_1", [{ status: "waiting", items: [answered(), asking(2)] }])
    await idle()
    session.answer(picked("option_0"))
    await idle()

    expect({
      cards: session.decisions.map(({ input, signal }) => ({ ref: input.externalRef, withdrawn: signal?.aborted })),
      responds: t3.callsOf("t3_pending_request", "respond"),
    }).toEqual({
      cards: [
        { ref: "req_1", withdrawn: true },
        { ref: "req_2", withdrawn: false },
      ],
      responds: [{ action: "respond", threadId: "thread_1", requestId: "req_2", answers: { watch: "Bun" } }],
    })
  })

  test("a question an earlier turn left open isn't asked again", async () => {
    const { t3, session, runner } = setup({ state: { threads: { stream_root: "thread_1" }, model: MODEL } })
    t3.ask("thread_1", "req_old", [question("old")])
    t3.script("run_1", [{ status: "running", items: [] }])
    await runner.deliverTurn(turn())
    await idle()
    t3.ask("thread_1", "req_1", [question("runner")])
    t3.script("run_1", [{ status: "waiting", items: [asking()] }])
    await idle()

    expect(session.decisions.map(({ input }) => input.externalRef)).toEqual(["req_1"])
  })

  test("a message typed while a card is up answers it, and the turn follows the run the answer starts", async () => {
    const { t3, session, runner } = setup()
    t3.ask("thread_1", "req_1", [question("runner")], true)
    t3.script("run_1", [{ status: "completed", items: [asking()] }])
    await runner.deliverTurn(turn())
    await idle()

    expect(await runner.steer(" Use Bun ", "stream_root", [])).toBe(true)
    await idle()
    t3.script("run_2", [
      {
        status: "completed",
        items: [answered(), item(2, "assistant_message", { runId: "run_2", text: "Using Bun" })],
      },
    ])
    await session.settled()

    expect({
      withdrawn: session.decisions.map(({ signal }) => signal?.aborted),
      sends: t3.callsOf("t3_thread_send"),
      responds: t3.callsOf("t3_pending_request", "respond"),
      replies: session.replies,
    }).toEqual({
      withdrawn: [true],
      sends: [],
      responds: [{ action: "respond", threadId: "thread_1", requestId: "req_1", answers: { runner: "Use Bun" } }],
      replies: [{ invocationId: "binv_1", text: "Using Bun" }],
    })
  })

  test("a message typed while a card that takes no written answer is up steers the run and leaves the card", async () => {
    const { t3, session, runner } = setup()
    t3.ask("thread_1", "req_1", [question("runner", { allowCustomAnswer: false })])
    t3.script("run_1", [{ status: "running", items: [asking()] }])
    await runner.deliverTurn(turn())
    await idle()

    expect(await runner.steer("Use Bun", "stream_root", [])).toBe(true)
    await idle()

    expect({
      open: session.decisions.map(({ signal }) => signal?.aborted),
      sends: t3.callsOf("t3_thread_send").map(({ message }) => message),
      responds: t3.callsOf("t3_pending_request", "respond"),
    }).toEqual({ open: [false], sends: [expect.stringContaining("\n\nUse Bun")], responds: [] })
    runner.shutdown()
  })

  test("an edited message steers the run and leaves the card", async () => {
    const { t3, session, runner } = setup()
    t3.ask("thread_1", "req_1", [question("runner")])
    t3.script("run_1", [{ status: "running", items: [asking()] }])
    await runner.deliverTurn(turn())
    await idle()

    expect(await runner.steer("Deploy it, using Bun", "stream_root", [], { edit: true })).toBe(true)
    await idle()

    expect({
      open: session.decisions.map(({ signal }) => signal?.aborted),
      sends: t3.callsOf("t3_thread_send").map(({ message, mode }) => ({ message, mode })),
      responds: t3.callsOf("t3_pending_request", "respond"),
    }).toEqual({
      open: [false],
      sends: [{ message: expect.stringContaining("\n\nDeploy it, using Bun"), mode: "steer" }],
      responds: [],
    })
    runner.shutdown()
  })

  test("an edit a waiting run can't take runs next, and the turn follows it with the card still up", async () => {
    const { t3, session, runner } = setup()
    t3.ask("thread_1", "req_1", [question("runner")], true)
    t3.script("run_1", [{ status: "waiting", items: [asking()] }])
    await runner.deliverTurn(turn())
    await idle()

    expect(await runner.steer("Deploy it, using Bun", "stream_root", [], { edit: true })).toBe(true)
    t3.script("run_1", [{ status: "waiting" }])
    await idle()

    expect({
      open: session.decisions.map(({ signal }) => signal?.aborted),
      sends: t3.callsOf("t3_thread_send").map(({ message, mode }) => ({ message, mode })),
      responds: t3.callsOf("t3_pending_request", "respond"),
      followed: t3.callsOf("t3_thread_wait").at(-1)?.runId,
    }).toEqual({
      open: [false],
      sends: [
        { message: expect.stringContaining("\n\nDeploy it, using Bun"), mode: "steer" },
        { message: expect.stringContaining("\n\nDeploy it, using Bun"), mode: "queue" },
      ],
      responds: [],
      followed: "run_2",
    })
    runner.shutdown()
  })

  test("/stop withdraws an open question card", async () => {
    const { t3, session, runner } = setup()
    t3.ask("thread_1", "req_1", [question("runner")])
    t3.script("run_1", [{ status: "waiting", items: [asking()] }])
    await runner.deliverTurn(turn())
    await idle()

    runner.interrupt("stream_root")
    await idle()

    expect({
      aborted: session.decisions.map(({ signal }) => signal?.aborted),
      responds: t3.callsOf("t3_pending_request", "respond"),
      fails: session.fails,
    }).toEqual({ aborted: [true], responds: [], fails: [] })
  })

  test("rides out a transient poll failure", async () => {
    const { t3, session, runner } = setup()
    t3.failNext("t3_thread_wait", new Error("socket hang up"))
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "Done" })] }])

    await runner.deliverTurn(turn())
    await session.settled()

    expect(session.replies).toEqual([{ invocationId: "binv_1", text: "Done" }])
  })

  test("rides out T3 being down for a restart", async () => {
    const { t3, session, runner } = setup()
    for (let i = 0; i < 20; i++) t3.failNext("t3_thread_wait", new Error("connect ECONNREFUSED"))
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "Done" })] }])

    await runner.deliverTurn(turn())
    await session.settled()

    expect(session.replies).toEqual([{ invocationId: "binv_1", text: "Done" }])
  })

  test("a refusal mid-run fails the turn at once and stops the run", async () => {
    const { t3, session, runner } = setup()
    t3.failNext(
      "t3_thread_wait",
      new T3ToolError("t3_thread_wait", "operation_failed", "T3 Code t3_thread_wait failed: no")
    )

    await runner.deliverTurn(turn())
    await session.settled()

    expect({ fails: session.fails, interrupts: t3.callsOf("t3_thread_interrupt") }).toEqual({
      fails: [{ invocationId: "binv_1", errorMessage: "T3 Code t3_thread_wait failed: no" }],
      interrupts: [{ threadId: "thread_1", runId: "run_1", reason: "Stopped from Threa" }],
    })
  })

  test("a thread deleted in T3 is forgotten so the next message launches a new one", async () => {
    const { t3, saved, runner } = setup({
      state: { threads: { stream_root: "thread_gone" }, model: MODEL, delivered: { thread_gone: "run_0" } },
    })
    t3.failNext("t3_thread_send", new T3ToolError("t3_thread_send", "thread_not_found", "not found"))

    await expect(runner.deliverTurn(turn())).rejects.toThrow(
      "`thread_gone` is gone; the next message starts a new one."
    )
    expect(saved.at(-1)).toEqual({ threads: {}, model: MODEL, delivered: {}, posted: {} })
  })

  test("a thread deleted mid-run fails the turn and is forgotten", async () => {
    const { t3, session, saved, runner } = setup()
    t3.failNext("t3_thread_wait", new T3ToolError("t3_thread_wait", "thread_not_found", "not found"))

    await runner.deliverTurn(turn())
    await session.settled()

    expect({ fails: session.fails, state: saved.at(-1) }).toEqual({
      fails: [{ invocationId: "binv_1", errorMessage: expect.stringContaining("`thread_1` is gone") }],
      state: { threads: {}, model: MODEL, delivered: {}, posted: {} },
    })
  })

  test("fails the turn at once when T3 rejects the token", async () => {
    const { t3, session, runner } = setup()
    t3.failNext("t3_thread_wait", new T3AuthError("Run `threa-t3code login`"))

    await runner.deliverTurn(turn())
    await session.settled()

    expect(session.fails).toEqual([{ invocationId: "binv_1", errorMessage: "Run `threa-t3code login`" }])
    expect(t3.callsOf("t3_thread_wait")).toHaveLength(1)
  })

  test("steers only into the stream's open run", async () => {
    const { t3, runner } = setup()
    t3.script("run_1", [{ status: "running" }])
    await runner.deliverTurn(turn())

    expect(await runner.steer("also the docs", "stream_other", [])).toBe(false)
    expect(await runner.steer("also the docs", "stream_root", [])).toBe(true)
    t3.failNext("t3_thread_send", t3.notSendable())
    expect(await runner.steer("and the readme", "stream_root", [])).toBe(false)
    expect(t3.callsOf("t3_thread_send")).toEqual([
      { threadId: "thread_1", message: expect.stringContaining("\n\nalso the docs"), mode: "steer" },
      { threadId: "thread_1", message: expect.stringContaining("\n\nand the readme"), mode: "steer" },
    ])
    runner.shutdown()
  })

  test("a steer with an image goes through T3's attachment send", async () => {
    const { t3, runner } = setup()
    t3.script("run_1", [{ status: "running" }])
    await runner.deliverTurn(turn())

    expect(await runner.steer("this one", "stream_root", [downloaded("cat.png", "image/png", "png-bytes")])).toBe(true)
    expect({ sends: t3.callsOf("t3_thread_send"), attachmentSends: t3.callsOf("t3_thread_send_attachments") }).toEqual({
      sends: [],
      attachmentSends: [
        {
          threadId: "thread_1",
          message: expect.stringContaining("\n\nthis one"),
          attachments: [{ type: "image", id: "t3att_1", name: "cat.png", mimeType: "image/png", sizeBytes: 9 }],
        },
      ],
    })
    runner.shutdown()
  })

  test.each(["started", "queued"] as const)(
    "a steer T3 %s as its own run is sent once and answers in the open turn",
    async (delivery) => {
      const { t3, session, runner } = setup()
      t3.script("run_1", [{ status: "running" }])
      await runner.deliverTurn(turn())
      await idle()

      t3.steerAs(delivery)
      expect(await runner.steer("also the docs", "stream_root", [])).toBe(true)
      t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "Fixed." })] }])
      t3.script("run_2", [
        { status: "completed", items: [item(2, "assistant_message", { runId: "run_2", text: "Docs too." })] },
      ])
      await session.settled()

      expect({
        sends: t3.callsOf("t3_thread_send"),
        frames: session.frames(),
        replies: session.replies,
      }).toEqual({
        sends: [{ threadId: "thread_1", message: expect.stringContaining("\n\nalso the docs"), mode: "steer" }],
        frames: [{ stepType: "thinking", content: "Fixed." }],
        replies: [{ invocationId: "binv_1", text: "Docs too." }],
      })
    }
  )

  test("an image steer still uploading when the run ends answers in the open turn", async () => {
    const { t3, session, runner } = setup()
    t3.script("run_1", [{ status: "running" }])
    await runner.deliverTurn(turn())
    await idle()
    const release = t3.holdNext("t3_attachment_prepare_upload")
    t3.steerAs("started")

    const steering = runner.steer("this one", "stream_root", [downloaded("cat.png", "image/png", "png-bytes")])
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "Fixed." })] }])
    await idle()
    release()
    expect(await steering).toBe(true)
    t3.script("run_2", [
      { status: "completed", items: [item(2, "assistant_message", { runId: "run_2", text: "A cat." })] },
    ])
    await session.settled()

    expect(session.replies).toEqual([{ invocationId: "binv_1", text: "A cat." }])
  })

  test("/stop while an image steer uploads sends nothing", async () => {
    const { t3, runner } = setup()
    t3.script("run_1", [{ status: "running" }])
    await runner.deliverTurn(turn())
    await idle()
    const release = t3.holdNext("t3_attachment_prepare_upload")

    const steering = runner.steer("this one", "stream_root", [downloaded("cat.png", "image/png", "png-bytes")])
    await idle()
    runner.interrupt("stream_root")
    release()

    expect(await steering).toBe(false)
    expect(t3.callsOf("t3_thread_send_attachments")).toEqual([])
  })

  test("/stop while an image steer sends stops the run it started", async () => {
    const { t3, runner } = setup()
    t3.script("run_1", [{ status: "running" }])
    await runner.deliverTurn(turn())
    await idle()
    t3.steerAs("started")
    const release = t3.holdNext("t3_thread_send_attachments")

    const steering = runner.steer("this one", "stream_root", [downloaded("cat.png", "image/png", "png-bytes")])
    // The image is read from disk first, which can take more than one tick.
    await until(() => t3.callsOf("t3_thread_send_attachments").length > 0)
    runner.interrupt("stream_root")
    release()
    await steering
    await idle()

    expect(t3.callsOf("t3_thread_interrupt").map((call) => call.runId)).toEqual(["run_1", "run_2"])
  })

  test("follows the run T3 continues a restarted run with", async () => {
    const { t3, session, runner } = setup()
    t3.script("run_1", [{ status: "running", runId: "run_2" }])
    t3.script("run_2", [
      { status: "completed", items: [item(1, "assistant_message", { runId: "run_2", text: "Back and done." })] },
    ])

    await runner.deliverTurn(turn())
    await session.settled()

    expect(session.replies).toEqual([{ invocationId: "binv_1", text: "Back and done." }])
  })

  test("/stop interrupts the open run and drops its reply", async () => {
    const { t3, session, runner } = setup()
    t3.script("run_1", [{ status: "running" }])
    await runner.deliverTurn(turn())
    await idle()

    runner.interrupt("stream_root")
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "Done" })] }])
    await idle()

    expect(t3.callsOf("t3_thread_interrupt")).toEqual([
      { threadId: "thread_1", runId: "run_1", reason: "Stopped from Threa" },
    ])
    expect(runner.hasOpenTurns()).toBe(false)
    expect({ replies: session.replies, fails: session.fails }).toEqual({ replies: [], fails: [] })
  })

  test("/stop also interrupts a steer T3 queued as its own run", async () => {
    const { t3, runner } = setup()
    t3.script("run_1", [{ status: "running" }])
    await runner.deliverTurn(turn())
    await idle()
    t3.steerAs("queued")
    await runner.steer("also the docs", "stream_root", [])

    runner.interrupt("stream_root")
    await idle()

    expect(t3.callsOf("t3_thread_interrupt")).toEqual([
      { threadId: "thread_1", runId: "run_1", reason: "Stopped from Threa" },
      { threadId: "thread_1", runId: "run_2", reason: "Stopped from Threa" },
    ])
  })

  test("/stop during admission stops the run once T3 names it", async () => {
    const { t3, session, runner } = setup()
    const release = t3.holdNext("t3_thread_launch")
    const delivering = runner.deliverTurn(turn())
    await idle()
    expect(runner.hasOpenTurns("stream_root")).toBe(true)

    runner.interrupt("stream_root")
    release()
    await delivering
    await idle()

    expect(t3.callsOf("t3_thread_interrupt")).toEqual([
      { threadId: "thread_1", runId: "run_1", reason: "Stopped from Threa" },
    ])
    expect(t3.callsOf("t3_thread_wait")).toEqual([])
    expect({ replies: session.replies, fails: session.fails }).toEqual({ replies: [], fails: [] })
  })
})

describe("RunTrace", () => {
  const command = item(1, "command_execution", { text: "$ bun test\n3 pass" })
  const fileChange = item(1, "file_change", { text: "src/config.ts\n+ const x = 1" })

  test.each<[RunTraceMode, typeof command, { headline: string; sections: unknown[] }]>([
    ["headline", command, { headline: "Shell command", sections: [] }],
    ["commands", command, { headline: "bun test", sections: [{ label: "Details", body: "bun test", lang: "bash" }] }],
    [
      "full",
      command,
      {
        headline: "bun test",
        sections: [{ label: "Output", body: "$ bun test\n3 pass", lang: null }],
      },
    ],
    [
      "headline",
      item(1, "command_execution", { title: "Read ~/.ssh/config", text: "$ cat ~/.ssh/config" }),
      {
        headline: "Shell command",
        sections: [],
      },
    ],
    ["commands", fileChange, { headline: "File change: config.ts", sections: [] }],
    [
      "full",
      fileChange,
      { headline: "File change: config.ts", sections: [{ label: "Details", body: fileChange.text, lang: null }] },
    ],
  ])("%s mode traces case %#", (mode, traced, expected) => {
    const [frame] = new RunTrace("run_1", mode).observe(traced)
    expect(traceOf(frame!.content)).toEqual(expected)
  })

  test.each<[RunTraceMode, string]>([
    ["headline", "Subagent"],
    ["commands", "Subagent: Audit the parser"],
  ])("%s mode titles a subagent", (mode, headline) => {
    const [frame] = new RunTrace("run_1", mode).observe(
      item(1, "subagent", { title: "Audit the parser", text: "Read src/parser.ts and list its bugs." })
    )
    expect(traceOf(frame!.content)).toEqual({ headline, sections: [] })
  })

  test("counts a todo list's finished steps without showing them", () => {
    const [frame] = new RunTrace("run_1", "commands").observe(
      item(1, "todo_list", { text: "[completed] Read the spec\n[inProgress] Write the parser\n[pending] Test it" })
    )
    expect(traceOf(frame!.content)).toEqual({ headline: "Todo list: 1/3 done", sections: [] })
  })

  test("chips a running tool by its type, and anything else as working", () => {
    const trace = new RunTrace("run_1", "commands")
    trace.observe(item(1, "file_change", { status: "running", text: "src/parser.ts" }))
    const editing = trace.statusText
    trace.observe(item(1, "file_change", { text: "src/parser.ts" }))
    expect([editing, trace.statusText]).toEqual(["Editing files…", "Working in T3 Code…"])
  })

  test("keeps the chip of a tool still running when a later one ends", () => {
    const trace = new RunTrace("run_1", "commands")
    trace.observe(item(1, "command_execution", { status: "running", text: "$ bun test" }))
    trace.observe(item(2, "web_search", { status: "running", text: "bun docs" }))
    const searching = trace.statusText
    trace.observe(item(2, "web_search", { text: "bun docs" }))
    expect([searching, trace.statusText]).toEqual(["Searching the web…", "Running a command…"])
  })

  test("ignores other runs and items it already finalized", () => {
    const trace = new RunTrace("run_1", "commands")
    expect(trace.observe(item(1, "command_execution", { runId: "run_0", text: "$ ls" }))).toEqual([])
    expect(trace.observe(item(2, "command_execution", { text: "$ ls" }))).toEqual([
      expect.objectContaining({ stepType: "tool_call", clientStepId: expect.any(String) }),
    ])
    expect(trace.observe(item(2, "command_execution", { text: "$ ls" }))).toEqual([])
  })
})

describe("runs T3 starts by itself", () => {
  const LINKED: ThreadState = { threads: { stream_root: "thread_1" }, model: MODEL }

  for (const delivered of ["run_1", "run_3"]) {
    test(`should order a silent failure before a newer reply after restart (delivered: ${delivered})`, async () => {
      const { t3, session, runner, saved } = setup({
        state: { ...LINKED, delivered: { thread_1: delivered } },
      })
      t3.startInT3("thread_1")
      t3.addItems("thread_1", [item(1, "assistant_message", { text: "First." })])
      t3.endInT3("run_1")
      t3.startInT3("thread_1")
      t3.script("run_2", [{ status: "failed" }])
      await t3.client.call("t3_thread_wait", { threadId: "thread_1", runId: "run_2", timeoutMs: 2000 })
      t3.startInT3("thread_1")
      t3.addItems("thread_1", [item(2, "assistant_message", { runId: "run_3", text: "Third." })])
      t3.endInT3("run_3")

      await runner.watch()
      await until(() => !runner.busy)
      await runner.watch()

      expect({ posts: session.posts, delivered: saved.at(-1)?.delivered ?? { thread_1: delivered } }).toEqual({
        posts:
          delivered === "run_1"
            ? [
                { streamId: "stream_root", text: "The T3 Code run failed.", clientMessageId: "t3run-run_2" },
                { streamId: "stream_root", text: "Third.", clientMessageId: "t3run-run_3" },
              ]
            : [],
        delivered: { thread_1: "run_3" },
      })
    })
  }

  test("should leave an empty thread and terminal history alone when no run is active", async () => {
    const { t3, session, runner } = setup({ state: LINKED })
    await runner.watch()
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(1, "assistant_message", { text: "Old reply." })])
    t3.endInT3("run_1")
    const restarted = setup({ state: LINKED, t3 })
    await restarted.runner.watch()
    expect({ posts: [...session.posts, ...restarted.session.posts], waits: t3.callsOf("t3_thread_wait") }).toEqual({
      posts: [],
      waits: [],
    })
  })

  for (const activeHasActivity of [false, true]) {
    test(`should follow an active run before a newer queued run at startup (activity: ${activeHasActivity})`, async () => {
      const { t3, session, runner, saved } = setup({ state: LINKED })
      t3.startInT3("thread_1")
      if (activeHasActivity) t3.addItems("thread_1", [item(1, "command_execution", { text: "$ pwd" })])
      t3.startInT3("thread_1")
      await runner.watch()
      await idle()
      expect(t3.callsOf("t3_thread_wait")).toEqual([{ threadId: "thread_1", runId: "run_1", timeoutMs: 2000 }])
      t3.script("run_1", [{ status: "completed", items: [item(2, "assistant_message", { text: "First." })] }])
      t3.script("run_2", [
        { status: "completed", items: [item(3, "assistant_message", { runId: "run_2", text: "Second." })] },
      ])
      await until(() => !runner.busy)
      await runner.watch()
      expect({
        posts: session.posts,
        sends: t3.callsOf("t3_thread_send"),
        interrupts: t3.callsOf("t3_thread_interrupt"),
        delivered: saved.at(-1)?.delivered,
      }).toEqual({
        posts: [
          { streamId: "stream_root", text: "First.", clientMessageId: "t3run-run_1" },
          { streamId: "stream_root", text: "Second.", clientMessageId: "t3run-run_2" },
        ],
        sends: [],
        interrupts: [],
        delivered: { thread_1: "run_2" },
      })
    })
  }

  test("should discover a silent active run outside the recent runs window", async () => {
    const { t3, session, runner } = setup({ state: LINKED })
    for (let index = 1; index <= 11; index++) t3.startInT3("thread_1")
    await runner.watch()
    await idle()
    expect(t3.callsOf("t3_thread_wait")).toEqual([{ threadId: "thread_1", runId: "run_1", timeoutMs: 2000 }])
    for (let index = 1; index <= 11; index++) {
      t3.script(`run_${index}`, [
        {
          status: "completed",
          items: [item(index, "assistant_message", { runId: `run_${index}`, text: `Reply ${index}.` })],
        },
      ])
    }
    await until(() => !runner.busy)
    await runner.watch()
    expect(session.posts).toEqual(
      Array.from({ length: 11 }, (_, index) => ({
        streamId: "stream_root",
        text: `Reply ${index + 1}.`,
        clientMessageId: `t3run-run_${index + 1}`,
      }))
    )
  })

  for (const activeHasItem of [false, true]) {
    for (const delivered of [undefined, "run_1"]) {
      test(`should retain queued runs outside the recent window (active item: ${activeHasItem}, delivered: ${delivered})`, async () => {
        const { t3, session, runner } = setup({
          state: { ...LINKED, ...(delivered ? { delivered: { thread_1: delivered } } : {}) },
        })
        t3.startInT3("thread_1")
        t3.addItems("thread_1", [item(1, "assistant_message", { runId: "run_1", text: "Historical." })])
        t3.endInT3("run_1")
        for (let index = 2; index <= 14; index++) {
          t3.startInT3("thread_1")
          if (index !== 2 || activeHasItem)
            t3.addItems("thread_1", [item(index, "user_message", { runId: `run_${index}`, text: `Prompt ${index}.` })])
        }
        await runner.watch()
        for (let index = 2; index <= 14; index++) {
          t3.script(`run_${index}`, [
            {
              status: "completed",
              items: [item(index + 14, "assistant_message", { runId: `run_${index}`, text: `Reply ${index}.` })],
            },
          ])
        }
        await until(() => !runner.busy)
        await runner.watch()
        expect(session.posts).toEqual(
          Array.from({ length: 13 }, (_, index) => ({
            streamId: "stream_root",
            text: `Reply ${index + 2}.`,
            clientMessageId: `t3run-run_${index + 2}`,
          }))
        )
      })
    }
  }

  async function settledTurn(
    t3: ReturnType<typeof setup>["t3"],
    session: ReturnType<typeof setup>["session"],
    runner: ReturnType<typeof setup>["runner"]
  ) {
    t3.script("run_1", [
      { status: "completed", items: [item(1, "assistant_message", { text: "Started the agents." })] },
    ])
    await runner.deliverTurn(turn())
    await session.settled()
  }

  test("posts nothing for the run of a /compact", async () => {
    const { t3, session, runner } = setup()
    await settledTurn(t3, session, runner)
    await runner.watch()

    await runner.compact("stream_root", "thread_1")
    t3.script("run_2", [
      { status: "completed", items: [item(2, "assistant_message", { runId: "run_2", text: "Compacted." })] },
    ])
    await runner.watch()
    await until(() => !runner.busy)

    expect(session.posts).toEqual([])
  })

  test("a /compact as the first look at a thread after a restart keeps its earlier runs as history", async () => {
    const { t3, session, runner } = setup({ state: LINKED })
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(1, "assistant_message", { runId: "run_1", text: "Before the restart." })])
    t3.endInT3("run_1")

    await runner.compact("stream_root", "thread_1")
    t3.script("run_2", [{ status: "completed" }])
    t3.script("run_3", [{ status: "completed", items: [item(3, "assistant_message", { text: "After it." })] }])
    await runner.deliverTurn(turn())
    await session.settled()
    await until(() => !runner.busy)

    expect(session.posts).toEqual([])
  })

  test("a /stop before a /compact is sent queues nothing", async () => {
    const { t3, runner } = setup({ state: LINKED })

    const compacting = runner.compact("stream_root", "thread_1")
    runner.interrupt("stream_root")
    await compacting

    expect({ sent: t3.callsOf("t3_thread_send"), open: runner.hasOpenTurns() }).toEqual({ sent: [], open: false })
  })

  test("a /compact T3 refuses rejects and leaves no turn open", async () => {
    const { t3, runner } = setup({ state: LINKED })
    t3.failNext("t3_thread_send", new Error("thread is archived"))

    await expect(runner.compact("stream_root", "thread_1")).rejects.toThrow("thread is archived")
    expect(runner.hasOpenTurns()).toBe(false)
  })

  test("posts the reply of a run started after a turn settled, and never re-posts the turn's own run", async () => {
    const { t3, session, runner } = setup()
    t3.script("run_1", [
      { status: "completed", items: [item(1, "assistant_message", { text: "Started the agents." })] },
    ])
    await runner.deliverTurn(turn())
    await session.settled()
    await runner.watch()

    t3.startInT3("thread_1")
    t3.script("run_2", [
      {
        status: "completed",
        items: [
          item(2, "command_execution", { runId: "run_2", text: "$ cat report.md" }),
          item(3, "assistant_message", { runId: "run_2", text: "The agents found two flaky tests." }),
        ],
      },
    ])
    await runner.watch()
    await until(() => !runner.busy)
    await runner.watch()

    expect({ replies: session.replies, posts: session.posts }).toEqual({
      replies: [{ invocationId: "binv_1", text: "Started the agents." }],
      posts: [{ streamId: "stream_root", text: "The agents found two flaky tests.", clientMessageId: "t3run-run_2" }],
    })
  })

  test("posts its THREA_UPDATE messages as they finish", async () => {
    const { t3, session, runner } = setup()
    await settledTurn(t3, session, runner)
    await runner.watch()
    t3.startInT3("thread_1")
    t3.script("run_2", [
      {
        status: "running",
        items: [
          item(2, "assistant_message", { runId: "run_2", text: "THREA_UPDATE: Agents are back, reading results." }),
          item(3, "command_execution", { runId: "run_2", status: "running", text: "$ cat report.md" }),
        ],
      },
    ])
    await runner.watch()
    await until(() => session.posts.length > 0)
    t3.script("run_2", [
      { status: "completed", items: [item(4, "assistant_message", { runId: "run_2", text: "Two flaky tests." })] },
    ])
    await until(() => !runner.busy)

    expect(session.posts).toEqual([
      { streamId: "stream_root", text: "Agents are back, reading results.", clientMessageId: "t3upd-turn-item:2" },
      { streamId: "stream_root", text: "Two flaky tests.", clientMessageId: "t3run-run_2" },
    ])
  })

  test("an image steered into a run it follows takes the run over without posting its updates again", async () => {
    const { t3, session, runner } = setup()
    await settledTurn(t3, session, runner)
    await runner.watch()
    t3.startInT3("thread_1")
    t3.script("run_2", [
      {
        status: "running",
        items: [
          item(2, "assistant_message", { runId: "run_2", text: "THREA_UPDATE: Agents are back." }),
          item(3, "command_execution", { runId: "run_2", status: "running", text: "$ cat report.md" }),
        ],
      },
    ])
    await runner.watch()
    await until(() => session.posts.length > 0)

    const delivered = runner.deliverTurn(
      turn({ invocationId: "binv_2", content: "Also this", attachments: [downloaded("cat.png", "image/png", "png")] })
    )
    await until(() => t3.calls.filter((call) => call.name === "t3_thread_wait").length === 4)
    t3.script("run_2", [
      {
        status: "completed",
        items: [
          item(3, "command_execution", { runId: "run_2", text: "$ cat report.md" }),
          item(4, "assistant_message", { runId: "run_2", text: "Two flaky tests, the cat too." }),
        ],
      },
    ])
    await delivered
    await session.settled()

    expect({ posts: session.posts, interims: session.interims, reply: session.replies.at(-1) }).toEqual({
      posts: [{ streamId: "stream_root", text: "Agents are back.", clientMessageId: "t3upd-turn-item:2" }],
      interims: [],
      reply: { invocationId: "binv_2", text: "Two flaky tests, the cat too." },
    })
  })

  test("posts the reply of a run a restart cut off from its turn, but not the updates the turn already posted", async () => {
    const { t3, session, runner } = setup({ state: LINKED })
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [
      item(1, "assistant_message", { text: "THREA_UPDATE: Posted by the turn." }),
      item(2, "command_execution", { title: "bun test" }),
    ])
    t3.script("run_1", [{ status: "running" }])
    await runner.watch()
    await idle()
    t3.script("run_1", [
      {
        status: "completed",
        items: [
          item(3, "assistant_message", { text: "THREA_UPDATE: Tests pass." }),
          item(4, "command_execution", { title: "git push" }),
          item(5, "assistant_message", { text: "Pushed." }),
        ],
      },
    ])
    await until(() => !runner.busy)

    expect(session.posts).toEqual([
      { streamId: "stream_root", text: "Tests pass.", clientMessageId: "t3upd-turn-item:3" },
      { streamId: "stream_root", text: "Pushed.", clientMessageId: "t3run-run_1" },
    ])
  })

  test("follows the images of the first message after a restart into the cut-off run without reposting its updates", async () => {
    const { t3, session, runner } = setup({ state: LINKED })
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [
      item(1, "assistant_message", { text: "THREA_UPDATE: Posted by the turn." }),
      item(2, "command_execution", { title: "bun test" }),
    ])
    t3.script("run_1", [{ status: "completed", items: [item(3, "assistant_message", { text: "Done." })] }])
    await runner.deliverTurn(turn({ attachments: [downloaded("cat.png", "image/png", "png-bytes")] }))
    await session.settled()

    expect({ interims: session.interims, reply: session.replies.at(-1), posts: session.posts }).toEqual({
      interims: [],
      reply: { invocationId: "binv_1", text: "Done." },
      posts: [],
    })
  })

  test("posts an update the cut-off run finished after the first look", async () => {
    const { t3, session, runner } = setup({ state: LINKED })
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(1, "command_execution", { title: "bun test" })])
    const release = t3.holdNext("t3_thread_wait")
    await runner.watch()
    await idle()
    t3.addItems("thread_1", [
      item(2, "assistant_message", { text: "THREA_UPDATE: Tests pass." }),
      item(3, "command_execution", { title: "git push" }),
    ])
    t3.script("run_1", [{ status: "completed", items: [item(4, "assistant_message", { text: "Pushed." })] }])
    release()
    await until(() => !runner.busy)

    expect(session.posts).toEqual([
      { streamId: "stream_root", text: "Tests pass.", clientMessageId: "t3upd-turn-item:2" },
      { streamId: "stream_root", text: "Pushed.", clientMessageId: "t3run-run_1" },
    ])
  })

  test("should follow a run waiting on a question after restart", async () => {
    const { t3, session, runner } = setup({ state: LINKED })
    t3.startInT3("thread_1")
    t3.script("run_1", [{ status: "waiting" }])
    await t3.client.call("t3_thread_wait", { threadId: "thread_1", runId: "run_1", timeoutMs: 0 })
    await runner.watch()
    await idle()

    expect({ busy: runner.busy, posts: session.posts }).toEqual({ busy: true, posts: [] })
    runner.shutdown()
  })

  test("posts the final message of a run that ended while the connector was down, and records it delivered", async () => {
    const { t3, session, saved, runner } = setup({ state: { ...LINKED, delivered: { thread_1: "run_1" } } })
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(1, "assistant_message", { text: "Posted before the restart." })])
    t3.endInT3("run_1")
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [
      item(2, "assistant_message", { runId: "run_2", text: "THREA_UPDATE: Tests pass." }),
      item(3, "assistant_message", { runId: "run_2", text: "Pushed." }),
    ])
    t3.endInT3("run_2")
    await runner.watch()
    await until(() => !runner.busy)
    await runner.watch()

    expect({ posts: session.posts, delivered: saved.at(-1)?.delivered }).toEqual({
      posts: [{ streamId: "stream_root", text: "Pushed.", clientMessageId: "t3run-run_2" }],
      delivered: { thread_1: "run_2" },
    })
  })

  test("keeps the delivered mark before a run whose relay gave up", async () => {
    const { t3, session, saved, runner } = setup({ state: { ...LINKED, delivered: { thread_1: "run_1" } } })
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(1, "assistant_message", { text: "Posted before the restart." })])
    t3.endInT3("run_1")
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(2, "assistant_message", { runId: "run_2", text: "Pushed." })])
    t3.endInT3("run_2")
    t3.failNext("t3_thread_wait", new T3AuthError("Run `threa-t3code login`"))
    await runner.watch()
    await until(() => !runner.busy)

    expect({ posts: session.posts, state: saved.at(-1) }).toEqual({
      posts: [],
      state: {
        ...LINKED,
        delivered: { thread_1: "run_1" },
        owed: { thread_1: ["run_2"] },
        attachments: { thread_1: { run_2: expect.any(String) } },
      },
    })
    await runner.watch()
    await until(() => !runner.busy)
    expect(session.posts).toEqual([{ streamId: "stream_root", text: "Pushed.", clientMessageId: "t3run-run_2" }])
  })

  test("should recover an owed run before later background output without replay after restart", async () => {
    const { t3, session, saved, runner } = setup({ state: { ...LINKED, delivered: { thread_1: "run_1" } } })
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(1, "assistant_message", { text: "Posted before the restart." })])
    t3.endInT3("run_1")
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(2, "assistant_message", { runId: "run_2", text: "Pushed." })])
    t3.endInT3("run_2")
    t3.failNext("t3_thread_wait", new T3AuthError("Run `threa-t3code login`"))
    await runner.watch()
    await until(() => !runner.busy)
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(3, "assistant_message", { runId: "run_3", text: "Deployed." })])
    t3.endInT3("run_3")
    await runner.watch()
    await until(() => !runner.busy)
    await runner.watch()
    const restarted = setup({ state: saved.at(-1), t3 })
    await restarted.runner.watch()
    await until(() => !restarted.runner.busy)
    await restarted.runner.watch()

    expect({
      posts: session.posts,
      state: saved.at(-1),
      restartedPosts: restarted.session.posts,
      restartedDelivered: restarted.saved.at(-1)?.delivered,
    }).toEqual({
      posts: [
        { streamId: "stream_root", text: "Pushed.", clientMessageId: "t3run-run_2" },
        { streamId: "stream_root", text: "Deployed.", clientMessageId: "t3run-run_3" },
      ],
      state: {
        ...LINKED,
        delivered: { thread_1: "run_1" },
        posted: { thread_1: ["run_2", "run_3"] },
        owed: undefined,
        attachments: {},
      },
      restartedPosts: [],
      restartedDelivered: { thread_1: "run_3" },
    })
  })

  test("a turn that replies while a run is still owed is not posted again after a restart", async () => {
    const { t3, session, saved, runner } = setup({ state: { ...LINKED, delivered: { thread_1: "run_1" } } })
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(1, "assistant_message", { text: "Posted before the restart." })])
    t3.endInT3("run_1")
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(2, "assistant_message", { runId: "run_2", text: "Pushed." })])
    t3.endInT3("run_2")
    const recover = refuseRunWait(t3, "run_2")
    await runner.watch()
    await until(() => !runner.busy)
    t3.script("run_3", [
      { status: "completed", items: [item(3, "assistant_message", { runId: "run_3", text: "Docs done." })] },
    ])
    await runner.deliverTurn(turn({ invocationId: "binv_2", content: "Now the docs" }))
    await session.settled()
    await idle()
    recover()
    const restarted = setup({ state: saved.at(-1), t3 })
    await restarted.runner.watch()
    await until(() => !restarted.runner.busy)

    expect({
      replies: session.replies,
      state: saved.at(-1),
      restartedPosts: restarted.session.posts,
      restartedReplies: restarted.session.replies,
    }).toEqual({
      replies: [{ invocationId: "binv_2", text: "Docs done." }],
      state: {
        ...LINKED,
        delivered: { thread_1: "run_1" },
        posted: { thread_1: ["run_3"] },
        owed: { thread_1: ["run_2"] },
        attachments: { thread_1: { run_2: expect.any(String) } },
      },
      restartedPosts: [{ streamId: "stream_root", text: "Pushed.", clientMessageId: "t3run-run_2" }],
      restartedReplies: [],
    })
  })

  test("a turn whose run T3 continued as a new one is not posted again after a restart", async () => {
    const { t3, session, saved, runner } = setup({ state: { ...LINKED, delivered: { thread_1: "run_1" } } })
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(1, "assistant_message", { text: "Posted before the restart." })])
    t3.endInT3("run_1")
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(2, "assistant_message", { runId: "run_2", text: "Pushed." })])
    t3.endInT3("run_2")
    const recover = refuseRunWait(t3, "run_2")
    await runner.watch()
    await until(() => !runner.busy)
    t3.script("run_3", [{ status: "running", runId: "run_4" }])
    t3.script("run_4", [
      { status: "completed", items: [item(3, "assistant_message", { runId: "run_4", text: "Docs done." })] },
    ])
    await runner.deliverTurn(turn({ invocationId: "binv_2", content: "Now the docs" }))
    await session.settled()
    await idle()
    t3.endInT3("run_3")
    recover()
    const restarted = setup({ state: saved.at(-1), t3 })
    await restarted.runner.watch()
    await until(() => !restarted.runner.busy)

    expect({
      replies: session.replies,
      posted: saved.at(-1)?.posted,
      restartedPosts: restarted.session.posts,
    }).toEqual({
      replies: [{ invocationId: "binv_2", text: "Docs done." }],
      posted: { thread_1: ["run_3", "run_4"] },
      restartedPosts: [{ streamId: "stream_root", text: "Pushed.", clientMessageId: "t3run-run_2" }],
    })
  })

  test("records each relayed run delivered as it posts, up to the one its relay gave up on", async () => {
    const { t3, session, saved, runner } = setup({ state: { ...LINKED, delivered: { thread_1: "run_1" } } })
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(1, "assistant_message", { text: "Posted before the restart." })])
    t3.endInT3("run_1")
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(2, "assistant_message", { runId: "run_2", text: "Pushed." })])
    t3.endInT3("run_2")
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(3, "assistant_message", { runId: "run_3", text: "Deployed." })])
    t3.endInT3("run_3")
    const call = t3.client.call
    t3.client.call = (async <K extends T3ToolName>(name: K, args: T3Tools[K]["args"]) => {
      if (name === "t3_thread_wait" && (args as { runId?: string }).runId === "run_3")
        throw new T3AuthError("Run `threa-t3code login`")
      return call(name, args)
    }) as typeof call
    await runner.watch()
    await until(() => !runner.busy)
    await runner.watch()

    expect({ posts: session.posts, delivered: saved.at(-1)?.delivered }).toEqual({
      posts: [{ streamId: "stream_root", text: "Pushed.", clientMessageId: "t3run-run_2" }],
      delivered: { thread_1: "run_2" },
    })
  })

  test("a run that posts nothing leaves the delivered mark before a run whose relay gave up", async () => {
    const { t3, session, saved, runner } = setup({ state: { ...LINKED, delivered: { thread_1: "run_1" } } })
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(1, "assistant_message", { text: "Posted before the restart." })])
    t3.endInT3("run_1")
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(2, "assistant_message", { runId: "run_2", text: "Pushed." })])
    t3.endInT3("run_2")
    const recover = refuseRunWait(t3, "run_2")
    await runner.watch()
    await until(() => !runner.busy)
    await runner.compact("stream_root", "thread_1")
    t3.script("run_3", [{ status: "completed" }])
    await runner.watch()
    await until(() => !runner.busy)
    await runner.watch()
    await until(() => !runner.busy)
    recover()

    expect({ posts: session.posts, state: saved.at(-1) }).toEqual({
      posts: [],
      state: {
        ...LINKED,
        delivered: { thread_1: "run_1" },
        owed: { thread_1: ["run_2"] },
        attachments: { thread_1: { run_2: expect.any(String) } },
      },
    })
  })

  test("records a turn's run delivered once it replies", async () => {
    const { t3, session, saved, runner } = setup()
    await settledTurn(t3, session, runner)
    await idle()

    expect(saved.at(-1)).toEqual({
      threads: { stream_root: "thread_1" },
      model: MODEL,
      delivered: { thread_1: "run_1" },
    })
  })

  test("records nothing delivered while a turn's reply is still posting", async () => {
    const { t3, session, saved, runner } = setup()
    const { reply } = session.session
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    session.session.reply = async (...args) => {
      await held
      return reply(...args)
    }
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "Done." })] }])
    await runner.deliverTurn(turn())
    await until(() => !runner.hasOpenTurns())
    await runner.watch()
    const whilePosting = saved.at(-1)?.delivered
    release()
    await session.settled()
    await idle()

    expect({ whilePosting, after: saved.at(-1)?.delivered }).toEqual({
      whilePosting: undefined,
      after: { thread_1: "run_1" },
    })
  })

  test("a turn's reply posting after a later relayed run leaves the mark on the later run", async () => {
    const { t3, session, saved, runner } = setup()
    const { reply } = session.session
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    session.session.reply = async (...args) => {
      await held
      return reply(...args)
    }
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "Done." })] }])
    await runner.deliverTurn(turn())
    await until(() => !runner.hasOpenTurns())
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(2, "assistant_message", { runId: "run_2", text: "Pushed." })])
    t3.endInT3("run_2")
    await runner.watch()
    await until(() => session.posts.length > 0)
    release()
    await session.settled()
    await idle()

    expect({ posts: session.posts, delivered: saved.at(-1)?.delivered }).toEqual({
      posts: [{ streamId: "stream_root", text: "Pushed.", clientMessageId: "t3run-run_2" }],
      delivered: { thread_1: "run_2" },
    })
  })

  test("a turn's reply moves the mark while a relay posts a run queued after it", async () => {
    const { t3, session, saved, runner } = setup()
    const { reply } = session.session
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    session.session.reply = async (...args) => {
      await held
      return reply(...args)
    }
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "Done." })] }])
    await runner.deliverTurn(turn())
    await until(() => !runner.hasOpenTurns())
    t3.startInT3("thread_1")
    await runner.watch()
    release()
    await session.settled()
    await idle()

    expect({ relaying: runner.busy, delivered: saved.at(-1)?.delivered }).toEqual({
      relaying: true,
      delivered: { thread_1: "run_1" },
    })
  })

  test("a turn admitted while the previous turn's reply posts still records its run delivered", async () => {
    const { t3, session, saved, runner } = setup()
    const { reply } = session.session
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    session.session.reply = async (invocationId, text) => {
      if (invocationId === "binv_1") await held
      return reply(invocationId, text)
    }
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "Done." })] }])
    await runner.deliverTurn(turn())
    await until(() => !runner.hasOpenTurns())
    t3.script("run_2", [{ status: "running" }])
    await runner.deliverTurn(turn({ invocationId: "binv_2", content: "Now the docs" }))
    release()
    await until(() => saved.at(-1)?.delivered?.thread_1 === "run_1")
    t3.script("run_2", [{ status: "completed", items: [item(2, "assistant_message", { text: "Docs done." })] }])
    await session.settled()
    await idle()

    expect(saved.at(-1)?.delivered).toEqual({ thread_1: "run_2" })
  })

  test("a turn's reply leaves the mark while a relay of a run queued ahead of it posts the run that continues it", async () => {
    const { t3, session, saved, runner } = setup({ state: { ...LINKED, delivered: { thread_1: "run_1" } } })
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(1, "assistant_message", { text: "Posted before the restart." })])
    t3.endInT3("run_1")
    t3.startInT3("thread_1")
    t3.script("run_2", [{ status: "running" }])
    await runner.watch()
    await until(() => runner.busy)
    t3.script("run_3", [
      { status: "completed", items: [item(2, "assistant_message", { runId: "run_3", text: "Docs done." })] },
    ])
    await runner.deliverTurn(turn({ invocationId: "binv_2", content: "Now the docs" }))
    t3.script("run_2", [{ status: "running", runId: "run_4" }])
    t3.script("run_4", [{ status: "running" }])
    await session.settled()
    await idle()

    expect({ replies: session.replies, state: saved.at(-1) }).toEqual({
      replies: [{ invocationId: "binv_2", text: "Docs done." }],
      state: {
        ...LINKED,
        delivered: { thread_1: "run_1" },
        posted: { thread_1: ["run_3"] },
        owed: { thread_1: ["run_2"] },
        attachments: { thread_1: { run_2: expect.any(String) } },
      },
    })
  })

  test("a /clear while the reply posts leaves no delivered run for the thread", async () => {
    const { t3, session, saved, runner } = setup()
    const { reply } = session.session
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    session.session.reply = async (...args) => {
      await held
      return reply(...args)
    }
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "Done." })] }])
    await runner.deliverTurn(turn())
    await until(() => !runner.hasOpenTurns())
    runner.forgetThread("stream_root")
    release()
    await session.settled()
    await idle()

    expect(saved.at(-1)).toEqual({ threads: {}, model: MODEL, delivered: {}, posted: {} })
  })

  test("should follow a waiting run after the last one delivered", async () => {
    const { t3, session, runner } = setup({ state: { ...LINKED, delivered: { thread_1: "run_1" } } })
    t3.startInT3("thread_1")
    t3.endInT3("run_1")
    t3.startInT3("thread_1")
    t3.script("run_2", [{ status: "waiting" }])
    await t3.client.call("t3_thread_wait", { threadId: "thread_1", runId: "run_2", timeoutMs: 0 })
    await runner.watch()
    await idle()

    expect({ busy: runner.busy, posts: session.posts }).toEqual({ busy: true, posts: [] })
    runner.shutdown()
  })

  test("posts nothing for runs that ended before the first look", async () => {
    const { t3, session, runner } = setup({ state: LINKED })
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(1, "assistant_message", { text: "Before the restart." })])
    t3.endInT3("run_1")
    await runner.watch()
    await idle()

    expect({ busy: runner.busy, posts: session.posts }).toEqual({ busy: false, posts: [] })
  })

  test("posts nothing outside a turn to a stream Threa says is end-to-end encrypted", async () => {
    const { t3, session, runner } = setup({ state: LINKED })
    session.encrypted.add("stream_root")
    t3.startInT3("thread_1")
    t3.script("run_1", [
      { status: "completed", items: [item(1, "assistant_message", { text: "Cut off before the restart." })] },
    ])
    await runner.watch()
    await idle()

    expect({ busy: runner.busy, posts: session.posts }).toEqual({ busy: false, posts: [] })
  })

  test("posts nothing outside a turn to a stream a sealed message came from", async () => {
    const { t3, session, runner } = setup({ state: LINKED })
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "Sealed reply." })] }])
    await runner.deliverTurn(turn({ sealed: true }))
    await session.settled()
    t3.startInT3("thread_1")
    t3.script("run_2", [
      { status: "completed", items: [item(2, "assistant_message", { runId: "run_2", text: "Secret findings." })] },
    ])
    await runner.watch()
    await idle()

    expect({ busy: runner.busy, posts: session.posts }).toEqual({ busy: false, posts: [] })
  })

  test("stays busy while the run goes, and posts nothing for a silent reply", async () => {
    const { t3, session, runner } = setup()
    await settledTurn(t3, session, runner)
    t3.startInT3("thread_1")
    await runner.watch()
    await idle()
    const busyWhileRunning = runner.busy

    t3.script("run_2", [
      { status: "completed", items: [item(2, "assistant_message", { runId: "run_2", text: "THREA_NO_RESPONSE" })] },
    ])
    await until(() => !runner.busy)

    expect({ busyWhileRunning, posts: session.posts }).toEqual({ busyWhileRunning: true, posts: [] })
  })

  test("posts why a run it started failed", async () => {
    const { t3, session, runner } = setup()
    await settledTurn(t3, session, runner)
    t3.startInT3("thread_1")
    t3.script("run_2", [
      { status: "failed", items: [item(2, "error", { runId: "run_2", text: "Provider quota exceeded" })] },
    ])
    await runner.watch()
    await until(() => !runner.busy)

    expect(session.posts).toEqual([
      { streamId: "stream_root", text: "Provider quota exceeded", clientMessageId: "t3run-run_2" },
    ])
  })

  test("forgets a thread deleted in T3 instead of watching it", async () => {
    const { t3, session, runner } = setup()
    await settledTurn(t3, session, runner)
    const readsAfterTurn = t3.callsOf("t3_thread_read").length
    t3.failNext("t3_thread_read", new T3ToolError("t3_thread_read", "thread_not_found", "not found"))
    await runner.watch()
    await runner.watch()

    expect({ thread: runner.threadFor("stream_root"), reads: t3.callsOf("t3_thread_read").length }).toEqual({
      thread: undefined,
      reads: readsAfterTurn + 1,
    })
  })

  test("posts a run T3 started just before a message queued behind it", async () => {
    const { t3, session, runner } = setup()
    await settledTurn(t3, session, runner)
    t3.startInT3("thread_1")
    t3.script("run_2", [
      { status: "completed", items: [item(2, "assistant_message", { runId: "run_2", text: "Agents done." })] },
    ])
    t3.script("run_3", [
      { status: "completed", items: [item(3, "assistant_message", { runId: "run_3", text: "Docs updated." })] },
    ])
    await runner.deliverTurn(turn({ invocationId: "binv_2", content: "Now the docs" }))
    await session.settled()
    await until(() => !runner.busy)

    expect({ posts: session.posts, reply: session.replies.at(-1) }).toEqual({
      posts: [{ streamId: "stream_root", text: "Agents done.", clientMessageId: "t3run-run_2" }],
      reply: { invocationId: "binv_2", text: "Docs updated." },
    })
  })

  test("leaves a run it follows to the turn whose images restarted it", async () => {
    const { t3, session, runner } = setup()
    await settledTurn(t3, session, runner)
    t3.steerAs("started")
    t3.startInT3("thread_1")
    await runner.watch()
    await idle()

    await runner.deliverTurn(
      turn({ invocationId: "binv_2", attachments: [downloaded("cat.png", "image/png", "png-bytes")] })
    )
    await idle()
    t3.script("run_2", [{ status: "running", runId: "run_3" }])
    await idle()
    t3.script("run_3", [
      { status: "completed", items: [item(3, "assistant_message", { runId: "run_3", text: "A cat." })] },
    ])
    await session.settled()
    await until(() => !runner.busy)

    expect({ busy: runner.busy, posts: session.posts, reply: session.replies.at(-1) }).toEqual({
      busy: false,
      posts: [],
      reply: { invocationId: "binv_2", text: "A cat." },
    })
  })

  test("posts each run T3 started between two looks, in order", async () => {
    const { t3, session, runner } = setup()
    await settledTurn(t3, session, runner)
    t3.startInT3("thread_1")
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [
      item(2, "user_message", { runId: "run_2", text: "Agent A is done" }),
      item(3, "user_message", { runId: "run_3", text: "Agent B is done" }),
    ])
    t3.script("run_2", [
      { status: "completed", items: [item(4, "assistant_message", { runId: "run_2", text: "A found a leak." })] },
    ])
    t3.script("run_3", [
      { status: "completed", items: [item(5, "assistant_message", { runId: "run_3", text: "B found nothing." })] },
    ])
    await runner.watch()
    await until(() => !runner.busy)

    expect(session.posts).toEqual([
      { streamId: "stream_root", text: "A found a leak.", clientMessageId: "t3run-run_2" },
      { streamId: "stream_root", text: "B found nothing.", clientMessageId: "t3run-run_3" },
    ])
  })

  test("posts a run a message queued behind while it relays another", async () => {
    const { t3, session, runner } = setup()
    await settledTurn(t3, session, runner)
    t3.startInT3("thread_1")
    t3.script("run_2", [
      { status: "running", items: [item(2, "command_execution", { runId: "run_2", status: "running" })] },
    ])
    await runner.watch()
    await idle()
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(3, "user_message", { runId: "run_3", text: "Agent B is done" })])
    t3.script("run_3", [
      { status: "completed", items: [item(4, "assistant_message", { runId: "run_3", text: "B found nothing." })] },
    ])
    await runner.deliverTurn(turn({ invocationId: "binv_2", content: "Now the docs" }))
    t3.script("run_4", [
      { status: "completed", items: [item(5, "assistant_message", { runId: "run_4", text: "Docs updated." })] },
    ])
    await session.settled()
    t3.script("run_2", [
      { status: "completed", items: [item(6, "assistant_message", { runId: "run_2", text: "A found a leak." })] },
    ])
    await until(() => !runner.busy)

    expect({ posts: session.posts, reply: session.replies.at(-1) }).toEqual({
      posts: [
        { streamId: "stream_root", text: "A found a leak.", clientMessageId: "t3run-run_2" },
        { streamId: "stream_root", text: "B found nothing.", clientMessageId: "t3run-run_3" },
      ],
      reply: { invocationId: "binv_2", text: "Docs updated." },
    })
  })

  test("posts a run T3 started and finished while a turn read past it", async () => {
    const { t3, session, runner } = setup()
    await settledTurn(t3, session, runner)
    await runner.deliverTurn(turn({ invocationId: "binv_2", content: "Now the docs" }))
    t3.startInT3("thread_1")
    t3.startInT3("thread_1")
    t3.script("run_2", [
      {
        status: "completed",
        items: [
          item(2, "assistant_message", { runId: "run_3", text: "B found nothing." }),
          item(3, "user_message", { runId: "run_4", text: "Agent C is done" }),
          item(4, "assistant_message", { runId: "run_2", text: "Docs updated." }),
        ],
      },
    ])
    t3.script("run_3", [{ status: "completed" }])
    t3.script("run_4", [
      { status: "completed", items: [item(5, "assistant_message", { runId: "run_4", text: "C found a leak." })] },
    ])
    await session.settled()
    await runner.watch()
    await until(() => !runner.busy)

    expect({ posts: session.posts, reply: session.replies.at(-1) }).toEqual({
      posts: [
        { streamId: "stream_root", text: "B found nothing.", clientMessageId: "t3run-run_3" },
        { streamId: "stream_root", text: "C found a leak.", clientMessageId: "t3run-run_4" },
      ],
      reply: { invocationId: "binv_2", text: "Docs updated." },
    })
  })

  test("/stop while a message is admitted still posts the run it queued behind", async () => {
    const { t3, session, runner } = setup()
    await settledTurn(t3, session, runner)
    t3.startInT3("thread_1")
    t3.script("run_2", [
      { status: "completed", items: [item(2, "assistant_message", { runId: "run_2", text: "Agents done." })] },
    ])
    const release = t3.holdNext("t3_thread_send")
    const delivering = runner.deliverTurn(turn({ invocationId: "binv_2", content: "Now the docs" }))
    await until(() => t3.callsOf("t3_thread_send").length === 1)
    runner.interrupt("stream_root")
    release()
    await delivering
    await until(() => !runner.busy)

    expect({ posts: session.posts, interrupts: t3.callsOf("t3_thread_interrupt") }).toEqual({
      posts: [{ streamId: "stream_root", text: "Agents done.", clientMessageId: "t3run-run_2" }],
      interrupts: [{ threadId: "thread_1", runId: "run_3", reason: "Stopped from Threa" }],
    })
  })

  test("retries a reply whose post failed", async () => {
    const { t3, session, runner } = setup()
    await settledTurn(t3, session, runner)
    t3.startInT3("thread_1")
    t3.script("run_2", [
      { status: "completed", items: [item(2, "assistant_message", { runId: "run_2", text: "Agents done." })] },
    ])
    session.postFailures.push(new Error("socket hang up"))
    await runner.watch()
    await until(() => !runner.busy)

    expect(session.posts).toEqual([{ streamId: "stream_root", text: "Agents done.", clientMessageId: "t3run-run_2" }])
  })

  test("drops an update Threa refuses and still posts the reply", async () => {
    const { t3, session, logs, runner } = setup()
    await settledTurn(t3, session, runner)
    t3.startInT3("thread_1")
    t3.script("run_2", [
      {
        status: "completed",
        items: [
          item(2, "assistant_message", { runId: "run_2", text: "THREA_UPDATE: Halfway there." }),
          item(3, "assistant_message", { runId: "run_2", text: "Agents done." }),
        ],
      },
    ])
    session.postFailures.push(new ThreaApiError("refused", 400, "E2E_STREAM_REQUIRES_CIPHERTEXT"))
    await runner.watch()
    await until(() => !runner.busy)

    expect({
      posts: session.posts,
      dropped: logs.filter((line) => line.startsWith("t3upd-turn-item:2 not posted")).length,
    }).toEqual({
      posts: [{ streamId: "stream_root", text: "Agents done.", clientMessageId: "t3run-run_2" }],
      dropped: 1,
    })
  })

  test("reads a sealed stream past the runs T3 started by itself, and never posts them", async () => {
    const { t3, session, runner } = setup()
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "Started." })] }])
    await runner.deliverTurn(turn({ sealed: true }))
    await session.settled()
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(2, "assistant_message", { runId: "run_2", text: "Secret findings." })])
    t3.script("run_3", [
      { status: "completed", items: [item(3, "assistant_message", { runId: "run_3", text: "Sealed reply." })] },
    ])
    await runner.deliverTurn(turn({ invocationId: "binv_2", sealed: true, content: "Go on" }))
    await session.settled()
    t3.script("run_4", [
      { status: "completed", items: [item(4, "assistant_message", { runId: "run_4", text: "Plain reply." })] },
    ])
    await runner.deliverTurn(turn({ invocationId: "binv_3", content: "And now?" }))
    await session.settled()
    await runner.watch()
    await until(() => !runner.busy)

    const looks = t3.callsOf("t3_thread_read").filter((args) => args.maxCharsPerItem === 1)
    expect({ posts: session.posts, lastLookFrom: looks.at(-1)?.afterPosition }).toEqual({
      posts: [],
      lastLookFrom: 3,
    })
  })

  test("posts a run once when the relay picks it up while it waits in the queue", async () => {
    const { t3, session, runner } = setup()
    await settledTurn(t3, session, runner)
    t3.startInT3("thread_1")
    t3.script("run_2", [
      { status: "running", items: [item(2, "command_execution", { runId: "run_2", status: "running" })] },
    ])
    await runner.watch()
    await idle()
    t3.startInT3("thread_1")
    t3.addItems("thread_1", [item(3, "user_message", { runId: "run_3", text: "Continue" })])
    t3.script("run_4", [
      { status: "completed", items: [item(4, "assistant_message", { runId: "run_4", text: "Docs updated." })] },
    ])
    await runner.deliverTurn(turn({ invocationId: "binv_2", content: "Now the docs" }))
    await session.settled()
    t3.script("run_2", [{ status: "running", runId: "run_3" }])
    t3.script("run_3", [
      { status: "completed", items: [item(5, "assistant_message", { runId: "run_3", text: "Continued answer." })] },
    ])
    await until(() => !runner.busy)

    expect(session.posts).toEqual([
      { streamId: "stream_root", text: "Continued answer.", clientMessageId: "t3run-run_3" },
    ])
  })

  test("/clear stops posting the old thread's run", async () => {
    const { t3, session, runner } = setup()
    await settledTurn(t3, session, runner)
    t3.startInT3("thread_1")
    t3.script("run_2", [
      { status: "running", items: [item(2, "command_execution", { runId: "run_2", status: "running" })] },
    ])
    await runner.watch()
    await idle()
    runner.forgetThread("stream_root")
    t3.script("run_2", [
      { status: "completed", items: [item(3, "assistant_message", { runId: "run_2", text: "Old thread's answer." })] },
    ])
    await until(() => !runner.busy)

    expect(session.posts).toEqual([])
  })

  test("/clear while a look reads the thread posts none of its runs", async () => {
    const { t3, session, runner } = setup()
    await settledTurn(t3, session, runner)
    t3.startInT3("thread_1")
    t3.script("run_2", [
      { status: "completed", items: [item(2, "assistant_message", { runId: "run_2", text: "Old thread's answer." })] },
    ])
    const release = t3.holdNext("t3_thread_read")
    const watching = runner.watch()
    await idle()
    runner.forgetThread("stream_root")
    release()
    await watching
    await until(() => !runner.busy)

    expect(session.posts).toEqual([])
  })

  test("/clear while a relay posts an update stops its reply", async () => {
    const { t3, session, runner } = setup()
    await settledTurn(t3, session, runner)
    t3.startInT3("thread_1")
    t3.script("run_2", [
      {
        status: "completed",
        items: [
          item(2, "assistant_message", { runId: "run_2", text: "THREA_UPDATE: Halfway there." }),
          item(3, "assistant_message", { runId: "run_2", text: "Old thread's answer." }),
        ],
      },
    ])
    const post = session.session.postToInvocation
    session.session.postToInvocation = async (...args) => {
      await post(...args)
      runner.forgetThread("stream_root")
    }
    await runner.watch()
    await until(() => !runner.busy)

    expect(session.posts).toEqual([
      { streamId: "stream_root", text: "Halfway there.", clientMessageId: "t3upd-turn-item:2" },
    ])
  })

  test("archiving while a look reads the thread posts none of its runs", async () => {
    const { t3, session, runner } = setup()
    await settledTurn(t3, session, runner)
    t3.startInT3("thread_1")
    t3.script("run_2", [
      { status: "completed", items: [item(2, "assistant_message", { runId: "run_2", text: "Agents done." })] },
    ])
    const release = t3.holdNext("t3_thread_read")
    const watching = runner.watch()
    await idle()
    runner.shutdown()
    release()
    await watching
    await until(() => !runner.busy)

    expect(session.posts).toEqual([])
  })

  test("a steer T3 folds into a relayed run leaves the turn on its own run", async () => {
    const { t3, session, runner } = setup()
    await settledTurn(t3, session, runner)
    t3.startInT3("thread_1")
    t3.script("run_2", [
      { status: "running", items: [item(2, "command_execution", { runId: "run_2", status: "running" })] },
    ])
    await runner.watch()
    await runner.deliverTurn(turn({ invocationId: "binv_2", content: "Now the docs" }))
    expect(await runner.steer("Also mention the cat", "stream_root", [])).toBe(true)
    // run_3 waits its turn behind run_2, as a T3 wait that times out on a queued run says.
    t3.script("run_3", [{ status: "running" }])
    await idle()
    t3.script("run_2", [
      { status: "completed", items: [item(3, "assistant_message", { runId: "run_2", text: "Leak found, cat too." })] },
    ])
    await until(() => session.posts.length > 0)
    t3.script("run_3", [
      { status: "completed", items: [item(4, "assistant_message", { runId: "run_3", text: "Docs updated." })] },
    ])
    await session.settled()
    await until(() => !runner.busy)

    expect({ posts: session.posts, reply: session.replies.at(-1) }).toEqual({
      posts: [{ streamId: "stream_root", text: "Leak found, cat too.", clientMessageId: "t3run-run_2" }],
      reply: { invocationId: "binv_2", text: "Docs updated." },
    })
  })

  test("a steer T3 folds into a run ahead that nothing relays answers on the turn", async () => {
    const { t3, session, runner } = setup()
    await settledTurn(t3, session, runner)
    t3.startInT3("thread_1")
    t3.script("run_2", [
      { status: "running", items: [item(2, "command_execution", { runId: "run_2", status: "running" })] },
    ])
    await runner.deliverTurn(turn({ invocationId: "binv_2", content: "Now the docs", sealed: true }))
    expect(await runner.steer("Also mention the cat", "stream_root", [])).toBe(true)
    // Nothing waits on run_2, so its items land without a wait, as they do in T3.
    t3.addItems("thread_1", [
      item(2, "command_execution", { runId: "run_2", status: "completed" }),
      item(3, "assistant_message", { runId: "run_2", text: "Cat mentioned." }),
    ])
    t3.script("run_3", [
      { status: "completed", items: [item(4, "assistant_message", { runId: "run_3", text: "Docs updated." })] },
    ])
    await session.settled()
    await until(() => !runner.busy)

    expect({
      posts: session.posts,
      thinking: session.frames().filter((frame) => frame.stepType === "thinking"),
      reply: session.replies.at(-1),
    }).toEqual({
      posts: [],
      thinking: [{ stepType: "thinking", content: "Cat mentioned." }],
      reply: { invocationId: "binv_2", text: "Docs updated." },
    })
  })

  test("archiving while a message is admitted relays none of the runs ahead of it", async () => {
    const { t3, session, runner } = setup()
    await settledTurn(t3, session, runner)
    t3.startInT3("thread_1")
    t3.script("run_2", [
      { status: "completed", items: [item(2, "assistant_message", { runId: "run_2", text: "Agents done." })] },
    ])
    const release = t3.holdNext("t3_thread_send")
    const delivering = runner.deliverTurn(turn({ invocationId: "binv_2", content: "Now the docs" }))
    await until(() => t3.callsOf("t3_thread_send").some((args) => String(args.message).endsWith("\n\nNow the docs")))
    runner.shutdown()
    release()
    await delivering
    await until(() => !runner.busy)

    expect(session.posts).toEqual([])
  })

  test("never posts the runs a forked thread inherits from its source", async () => {
    const { t3, session, runner } = setup()
    await settledTurn(t3, session, runner)
    t3.script("run_2", [
      { status: "completed", items: [item(2, "assistant_message", { runId: "run_2", text: "Looked into it." })] },
    ])
    await runner.deliverTurn(
      turn({ invocationId: "binv_2", streamId: "stream_thread", rootStreamId: "stream_root", content: "Look into it" })
    )
    await session.settled()
    await runner.watch()
    await until(() => !runner.busy)

    expect({ posts: session.posts, reply: session.replies.at(-1) }).toEqual({
      posts: [],
      reply: { invocationId: "binv_2", text: "Looked into it." },
    })
  })
})

describe("T3 delivery reliability", () => {
  test.each([true, false])("should trace renumbered activity when the cursor anchor survives: %p", async (survives) => {
    const { t3, session, runner } = setup()
    const anchor = item(103, "assistant_message", { itemId: "anchor", text: "First." })
    t3.script("run_1", [{ status: "running", items: [anchor] }])
    await runner.deliverTurn(turn())
    await until(() => t3.callsOf("t3_thread_read").some((args) => args.view === "activity"))
    await idle()
    const tools = Array.from({ length: 102 }, (_, index) =>
      item(index + (survives ? 1 : 0), "command_execution", {
        itemId: `new-tool-${index}`,
        text: `$ tool-${index}`,
      })
    )
    t3.script("run_1", [
      {
        status: "completed",
        replaceItems: true,
        items: [
          ...(survives ? [{ ...anchor, position: 0 }] : []),
          ...tools,
          item(104, "assistant_message", { itemId: "final", text: "Done." }),
        ],
      },
    ])
    await session.settled()
    expect({
      tools: session
        .frames()
        .filter((frame) => frame.stepType === "tool_call")
        .map((frame) => frame.content),
      reply: session.replies,
    }).toEqual({
      tools: tools.map((tool) => expect.stringContaining(tool.text!.slice(2))),
      reply: [{ invocationId: "binv_1", text: "Done." }],
    })
    expect(
      session
        .frames()
        .filter((frame) => frame.stepType === "thinking")
        .map((frame) => frame.content)
    ).toEqual(survives ? ["First."] : [])
    runner.shutdown()
  })

  test("should retry a completed reply before recording delivery", async () => {
    const { t3, session, runner, saved } = setup()
    session.replyResults.push({ ok: false, retryable: true, message: "offline" })
    t3.script("run_1", [{ status: "completed", items: [item(0, "assistant_message", { text: "Done." })] }])
    await runner.deliverTurn(turn())
    await session.settled()
    await until(() => !runner.busy)
    expect({
      replies: session.replies,
      mark: saved.at(-1)?.delivered,
      stops: t3.callsOf("t3_thread_interrupt"),
    }).toEqual({
      replies: [{ invocationId: "binv_1", text: "Done." }],
      mark: { thread_1: "run_1" },
      stops: [],
    })
    runner.shutdown()
  })

  test("should leave an exhausted reply owed for restart without stopping its completed run", async () => {
    const { t3, session, runner, saved } = setup()
    session.replyResults.push(
      ...Array.from({ length: 150 }, () => ({ ok: false as const, retryable: true, message: "offline" }))
    )
    t3.script("run_1", [{ status: "completed", items: [item(0, "assistant_message", { text: "Done." })] }])
    await runner.deliverTurn(turn())
    await until(() => !runner.busy)
    expect({
      replies: session.replies,
      mark: saved.at(-1)?.delivered,
      stops: t3.callsOf("t3_thread_interrupt"),
    }).toEqual({ replies: [], mark: undefined, stops: [] })
    runner.shutdown()
    const store = createFileThreadStore(join(mkdtempSync(join(tmpdir(), "t3-owed-")), "threads.json"))
    store.save(saved.at(-1)!)
    const restarted = setup({ t3, state: store.load() })
    await restarted.runner.watch()
    await until(() => !restarted.runner.busy)
    expect(restarted.session.posts).toEqual([
      { streamId: "stream_root", text: "Done.", clientMessageId: "t3run-run_1" },
    ])
    restarted.runner.shutdown()
  })

  test("should show queued state once then running before tool progress", async () => {
    const { t3, session, runner } = setup()
    t3.script("run_1", [
      { status: "queued" },
      { status: "queued" },
      { status: "preparing" },
      { status: "starting" },
      { status: "running" },
      {
        status: "completed",
        items: [item(0, "command_execution", { text: "$ true" }), item(1, "assistant_message", { text: "Done." })],
      },
    ])
    await runner.deliverTurn(turn())
    await session.settled()
    expect(session.frames().map((frame) => (frame.stepType === "thinking" ? frame.content : frame.stepType))).toEqual([
      "Queued in T3 Code, waiting for an earlier run…",
      "Preparing in T3 Code…",
      "Starting in T3 Code…",
      "Working in T3 Code…",
      "tool_call",
    ])
    runner.shutdown()
  })
})

test("should finish an open tool after its timeline positions shrink", async () => {
  const { t3, session, runner } = setup()
  t3.script("run_1", [
    {
      status: "running",
      items: [
        item(102, "system_notice", { itemId: "anchor", text: "Preparing." }),
        item(103, "command_execution", { itemId: "tool", status: "running", text: "$ true" }),
      ],
    },
  ])
  await runner.deliverTurn(turn())
  await until(() => session.frames().some((frame) => frame.phase === "started"))
  t3.script("run_1", [
    {
      status: "completed",
      replaceItems: true,
      items: [
        item(0, "system_notice", { itemId: "anchor", text: "Preparing." }),
        item(1, "command_execution", { itemId: "tool", text: "$ true" }),
        item(2, "assistant_message", { itemId: "final", text: "Done." }),
      ],
    },
  ])
  await session.settled()
  expect(
    session
      .frames()
      .filter((frame) => frame.stepType === "tool_call")
      .map(({ phase, clientStepId }) => ({ phase, clientStepId }))
  ).toEqual([
    { phase: "started", clientStepId: expect.any(String) },
    { phase: undefined, clientStepId: session.frames().find((frame) => frame.phase === "started")!.clientStepId },
  ])
  expect(session.replies).toEqual([{ invocationId: "binv_1", text: "Done." }])
  runner.shutdown()
})

test("should show an earlier pending question without assigning it to the queued turn", async () => {
  const { t3, session, runner } = setup({ state: { threads: { stream_root: "thread_1" }, model: MODEL } })
  t3.ask("thread_1", "old_request", [question("old")])
  t3.script("run_1", [
    { status: "queued" },
    { status: "queued" },
    { status: "completed", items: [item(0, "assistant_message", { text: "Done." })] },
  ])
  await runner.deliverTurn(turn())
  await session.settled()
  expect({
    frames: session.frames(),
    cards: session.decisions,
    answers: t3.callsOf("t3_pending_request", "respond"),
  }).toEqual({
    frames: [
      {
        stepType: "thinking",
        content: "Queued in T3 Code. Answer the earlier run's pending question in T3 Code to continue.",
      },
    ],
    cards: [],
    answers: [],
  })
  runner.shutdown()
})

test("should restore an owed outcome even when a later outcome already advanced the delivered mark", async () => {
  const { t3, session, runner, saved } = setup({
    state: {
      threads: { stream_root: "thread_1" },
      model: MODEL,
      delivered: { thread_1: "run_2" },
      owed: { thread_1: ["run_1"] },
    },
  })
  t3.startInT3("thread_1")
  t3.endInT3("run_1")
  t3.startInT3("thread_1")
  t3.endInT3("run_2")
  t3.addItems("thread_1", [
    item(0, "assistant_message", { text: "Owed." }),
    item(1, "assistant_message", { runId: "run_2", text: "Already posted." }),
  ])
  await runner.watch()
  await until(() => !runner.busy)
  expect(session.posts).toEqual([{ streamId: "stream_root", text: "Owed.", clientMessageId: "t3run-run_1" }])
  expect(saved.at(-1)?.delivered).toEqual({ thread_1: "run_2" })
  runner.shutdown()
  const restarted = setup({ t3, state: saved.at(-1)! })
  await restarted.runner.watch()
  await until(() => !restarted.runner.busy)
  expect(restarted.session.posts).toEqual([])
  restarted.runner.shutdown()
})

test("should refresh attachment instructions on launches, followups, steers, and image sends", async () => {
  const { t3, session, runner } = setup()
  t3.script("run_1", [{ status: "completed", items: [item(0, "assistant_message", { text: "Done." })] }])
  await runner.deliverTurn(turn())
  await session.settled()
  t3.script("run_2", [{ status: "running" }])
  await runner.deliverTurn(turn({ invocationId: "binv_2" }))
  await runner.steer("More work", "stream_root", [])
  await runner.steer("See image", "stream_root", [downloaded("image.png", "image/png", "image")])
  const sent = t3.calls.filter(({ name }) =>
    ["t3_thread_launch", "t3_thread_send", "t3_thread_send_attachments"].includes(name)
  )
  expect(sent.map(({ args }) => args.message)).toEqual(
    Array.from({ length: 4 }, () =>
      expect.stringMatching(
        /THREA_ATTACH: \/absolute\/path\/to\/file.*Local paths and file: links are not downloadable links in Threa/s
      )
    )
  )
  runner.shutdown()
})

test.each(["anchor", "tool-98"])("should retry a page when activity shifts after resolving %s", async (shiftAt) => {
  const { t3, session, runner } = setup()
  const anchor = item(100, "system_notice", { itemId: "anchor", text: "Preparing." })
  t3.script("run_1", [{ status: "running", items: [anchor] }])
  await runner.deliverTurn(turn())
  await until(() => session.frames().some((frame) => frame.content === "Preparing."))
  const call = t3.client.call.bind(t3.client)
  const tools = Array.from({ length: 102 }, (_, index) =>
    item(101 + index, "command_execution", { itemId: `tool-${index}`, text: `$ important-${index}` })
  )
  const final = item(203, "assistant_message", { itemId: "final", text: "Done." })
  let shifted = false
  const read = spyOn(t3.client, "call").mockImplementation(
    async <K extends T3ToolName>(name: K, args: T3Tools[K]["args"]) => {
      const result = await call(name, args)
      if (name === "t3_thread_read" && "itemId" in args && args.itemId === shiftAt && !shifted) {
        shifted = true
        t3.replaceActivity("thread_1", [
          { ...anchor, position: 0 },
          ...tools.map((tool) => ({ ...tool, position: tool.position - 100 })),
          { ...final, position: 103 },
        ])
      }
      return result
    }
  )
  try {
    t3.script("run_1", [{ status: "completed", items: [...tools, final] }])
    await session.settled()
    expect({
      tools: session.frames().filter((frame) => frame.stepType === "tool_call"),
      replies: session.replies,
    }).toEqual({
      tools: tools.map((tool) => expect.objectContaining({ content: expect.stringContaining(tool.text!.slice(2)) })),
      replies: [{ invocationId: "binv_1", text: "Done." }],
    })
  } finally {
    read.mockRestore()
    runner.shutdown()
  }
})

test.each([false, true])(
  "should keep held assistant text in the activity snapshot when positions shift: %p",
  async (update) => {
    const { t3, session, runner } = setup()
    const held = item(update ? 0 : 101, "assistant_message", {
      itemId: "held",
      text: update ? "THREA_UPDATE: First update." : "Final answer.",
    })
    const tool = item(100, "command_execution", { itemId: "tool", text: "$ true", status: "running" })
    t3.script("run_1", [{ status: "running", items: update ? [held] : [tool, held] }])
    await runner.deliverTurn(turn())
    await until(() => t3.callsOf("t3_thread_wait").length >= 2)
    const call = t3.client.call.bind(t3.client)
    let shifted = false
    const read = spyOn(t3.client, "call").mockImplementation(
      async <K extends T3ToolName>(name: K, args: T3Tools[K]["args"]) => {
        const result = await call(name, args)
        if (name === "t3_thread_read" && "view" in args && args.view === "activity" && !shifted) {
          shifted = true
          t3.replaceActivity(
            "thread_1",
            update
              ? [{ ...held, position: 100 }, item(101, "assistant_message", { itemId: "final", text: "Done." })]
              : [
                  { ...tool, position: 0, status: "completed" },
                  { ...held, position: 1 },
                ]
          )
        }
        return result
      }
    )
    try {
      t3.script("run_1", [
        {
          status: "completed",
          items: update
            ? [item(1, "assistant_message", { itemId: "final", text: "Done." })]
            : [{ ...tool, status: "completed" }, held],
        },
      ])
      await session.settled()
      expect({ interims: session.interims, replies: session.replies }).toEqual({
        interims: update ? [{ invocationId: "binv_1", text: "First update." }] : [],
        replies: [{ invocationId: "binv_1", text: update ? "Done." : "Final answer." }],
      })
    } finally {
      read.mockRestore()
      runner.shutdown()
    }
  }
)

test("should preserve a held update before an unrelated cursor item", async () => {
  const { t3, session, runner } = setup()
  t3.script("run_1", [
    {
      status: "running",
      items: [
        item(0, "assistant_message", { itemId: "held", text: "THREA_UPDATE: First update." }),
        item(1, "user_message", { itemId: "external", runId: null, text: "More context." }),
      ],
    },
  ])
  await runner.deliverTurn(turn())
  await until(() => t3.callsOf("t3_thread_wait").length >= 2)
  t3.script("run_1", [
    { status: "completed", items: [item(2, "assistant_message", { itemId: "final", text: "Done." })] },
  ])
  await session.settled()
  expect({ interims: session.interims, replies: session.replies }).toEqual({
    interims: [{ invocationId: "binv_1", text: "First update." }],
    replies: [{ invocationId: "binv_1", text: "Done." }],
  })
  runner.shutdown()
})

test.each([1, 150])("should preserve a capped final through %s continuation read failures", async (failures) => {
  const { t3, session, runner, saved } = setup()
  const call = t3.client.call.bind(t3.client)
  let remaining = failures
  const read = spyOn(t3.client, "call").mockImplementation(
    async <K extends T3ToolName>(name: K, args: T3Tools[K]["args"]) => {
      if (name === "t3_thread_read" && "textOffset" in args && remaining-- > 0)
        throw new Error("Temporary continuation outage")
      return call(name, args)
    }
  )
  t3.continueText("final", "First part. Done.")
  t3.script("run_1", [
    {
      status: "completed",
      items: [item(0, "assistant_message", { itemId: "final", text: "First part.", nextTextOffset: 11 })],
    },
  ])
  try {
    await runner.deliverTurn(turn())
    await until(() => !runner.busy)
    await runner.watch()
    expect({ replies: session.replies, owed: saved.at(-1)?.owed, stops: t3.callsOf("t3_thread_interrupt") }).toEqual({
      replies: failures === 1 ? [{ invocationId: "binv_1", text: "First part. Done." }] : [],
      owed: failures === 1 ? undefined : { thread_1: ["run_1"] },
      stops: [],
    })
    if (failures === 150) {
      runner.shutdown()
      const restarted = setup({ t3, state: saved.at(-1)! })
      await restarted.runner.watch()
      await until(() => !restarted.runner.busy)
      expect(restarted.session.posts).toEqual([
        { streamId: "stream_root", text: "First part. Done.", clientMessageId: "t3run-run_1" },
      ])
      restarted.runner.shutdown()
    }
  } finally {
    read.mockRestore()
    runner.shutdown()
  }
})

test("should reuse resolved final text after a thrown send failure", async () => {
  const { t3, session, runner } = setup()
  const reply = session.session.reply.bind(session.session)
  let failed = false
  const send = spyOn(session.session, "reply").mockImplementation(async (invocationId, text) => {
    if (!failed) {
      failed = true
      throw new Error("Temporary send outage")
    }
    return reply(invocationId, text)
  })
  t3.continueText("final", "First part. Done.")
  t3.script("run_1", [
    {
      status: "completed",
      items: [item(0, "assistant_message", { itemId: "final", text: "First part.", nextTextOffset: 11 })],
    },
  ])
  try {
    await runner.deliverTurn(turn())
    await session.settled()
    expect({
      replies: session.replies,
      reads: t3.callsOf("t3_thread_read").filter((args) => args.textOffset !== undefined),
      stops: t3.callsOf("t3_thread_interrupt"),
    }).toEqual({
      replies: [{ invocationId: "binv_1", text: "First part. Done." }],
      reads: [{ threadId: "thread_1", itemId: "final", textOffset: 11, maxCharsPerItem: 8000 }],
      stops: [],
    })
  } finally {
    send.mockRestore()
    runner.shutdown()
  }
})

describe("runtime run attachment", () => {
  const state: ThreadState = { threads: { stream_root: "thread_1" }, model: MODEL }

  test("should attach a silent active run once across manual and watch races without sending input", async () => {
    const { t3, session, runner, saved } = setup({ state })
    t3.startInT3("thread_1")
    const statuses = await Promise.all([runner.attach("stream_root"), runner.attach("stream_root"), runner.watch()])
    expect({
      statuses: statuses.slice(0, 2),
      adoptions: session.adoptions,
      persisted: saved[0]?.attachments,
      nativeWrites: t3.calls.filter(({ name }) => /send|launch|interrupt/.test(name)),
    }).toEqual({
      statuses: ["Following the existing T3 Code run.", "Following the existing T3 Code run."],
      adoptions: [{ responseStreamId: "stream_root", externalRunId: "run_1", attachmentRequestId: expect.any(String) }],
      persisted: { thread_1: { run_1: session.adoptions[0]!.attachmentRequestId } },
      nativeWrites: [],
    })
    expect(await runner.attach("stream_root")).toBe("Already following T3 Code here.")
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "Done." })] }])
    await until(() => !runner.busy)
    expect({
      posts: session.posts,
      delivered: saved.at(-1)?.delivered,
      attachments: saved.at(-1)?.attachments,
    }).toEqual({
      posts: [{ streamId: "stream_root", text: "Done.", clientMessageId: "t3run-run_1" }],
      delivered: { thread_1: "run_1" },
      attachments: {},
    })
  })

  test("should recover a waiting question through the existing decision owner", async () => {
    const { t3, session, runner } = setup({ state })
    t3.startInT3("thread_1")
    t3.ask("thread_1", "req_waiting", [question("runner")])
    t3.script("run_1", [{ status: "waiting" }])
    await runner.attach("stream_root")
    await until(() => session.decisions.length > 0)
    expect(session.decisions[0]?.input).toMatchObject({
      invocationId: "adopt-run_1",
      externalRef: "req_waiting",
      streamId: "stream_root",
    })
    session.answer(picked("option_0"))
    await until(() => t3.callsOf("t3_pending_request", "respond").length > 0)
    t3.script("run_1", [{ status: "completed" }])
    await until(() => !runner.busy)
    expect(t3.callsOf("t3_thread_send")).toEqual([])
  })

  test("should reuse a persisted attachment request after an ambiguous API failure and process restart", async () => {
    const first = setup({ state })
    first.t3.startInT3("thread_1")
    first.session.session.adoptRuntimeRun = async () => {
      throw new Error("lost response")
    }
    await expect(first.runner.attach("stream_root")).rejects.toThrow("lost response")
    await until(() => !first.runner.busy)
    const requestId = first.saved.at(-1)!.attachments!.thread_1!.run_1
    const restarted = setup({ state: first.saved.at(-1), t3: first.t3 })
    await restarted.runner.attach("stream_root")
    expect(restarted.session.adoptions).toEqual([
      { responseStreamId: "stream_root", externalRunId: "run_1", attachmentRequestId: requestId! },
    ])
    first.t3.script("run_1", [{ status: "completed" }])
    await until(() => !restarted.runner.busy)
  })

  test("should retry an adoption failure on the next background watch", async () => {
    const { t3, session, runner } = setup({ state })
    t3.startInT3("thread_1")
    const adopt = session.session.adoptRuntimeRun
    let attempt = 0
    session.session.adoptRuntimeRun = async (input) => {
      if (++attempt === 1) throw new Error("offline")
      return adopt(input)
    }
    await runner.watch()
    await until(() => !runner.busy)
    await runner.watch()
    await until(() => session.adoptions.length > 0)
    expect(attempt).toBe(2)
    t3.script("run_1", [{ status: "completed" }])
    await until(() => !runner.busy)
  })

  test("should retry an owed final reply after settlement gives up without closing its attachment", async () => {
    const { t3, session, runner } = setup({ state })
    t3.startInT3("thread_1")
    await runner.attach("stream_root")
    session.postFailures.push(...Array.from({ length: 150 }, () => new Error("offline")))
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "Done." })] }])
    await until(() => !runner.busy)
    expect({ posts: session.posts, closed: session.observations.get("adopt-run_1")?.signal.aborted }).toEqual({
      posts: [],
      closed: false,
    })
    await runner.watch()
    await until(() => !runner.busy)
    expect(session.posts).toEqual([{ streamId: "stream_root", text: "Done.", clientMessageId: "t3run-run_1" }])
    expect(session.adoptions[1]).toEqual(session.adoptions[0])
  })

  test("should retry attachment validation after its native snapshot fails", async () => {
    const { t3, session, runner } = setup({ state })
    t3.startInT3("thread_1")
    const adopt = session.session.adoptRuntimeRun
    let attempt = 0
    session.session.adoptRuntimeRun = async (input) => {
      if (++attempt === 1) {
        t3.failNext("t3_thread_wait", new Error("offline"))
        return { status: "completed", invocationId: "adopt-old" }
      }
      return adopt(input)
    }
    await expect(runner.attach("stream_root")).rejects.toThrow("offline")
    await until(() => !runner.busy)
    await runner.watch()
    await until(() => session.adoptions.length > 0)
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "Done." })] }])
    await until(() => !runner.busy)
    expect(session.posts).toEqual([{ streamId: "stream_root", text: "Done.", clientMessageId: "t3run-run_1" }])
  })

  test("should retry queued observations after the first adoption fails", async () => {
    const { t3, session, runner, saved } = setup({ state })
    t3.startInT3("thread_1")
    t3.startInT3("thread_1")
    const adopt = session.session.adoptRuntimeRun
    let attempt = 0
    session.session.adoptRuntimeRun = async (input) => {
      if (++attempt === 1) throw new Error("offline")
      return adopt(input)
    }
    await runner.watch()
    await until(() => !runner.busy)
    expect(saved.at(-1)?.owed).toEqual({ thread_1: ["run_1", "run_2"] })
    await runner.watch()
    await until(() => session.adoptions.length > 0)
    t3.script("run_1", [{ status: "completed" }])
    await until(() => session.adoptions.some((input) => input.externalRunId === "run_2"))
    t3.script("run_2", [{ status: "completed" }])
    await until(() => !runner.busy)
    expect(session.adoptions.map((input) => input.externalRunId)).toEqual(["run_1", "run_2"])
  })

  test("should observe manually attached queued runs in native order", async () => {
    const { t3, session, runner } = setup({ state })
    for (let i = 0; i < 3; i++) t3.startInT3("thread_1")
    await runner.attach("stream_root")
    for (const runId of ["run_1", "run_2", "run_3"]) t3.script(runId, [{ status: "completed" }])
    await until(() => !runner.busy)
    expect(session.adoptions.map((input) => input.externalRunId)).toEqual(["run_1", "run_2", "run_3"])
  })

  test("should attach the queued run when the head attachment closes during adoption", async () => {
    const { t3, session, runner } = setup({ state })
    t3.startInT3("thread_1")
    t3.startInT3("thread_1")
    const adopt = session.session.adoptRuntimeRun
    session.session.adoptRuntimeRun = async (input) => {
      if (input.externalRunId === "run_1") {
        t3.endInT3("run_1")
        return { status: "completed", invocationId: "old" }
      }
      return adopt(input)
    }
    try {
      expect({
        result: await runner.attach("stream_root"),
        adopted: session.adoptions.map((input) => input.externalRunId),
      }).toEqual({ result: "Following the existing T3 Code run.", adopted: ["run_2"] })
      t3.script("run_2", [{ status: "completed" }])
      await until(() => !runner.busy)
    } finally {
      runner.shutdown()
    }
  })

  test("should reopen a terminal attachment only while native work remains live", async () => {
    const { t3, session, runner } = setup({ state })
    t3.startInT3("thread_1")
    const inputs: string[] = []
    const adopt = session.session.adoptRuntimeRun
    session.session.adoptRuntimeRun = async (input) => {
      inputs.push(input.attachmentRequestId)
      return inputs.length === 1 ? { status: "completed", invocationId: "old" } : adopt(input)
    }
    await runner.attach("stream_root")
    expect({ attempts: inputs.length, fresh: inputs[0] !== inputs[1] }).toEqual({ attempts: 2, fresh: true })
    t3.script("run_1", [{ status: "completed" }])
    await until(() => !runner.busy)
  })

  test("should fence output on claim loss without interrupting native work", async () => {
    const { t3, session, runner, saved } = setup({ state })
    t3.startInT3("thread_1")
    await runner.attach("stream_root")
    session.observations.get("adopt-run_1")!.abort()
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "Late." })] }])
    await until(() => !runner.busy)
    expect({
      posts: session.posts,
      stops: t3.callsOf("t3_thread_interrupt"),
      delivered: saved.at(-1)?.delivered,
      owed: saved.at(-1)?.owed,
    }).toEqual({ posts: [], stops: [], delivered: undefined, owed: { thread_1: ["run_1"] } })
  })

  test("should leave terminal history alone and reject encrypted adoption explicitly", async () => {
    const { t3, session, runner } = setup({ state })
    t3.startInT3("thread_1")
    t3.endInT3("run_1")
    expect(await runner.attach("stream_root")).toBe("No active, queued, or waiting T3 Code run to attach to.")
    expect(session.adoptions).toEqual([])
    const encrypted = setup({ state })
    encrypted.session.encrypted.add("stream_root")
    await expect(encrypted.runner.attach("stream_root")).rejects.toThrow("unsupported for encrypted scratchpads")
    expect(encrypted.session.adoptions).toEqual([])
  })
})

test("should keep completed history suppressed after manually attaching the live run", async () => {
  const { t3, session, runner } = setup({ state: { threads: { stream_root: "thread_1" }, model: MODEL } })
  t3.startInT3("thread_1")
  t3.addItems("thread_1", [item(1, "assistant_message", { text: "Old history." })])
  t3.endInT3("run_1")
  t3.startInT3("thread_1")
  await runner.attach("stream_root")
  t3.script("run_2", [
    { status: "completed", items: [item(2, "assistant_message", { runId: "run_2", text: "Fresh result." })] },
  ])
  await until(() => !runner.busy)
  await runner.watch()
  await until(() => !runner.busy)
  expect({ adoptedRuns: session.adoptions.map((input) => input.externalRunId), posts: session.posts }).toEqual({
    adoptedRuns: ["run_2"],
    posts: [{ streamId: "stream_root", text: "Fresh result.", clientMessageId: "t3run-run_2" }],
  })
})

test("should await an in-flight watch adoption before reporting manual reuse", async () => {
  const { t3, session, runner } = setup({ state: { threads: { stream_root: "thread_1" }, model: MODEL } })
  t3.startInT3("thread_1")
  const pending = Promise.withResolvers<never>()
  let requested = false
  session.session.adoptRuntimeRun = async () => {
    requested = true
    return pending.promise
  }
  await runner.watch()
  await until(() => requested)
  const manual = runner.attach("stream_root")
  pending.reject(new Error("lost adoption response"))
  await expect(manual).rejects.toThrow("lost adoption response")
  await until(() => !runner.busy)
  expect(t3.callsOf("t3_thread_interrupt")).toEqual([])
})
