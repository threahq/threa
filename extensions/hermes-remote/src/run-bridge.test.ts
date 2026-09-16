import { describe, expect, test } from "bun:test"
import type { DeliveredTurn, StepFrame } from "@threahq/remote-session"
import type { HermesRunEvent, HermesRunsClient, RunStatus } from "./hermes-client"
import { HermesTurnRunner, idempotencyKeyFor, type BridgeSession } from "./run-bridge"

function makeSession() {
  const calls = {
    steps: [] as Array<{ invocationId: string; frames: StepFrame[] }>,
    replies: [] as Array<{ invocationId: string; text: string }>,
    fails: [] as Array<{ invocationId: string; errorMessage: string }>,
  }
  const session: BridgeSession = {
    rootStreamId: "stream_root",
    recordSteps: async (invocationId, frames) => {
      calls.steps.push({ invocationId, frames })
      return true
    },
    reply: async (invocationId, text) => {
      calls.replies.push({ invocationId, text })
      return { ok: true, message: "" }
    },
    failTurn: async (invocationId, errorMessage) => {
      calls.fails.push({ invocationId, errorMessage })
      return true
    },
  }
  return { session, calls }
}

function makeClient(
  script: HermesRunEvent[][],
  statuses: RunStatus[] = [],
  admission: { status?: string; replayed?: boolean } = {}
) {
  const created: Array<Record<string, unknown>> = []
  let getRunCalls = 0
  let subscribe = 0
  const client = {
    createRun: async (input: Record<string, unknown>) => {
      created.push(input)
      return { runId: "run_1", status: admission.status ?? "queued", replayed: admission.replayed ?? false }
    },
    getRun: async (): Promise<RunStatus> => {
      const status = statuses[Math.min(getRunCalls, statuses.length - 1)]
      getRunCalls += 1
      return status ?? { runId: "run_1", status: "completed", output: "recovered" }
    },
    streamEvents: async function* (): AsyncIterable<HermesRunEvent> {
      const events = script[subscribe] ?? []
      subscribe += 1
      for (const event of events) yield event
    },
  }
  return { client: client as unknown as HermesRunsClient, created, counts: () => ({ getRunCalls, subscribe }) }
}

const TURN: DeliveredTurn = {
  invocationId: "binv_1",
  streamId: "stream_thread",
  sourceMessageId: "msg_1",
  content: "Do the thing",
  sealed: false,
}

function makeRunner(client: HermesRunsClient, session: BridgeSession): HermesTurnRunner {
  return new HermesTurnRunner({
    client,
    session,
    sessionKeyFor: (streamId) => `threa:ws_1:${session.rootStreamId ?? streamId}`,
    sleep: async () => {},
  })
}

