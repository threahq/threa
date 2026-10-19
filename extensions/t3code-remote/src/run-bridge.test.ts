import { describe, expect, test } from "bun:test"
import { mkdtempSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DownloadedAttachment } from "@threahq/remote-session"
import { T3AuthError } from "./auth"
import { RunTrace, T3TurnRunner, type RunTraceMode, type ThreadState } from "./run-bridge"
import { T3ToolError } from "./t3-client"
import { fakeSession, fakeT3, item, turn } from "./t3.test-support"

const MODEL = { instanceId: "codex", model: "gpt-5.5" }

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
    sleep: async () => {},
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

const idle = () => new Promise((resolve) => setTimeout(resolve, 0))

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

  test("a model picked in T3 itself becomes the one new threads launch on", async () => {
    const { t3, session, saved, runner } = setup({
      state: {
        threads: { stream_root: "thread_root" },
        model: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      },
    })
    t3.script("run_1", [{ status: "completed", items: [item(1, "assistant_message", { text: "Hi" })] }])

    await runner.deliverTurn(turn())
    await session.settled()

    expect({ model: runner.model, saved: saved.at(-1) }).toEqual({
      model: MODEL,
      saved: { threads: { stream_root: "thread_root" }, model: MODEL },
    })
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

  test("posts earlier assistant messages as narration with attachment paths hidden", async () => {
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
      { stepType: "thinking", content: "Thinking content omitted for safety." },
    ])
    expect(session.replies).toEqual([{ invocationId: "binv_1", text: "Fixed." }])
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

  test("THREA_NO_RESPONSE replies with nothing", async () => {
    const { t3, session, runner } = setup()
    t3.script("run_1", [
      { status: "completed", items: [item(1, "assistant_message", { text: "THREA_NO_RESPONSE\n" })] },
    ])

    await runner.deliverTurn(turn())
    await session.settled()

    expect(session.replies).toEqual([{ invocationId: "binv_1", text: "" }])
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
      expect.objectContaining({ threadId: "thread_1", afterPosition: 2 }),
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
    await idle()
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

  test("ignores other runs and items it already finalized", () => {
    const trace = new RunTrace("run_1", "commands")
    expect(trace.observe(item(1, "command_execution", { runId: "run_0", text: "$ ls" }))).toEqual([])
    expect(trace.observe(item(2, "command_execution", { text: "$ ls" }))).toEqual([
      expect.objectContaining({ stepType: "tool_call", clientStepId: expect.any(String) }),
    ])
    expect(trace.observe(item(2, "command_execution", { text: "$ ls" }))).toEqual([])
  })
})
