import { describe, expect, test } from "bun:test"
import { mkdtempSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ThreaApiError, type DownloadedAttachment } from "@threahq/remote-session"
import { T3AuthError } from "./auth"
import { RunTrace, T3TurnRunner, type RunTraceMode, type ThreadState } from "./run-bridge"
import { T3ToolError, type PendingQuestion } from "./t3-client"
import { DECISION, fakeSession, fakeT3, item, picked, turn } from "./t3.test-support"

const MODEL = { instanceId: "codex", model: "gpt-5.5" }

const idle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const until = async (done: () => boolean) => {
  while (!done()) await idle()
}

function setup(options: { state?: ThreadState; sealedFullTrace?: boolean; projectId?: string } = {}) {
  const t3 = fakeT3()
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
    expect(saved).toEqual([{ threads: { stream_root: "thread_1" }, model: MODEL }])
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
    expect(saved.at(-1)).toEqual({ threads: { stream_root: "thread_1" }, model: MODEL })
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
      saved: { threads: { stream_root: "thread_root" }, model: MODEL },
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
      { threadId: "thread_1", message: "Now the docs", mode: "queue", clientRequestId: "binv_2" },
    ])
    expect(t3.callsOf("t3_thread_read").slice(readsBefore)).toEqual([
      expect.objectContaining({ threadId: "thread_1", afterPosition: 2, maxCharsPerItem: 1 }),
      expect.objectContaining({ threadId: "thread_1", afterPosition: 2, maxCharsPerItem: 8000 }),
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
          message: "Fix the flaky test",
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

    expect(t3.callsOf("t3_thread_fork")).toEqual([
      { threadId: "thread_root", sourcePoint: { type: "latest_stable" }, title: "Branch off here" },
    ])
    expect(t3.callsOf("t3_thread_send")).toEqual([expect.objectContaining({ threadId: "thread_1" })])
    expect(saved.at(-1)).toEqual({ threads: { stream_root: "thread_root", stream_thread: "thread_1" }, model: MODEL })
  })

  test("a mention outside the scratchpad launches its own thread", async () => {
    const { t3, session, runner } = setup({ state: { threads: { stream_root: "thread_root" }, model: MODEL } })
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "Hi" })] }])

    await runner.deliverTurn(turn({ streamId: "stream_channel", rootStreamId: "stream_channel" }))
    await session.settled()

    expect({ forks: t3.callsOf("t3_thread_fork"), launches: t3.callsOf("t3_thread_launch") }).toEqual({
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

    expect(session.fails).toEqual([{ invocationId: "binv_1", errorMessage: "The T3 Code run ended rolled back." }])
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
    expect(t3.callsOf("t3_pending_request_respond")).toEqual([
      { threadId: "thread_1", requestId: "req_1", answers: { runner: "vitest", watch: "only on CI" } },
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
    expect({ replies: session.replies, responds: t3.callsOf("t3_pending_request_respond") }).toEqual({
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
      responds: t3.callsOf("t3_pending_request_respond"),
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
    t3.failNext("t3_pending_request_read", new Error("request not found"))
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

    expect({
      busyWhileAsking,
      busy: runner.busy,
      responds: t3.callsOf("t3_pending_request_respond"),
      replies: session.replies,
      fails: session.fails,
    }).toEqual({
      busyWhileAsking: true,
      busy: false,
      responds: [{ threadId: "thread_1", requestId: "req_1", answers: { runner: "Bun" } }],
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
    await until(() => t3.callsOf("t3_pending_request_respond").length === 2)
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
    await until(() => t3.callsOf("t3_pending_request_respond").length === 1)
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
      responds: t3.callsOf("t3_pending_request_respond"),
    }).toEqual({
      cards: [
        { ref: "req_1", withdrawn: true },
        { ref: "req_2", withdrawn: false },
      ],
      responds: [{ threadId: "thread_1", requestId: "req_2", answers: { watch: "Bun" } }],
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
      responds: t3.callsOf("t3_pending_request_respond"),
      replies: session.replies,
    }).toEqual({
      withdrawn: [true],
      sends: [],
      responds: [{ threadId: "thread_1", requestId: "req_1", answers: { runner: "Use Bun" } }],
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
      responds: t3.callsOf("t3_pending_request_respond"),
    }).toEqual({ open: [false], sends: ["Use Bun"], responds: [] })
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
      responds: t3.callsOf("t3_pending_request_respond"),
    }).toEqual({ open: [false], sends: [{ message: "Deploy it, using Bun", mode: "steer" }], responds: [] })
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
      responds: t3.callsOf("t3_pending_request_respond"),
      followed: t3.callsOf("t3_thread_wait").at(-1)?.runId,
    }).toEqual({
      open: [false],
      sends: [
        { message: "Deploy it, using Bun", mode: "steer" },
        { message: "Deploy it, using Bun", mode: "queue" },
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
      responds: t3.callsOf("t3_pending_request_respond"),
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
    const { t3, saved, runner } = setup({ state: { threads: { stream_root: "thread_gone" }, model: MODEL } })
    t3.failNext("t3_thread_send", new T3ToolError("t3_thread_send", "thread_not_found", "not found"))

    await expect(runner.deliverTurn(turn())).rejects.toThrow(
      "`thread_gone` is gone; the next message starts a new one."
    )
    expect(saved.at(-1)).toEqual({ threads: {}, model: MODEL })
  })

  test("a thread deleted mid-run fails the turn and is forgotten", async () => {
    const { t3, session, saved, runner } = setup()
    t3.failNext("t3_thread_wait", new T3ToolError("t3_thread_wait", "thread_not_found", "not found"))

    await runner.deliverTurn(turn())
    await session.settled()

    expect({ fails: session.fails, state: saved.at(-1) }).toEqual({
      fails: [{ invocationId: "binv_1", errorMessage: expect.stringContaining("`thread_1` is gone") }],
      state: { threads: {}, model: MODEL },
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
      { threadId: "thread_1", message: "also the docs", mode: "steer" },
      { threadId: "thread_1", message: "and the readme", mode: "steer" },
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
          message: "this one",
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
        sends: [{ threadId: "thread_1", message: "also the docs", mode: "steer" }],
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

  test("posts nothing to a stream until a plaintext message reaches it, as after a restart or on a sealed scratchpad", async () => {
    const { t3, session, runner } = setup({ state: LINKED })
    t3.startInT3("thread_1")
    await runner.watch()
    t3.startInT3("thread_1")
    t3.script("run_2", [
      { status: "completed", items: [item(1, "assistant_message", { runId: "run_2", text: "After the restart." })] },
    ])
    await runner.watch()
    await idle()
    const afterRestart = { busy: runner.busy, posts: [...session.posts] }

    t3.script("run_3", [
      { status: "completed", items: [item(2, "assistant_message", { runId: "run_3", text: "Sealed reply." })] },
    ])
    await runner.deliverTurn(turn({ sealed: true }))
    await session.settled()
    t3.startInT3("thread_1")
    t3.script("run_4", [
      { status: "completed", items: [item(3, "assistant_message", { runId: "run_4", text: "Secret findings." })] },
    ])
    await runner.watch()
    await idle()

    expect({ afterRestart, afterSealed: { busy: runner.busy, posts: session.posts } }).toEqual({
      afterRestart: { busy: false, posts: [] },
      afterSealed: { busy: false, posts: [] },
    })
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
      lastLookFrom: 4,
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
    const post = session.session.postToStream
    session.session.postToStream = async (...args) => {
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
    await until(() => t3.callsOf("t3_thread_send").some((args) => args.message === "Now the docs"))
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