/** deliverTurn resolves at admission; let the background consumer settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
}

describe("HermesTurnRunner", () => {
  test("admits the run with the turn content, stream session id and scratchpad session key", async () => {
    const { session } = makeSession()
    const { client, created } = makeClient([[{ event: "run.completed", run_id: "run_1", output: "ok" }]])
    await makeRunner(client, session).deliverTurn(TURN)
    await settle()

    expect(created).toEqual([
      {
        input: "Do the thing",
        sessionId: "stream_thread",
        idempotencyKey: idempotencyKeyFor(TURN),
        sessionKey: "threa:ws_1:stream_root",
      },
    ])
  })

  test("maps tool events to trace frames and replies with the run output", async () => {
    const { session, calls } = makeSession()
    const { client } = makeClient([
      [
        { event: "run.started", run_id: "run_1" },
        { event: "tool.started", run_id: "run_1", tool: "Bash", preview: "ls -la" },
        { event: "tool.started", run_id: "run_1", tool: "Read", preview: "" },
        { event: "tool.completed", run_id: "run_1", tool: "Bash", duration: 1.234, error: false, preview: "3 files" },
        { event: "tool.completed", run_id: "run_1", tool: "Read", duration: 0.5, error: true, preview: "" },
        { event: "subagent.start", run_id: "run_1", delegation_id: "del_1" },
        { event: "subagent.complete", run_id: "run_1", status: "completed", summary: "found it" },
        { event: "message.delta", run_id: "run_1", delta: "ignored" },
        { event: "run.completed", run_id: "run_1", output: "All done." },
      ],
    ])
    await makeRunner(client, session).deliverTurn(TURN)
    await settle()

    expect(calls.steps.flatMap((call) => call.frames)).toEqual([
      { stepType: "tool_call", content: "Bash: ls -la" },
      { stepType: "tool_call", content: "Read" },
      { stepType: "tool_call", content: "Bash done (1.2s): 3 files" },
      { stepType: "tool_call", content: "Read failed (0.5s)" },
      { stepType: "thinking", content: "Subagent started: del_1" },
      { stepType: "thinking", content: "Subagent completed: found it" },
    ])
    expect(calls.replies).toEqual([{ invocationId: "binv_1", text: "All done." }])
  })

  test("flushes 120 tool events in order before the reply", async () => {
    const { session, calls } = makeSession()
    const events: HermesRunEvent[] = Array.from({ length: 120 }, (_, index) => ({
      event: "tool.started",
      run_id: "run_1",
      tool: `Tool${index}`,
    }))
    events.push({ event: "run.completed", run_id: "run_1", output: "done" })
    const { client } = makeClient([events])
    await makeRunner(client, session).deliverTurn(TURN)
    await settle()

    expect(calls.steps.flatMap((call) => call.frames.map((frame) => frame.content))).toEqual(
      events.slice(0, 120).map((_, index) => `Tool${index}`)
    )
    expect(calls.replies).toEqual([{ invocationId: "binv_1", text: "done" }])
  })

  test("rewrites MEDIA output lines into attachment directives", async () => {
    const { session, calls } = makeSession()
    const { client } = makeClient([
      [{ event: "run.completed", run_id: "run_1", output: "Here:\nMEDIA: /tmp/shot.png\nand that is it." }],
    ])
    await makeRunner(client, session).deliverTurn(TURN)
    await settle()

    expect(calls.replies).toEqual([
      { invocationId: "binv_1", text: "Here:\nTHREA_ATTACH: /tmp/shot.png\nand that is it." },
    ])
  })

  test("a THREA_NO_RESPONSE output closes the turn with no message", async () => {
    const { session, calls } = makeSession()
    const { client } = makeClient([[{ event: "run.completed", run_id: "run_1", output: "  THREA_NO_RESPONSE\n" }]])
    await makeRunner(client, session).deliverTurn(TURN)
    await settle()

    expect(calls.replies).toEqual([{ invocationId: "binv_1", text: "" }])
  })

  test("run.failed fails the turn with the run's error text", async () => {
    const { session, calls } = makeSession()
    const { client } = makeClient([[{ event: "run.failed", run_id: "run_1", error: "Provider authentication failed" }]])
    await makeRunner(client, session).deliverTurn(TURN)
    await settle()

    expect({ fails: calls.fails, replies: calls.replies }).toEqual({
      fails: [{ invocationId: "binv_1", errorMessage: "Provider authentication failed" }],
      replies: [],
    })
  })

  test("run.cancelled closes the turn without posting text", async () => {
    const { session, calls } = makeSession()
    const { client } = makeClient([[{ event: "run.cancelled", run_id: "run_1", interrupted: true }]])
    await makeRunner(client, session).deliverTurn(TURN)
    await settle()

    expect({ replies: calls.replies, fails: calls.fails }).toEqual({
      replies: [{ invocationId: "binv_1", text: "" }],
      fails: [],
    })
  })

  test("a stream that ends without a terminal event falls back to the run status", async () => {
    const { session, calls } = makeSession()
    const { client, counts } = makeClient(
      [[{ event: "tool.started", run_id: "run_1", tool: "Bash" }]],
      [{ runId: "run_1", status: "completed", output: "recovered" }]
    )
    await makeRunner(client, session).deliverTurn(TURN)
    await settle()

    expect({ getRunCalls: counts().getRunCalls, steps: calls.steps.length, replies: calls.replies }).toEqual({
      getRunCalls: 1,
      steps: 1,
      replies: [{ invocationId: "binv_1", text: "recovered" }],
    })
  })

  test("a still-running run is polled, never resubscribed, until it settles", async () => {
    const { session, calls } = makeSession()
    const { client, counts } = makeClient(
      [[], []],
      [
        { runId: "run_1", status: "running" },
        { runId: "run_1", status: "waiting_for_approval" },
        { runId: "run_1", status: "failed", error: "tool exploded" },
      ]
    )
    await makeRunner(client, session).deliverTurn(TURN)
    await settle()

    expect({ ...counts(), fails: calls.fails }).toEqual({
      subscribe: 1,
      getRunCalls: 3,
      fails: [{ invocationId: "binv_1", errorMessage: "tool exploded" }],
    })
  })

  test("a transient status poll failure is retried, not turned into a failed turn", async () => {
    const { session, calls } = makeSession()
    const { client, counts } = makeClient([[]], [{ runId: "run_1", status: "completed", output: "after the blip" }])
    let polls = 0
    const getRun = client.getRun.bind(client)
    client.getRun = async (...args) => {
      polls += 1
      if (polls <= 2) throw new Error("fetch failed")
      return getRun(...args)
    }
    await makeRunner(client, session).deliverTurn(TURN)
    await settle()

    expect({ polls, getRunCalls: counts().getRunCalls, replies: calls.replies, fails: calls.fails }).toEqual({
      polls: 3,
      getRunCalls: 1,
      replies: [{ invocationId: "binv_1", text: "after the blip" }],
      fails: [],
    })
  })

  test("a lost event stream is a fallback to the status, not a turn failure", async () => {
    const { session, calls } = makeSession()
    const { client } = makeClient([], [{ runId: "run_1", status: "completed", output: "late" }])
    client.streamEvents = async function* () {
      yield { event: "tool.started", run_id: "run_1", tool: "Bash" }
      throw new Error("run_not_found")
    }
    await makeRunner(client, session).deliverTurn(TURN)
    await settle()

    expect({ steps: calls.steps.length, replies: calls.replies, fails: calls.fails }).toEqual({
      steps: 1,
      replies: [{ invocationId: "binv_1", text: "late" }],
      fails: [],
    })
  })

  test("a replayed admission skips the event stream and settles from the status", async () => {
    const { session, calls } = makeSession()
    const { client, counts } = makeClient(
      [[{ event: "run.completed", run_id: "run_1", output: "from the stream" }]],
      [{ runId: "run_1", status: "completed", output: "from the status" }],
      { status: "running", replayed: true }
    )
    await makeRunner(client, session).deliverTurn(TURN)
    await settle()

    expect({ ...counts(), replies: calls.replies }).toEqual({
      subscribe: 0,
      getRunCalls: 1,
      replies: [{ invocationId: "binv_1", text: "from the status" }],
    })
  })

  test("a reply the SDK refuses is logged, not dropped", async () => {
    const { session, calls } = makeSession()
    session.reply = async (invocationId, text) => {
      calls.replies.push({ invocationId, text })
      return {
        ok: false,
        retryable: false,
        message: "No open request with invocation_id binv_1 (already answered, expired, or unknown).",
      }
    }
    const logs: string[] = []
    const { client } = makeClient([[{ event: "run.completed", run_id: "run_1", output: "late answer" }]])
    const runner = new HermesTurnRunner({
      client,
      session,
      sessionKeyFor: () => "key",
      sleep: async () => {},
      log: (message) => logs.push(message),
    })
    await runner.deliverTurn(TURN)
    await settle()
    expect({
      replies: calls.replies,
      fails: calls.fails,
      refused: logs.filter((line) => line.includes("reply refused")),
    }).toEqual({
      replies: [{ invocationId: "binv_1", text: "late answer" }],
      fails: [],
      refused: [
        "run run_1 reply refused: No open request with invocation_id binv_1 (already answered, expired, or unknown).",
      ],
    })
  })

  test("the idempotency key changes with the content so a rebuilt redelivery is not a 409", () => {
    const same = idempotencyKeyFor({ ...TURN })
    const other = idempotencyKeyFor({ ...TURN, content: "Do the other thing" })
    expect({
      stable: same === idempotencyKeyFor(TURN),
      prefix: same.startsWith("binv_1."),
      differs: same !== other,
    }).toEqual({
      stable: true,
      prefix: true,
      differs: true,
    })
  })
})
