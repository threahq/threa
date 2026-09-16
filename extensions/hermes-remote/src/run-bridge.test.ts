import { describe, expect, test } from "bun:test"
import type { DecisionOutcome, DecisionRequestInput, DeliveredTurn, StepFrame } from "@threahq/remote-session"
import { HermesApiError, type HermesRunEvent, type HermesRunsClient, type RunStatus } from "./hermes-client"
import {
  HermesTurnRunner,
  idempotencyKeyFor,
  type BridgeSession,
  type ConversationState,
  type ConversationStore,
} from "./run-bridge"

function makeSession() {
  const calls = {
    steps: [] as Array<{ invocationId: string; frames: StepFrame[] }>,
    replies: [] as Array<{ invocationId: string; text: string }>,
    fails: [] as Array<{ invocationId: string; errorMessage: string }>,
    decisions: [] as DecisionRequestInput[],
    decisionSignals: [] as Array<AbortSignal | undefined>,
  }
  let outcome: DecisionOutcome = {
    status: "cancelled",
    decision: { id: "dec_1" } as DecisionOutcome["decision"],
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
    requestDecision: async (input, opts) => {
      calls.decisions.push(input)
      calls.decisionSignals.push(opts?.signal)
      return outcome
    },
  }
  return {
    session,
    calls,
    setOutcome: (next: DecisionOutcome) => {
      outcome = next
    },
  }
}

function resolvedWith(optionId: string, note: string | null = null): DecisionOutcome {
  return { status: "resolved", optionId, note, decision: { id: "dec_1" } as DecisionOutcome["decision"] }
}

function makeClient(
  script: HermesRunEvent[][],
  statuses: RunStatus[] = [],
  admission: { status?: string; replayed?: boolean } = {}
) {
  const created: Array<Record<string, unknown>> = []
  const steers: Array<{ runId: string; input: string }> = []
  const stops: string[] = []
  const approvals: Array<{ runId: string; choice: string; requestId?: string }> = []
  const steerErrors: Error[] = []
  const forks: Array<{ sourceId: string; forkId: string }> = []
  const forkErrors: Error[] = []
  let getRunCalls = 0
  let subscribe = 0
  const client = {
    forkSession: async (sourceId: string, forkId: string) => {
      const failure = forkErrors.shift()
      if (failure) throw failure
      forks.push({ sourceId, forkId })
    },
    steerRun: async (runId: string, input: string) => {
      const failure = steerErrors.shift()
      if (failure) throw failure
      steers.push({ runId, input })
      return { runId, accepted: true }
    },
    stopRun: async (runId: string) => {
      stops.push(runId)
      return { runId, status: "stopping" }
    },
    respondApproval: async (runId: string, answer: { choice: string; requestId?: string }) => {
      approvals.push({ runId, ...answer })
      return { runId, choice: answer.choice, resolved: true }
    },
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
  return {
    client: client as unknown as HermesRunsClient,
    created,
    steers,
    stops,
    approvals,
    forks,
    failNextFork: (error: Error) => forkErrors.push(error),
    failNextSteer: (error: Error) => steerErrors.push(error),
    counts: () => ({ getRunCalls, subscribe }),
  }
}

const TURN: DeliveredTurn = {
  invocationId: "binv_1",
  streamId: "stream_thread",
  rootStreamId: "stream_root",
  sourceMessageId: "msg_1",
  content: "Do the thing",
  sealed: false,
}

function makeRunner(client: HermesRunsClient, session: BridgeSession): HermesTurnRunner {
  return new HermesTurnRunner({
    client,
    session,
    sessionKeyFor: (rootStreamId) => `threa:ws_1:${rootStreamId}`,
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
        idempotencyKey: idempotencyKeyFor(TURN.invocationId, TURN.content),
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
    const same = idempotencyKeyFor(TURN.invocationId, TURN.content)
    const other = idempotencyKeyFor(TURN.invocationId, "Do the other thing")
    expect({
      stable: same === idempotencyKeyFor(TURN.invocationId, TURN.content),
      prefix: same.startsWith("binv_1."),
      differs: same !== other,
    }).toEqual({
      stable: true,
      prefix: true,
      differs: true,
    })
  })
})

/** An event stream the test drives frame by frame, so a run can stay open across assertions. */
function makeGatedClient() {
  const created: Array<Record<string, unknown>> = []
  const steers: Array<{ runId: string; input: string }> = []
  const stops: string[] = []
  const approvals: Array<{ runId: string; choice: string; requestId?: string }> = []
  const steerErrors: Error[] = []
  const queue: HermesRunEvent[] = []
  const forks: Array<{ sourceId: string; forkId: string }> = []
  const admissionErrors: Error[] = []
  let closed = false
  let releaseAdmission: (() => void) | undefined
  const client = {
    forkSession: async (sourceId: string, forkId: string) => {
      forks.push({ sourceId, forkId })
    },
    createRun: async (input: Record<string, unknown>) => {
      created.push(input)
      if (releaseAdmission) await new Promise<void>((resolve) => (releaseAdmission = resolve))
      const failure = admissionErrors.shift()
      if (failure) throw failure
      return { runId: "run_1", status: "running", replayed: false }
    },
    getRun: async (): Promise<RunStatus> => ({ runId: "run_1", status: "running" }),
    steerRun: async (runId: string, input: string) => {
      const failure = steerErrors.shift()
      if (failure) throw failure
      steers.push({ runId, input })
      return { runId, accepted: true }
    },
    stopRun: async (runId: string) => {
      stops.push(runId)
      return { runId, status: "stopping" }
    },
    respondApproval: async (runId: string, answer: { choice: string; requestId?: string }) => {
      approvals.push({ runId, ...answer })
      return { runId, choice: answer.choice, resolved: true }
    },
    streamEvents: async function* (_runId: string, signal?: AbortSignal): AsyncIterable<HermesRunEvent> {
      for (;;) {
        if (signal?.aborted) return
        const next = queue.shift()
        if (next) {
          yield next
          continue
        }
        if (closed) return
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
    },
  }
  return {
    client: client as unknown as HermesRunsClient,
    created,
    steers,
    stops,
    approvals,
    forks,
    push: (event: HermesRunEvent) => queue.push(event),
    close: () => {
      closed = true
    },
    failNextSteer: (error: Error) => steerErrors.push(error),
    failNextAdmission: (error: Error) => admissionErrors.push(error),
    /** Park the next createRun until `release` is called. */
    holdAdmission: () => {
      releaseAdmission = () => {}
      return () => releaseAdmission?.()
    },
  }
}

function steerRejected(): HermesApiError {
  return new HermesApiError("run is not accepting steer", { status: 409, code: "run_not_accepting_steer" })
}

const APPROVAL_EVENT: HermesRunEvent = {
  event: "approval.request",
  run_id: "run_1",
  request_id: "req_1",
  command: "rm -rf build",
  description: "Clear the build directory",
  choices: ["once", "session", "always", "deny"],
}

describe("HermesTurnRunner control", () => {
  test("steer folds the text into the running run", async () => {
    const { session } = makeSession()
    const gate = makeGatedClient()
    const runner = makeRunner(gate.client, session)
    await runner.deliverTurn(TURN)

    expect(await runner.steer("go left")).toBe(true)
    expect(gate.steers).toEqual([{ runId: "run_1", input: "go left" }])
    gate.close()
    runner.shutdown()
  })

  test("with no open run there is nothing to steer", async () => {
    const { session } = makeSession()
    const gate = makeGatedClient()
    expect(await makeRunner(gate.client, session).steer("go left")).toBe(false)
  })

  test("a steer Hermes rejects is held and folded into the next turn on that stream", async () => {
    const { session } = makeSession()
    const gate = makeGatedClient()
    const runner = makeRunner(gate.client, session)
    await runner.deliverTurn(TURN)
    gate.failNextSteer(steerRejected())

    expect(await runner.steer("go left")).toBe(true)
    expect(gate.steers).toEqual([])

    gate.push({ event: "run.completed", run_id: "run_1", output: "ok" })
    await settle()
    await runner.deliverTurn({ ...TURN, invocationId: "binv_2", content: "Next" })
    gate.close()

    const second = gate.created[1]
    expect({
      input: second?.input,
      differentKey: second?.idempotencyKey !== idempotencyKeyFor("binv_2", "Next"),
    }).toEqual({
      input: "Next\n\n[Steer that arrived between turns]\ngo left",
      differentKey: true,
    })
    runner.shutdown()
  })

  test("interrupt stops the run and closes its consumer without a reply", async () => {
    const { session, calls } = makeSession()
    const gate = makeGatedClient()
    const runner = makeRunner(gate.client, session)
    await runner.deliverTurn(TURN)

    expect(runner.interrupt()).toBe(true)
    gate.push({ event: "run.cancelled", run_id: "run_1", interrupted: true })
    gate.close()
    await settle()

    expect({ stops: gate.stops, open: runner.runs.size, replies: calls.replies, fails: calls.fails }).toEqual({
      stops: ["run_1"],
      open: 0,
      replies: [],
      fails: [],
    })
  })

  test("an interrupt that lands during admission stops the run Hermes returns", async () => {
    const { session, calls } = makeSession()
    const gate = makeGatedClient()
    const runner = makeRunner(gate.client, session)
    const release = gate.holdAdmission()
    const delivered = runner.deliverTurn(TURN)
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(runner.interrupt()).toBe(true)
    release()
    await delivered
    gate.push({ event: "run.completed", run_id: "run_1", output: "ran anyway" })
    gate.close()
    await settle()

    expect({ stops: gate.stops, open: runner.runs.size, replies: calls.replies, fails: calls.fails }).toEqual({
      stops: ["run_1"],
      open: 0,
      replies: [],
      fails: [],
    })
  })

  test("a turn still in admission counts as open before Hermes returns its run", async () => {
    const { session } = makeSession()
    const gate = makeGatedClient()
    const runner = makeRunner(gate.client, session)
    const release = gate.holdAdmission()
    const delivered = runner.deliverTurn(TURN)
    await new Promise((resolve) => setTimeout(resolve, 5))

    const during = { open: runner.hasOpenTurns(), runs: runner.openRuns().length }
    release()
    await delivered
    gate.push({ event: "run.completed", run_id: "run_1", output: "done" })
    gate.close()
    await settle()

    expect({ during, after: runner.hasOpenTurns() }).toEqual({ during: { open: true, runs: 0 }, after: false })
  })

  test("a held steer survives a failed admission and rides the retry", async () => {
    const { session } = makeSession()
    const gate = makeGatedClient()
    const runner = makeRunner(gate.client, session)
    await runner.deliverTurn(TURN)
    gate.failNextSteer(steerRejected())
    await runner.steer("go left")
    gate.push({ event: "run.completed", run_id: "run_1", output: "ok" })
    await settle()

    gate.failNextAdmission(new Error("gateway restarting"))
    const retry = { ...TURN, invocationId: "binv_2", content: "Next" }
    await expect(runner.deliverTurn(retry)).rejects.toThrow("gateway restarting")
    await runner.deliverTurn(retry)
    gate.close()

    expect(gate.created.slice(1).map((input) => input.input)).toEqual([
      "Next\n\n[Steer that arrived between turns]\ngo left",
      "Next\n\n[Steer that arrived between turns]\ngo left",
    ])
    runner.shutdown()
  })

  test("interrupt with nothing running is not a failure", async () => {
    const { session } = makeSession()
    const gate = makeGatedClient()
    expect(makeRunner(gate.client, session).interrupt()).toBe(true)
  })

  test("an approval request becomes a decision card and its answer is posted back", async () => {
    const { session, calls, setOutcome } = makeSession()
    setOutcome(resolvedWith("once"))
    const gate = makeGatedClient()
    const runner = makeRunner(gate.client, session)
    await runner.deliverTurn(TURN)
    gate.push(APPROVAL_EVENT)
    await settle()

    expect(calls.decisions).toEqual([
      {
        title: "Hermes wants to run a command",
        body: "```sh\nrm -rf build\n```\n\nClear the build directory",
        options: [
          { id: "once", label: "Allow once", tone: "primary" },
          { id: "session", label: "Allow this session" },
          { id: "always", label: "Always allow" },
          { id: "deny", label: "Deny", tone: "destructive" },
        ],
        allowNote: true,
        streamId: "stream_thread",
        expiresInMs: 300_000,
        externalRef: "req_1",
      },
    ])
    expect(gate.approvals).toEqual([{ runId: "run_1", choice: "once", requestId: "req_1" }])

    gate.push({ event: "run.completed", run_id: "run_1", output: "removed" })
    gate.close()
    await settle()
    expect(calls.steps.flatMap((call) => call.frames)).toEqual([
      { stepType: "tool_call", content: "Waiting for approval: rm -rf build" },
    ])
    expect(calls.replies).toEqual([{ invocationId: "binv_1", text: "removed" }])
  })

  test("stopping the run cancels its open approval card", async () => {
    const { session, calls } = makeSession()
    const gate = makeGatedClient()
    const runner = makeRunner(gate.client, session)
    await runner.deliverTurn(TURN)
    gate.push(APPROVAL_EVENT)
    await settle()

    const before = calls.decisionSignals.map((signal) => signal?.aborted)
    runner.interrupt()
    gate.close()
    await settle()

    expect({ before, after: calls.decisionSignals.map((signal) => signal?.aborted) }).toEqual({
      before: [false],
      after: [true],
    })
  })

  test("a run that settles withdraws its unanswered approval card", async () => {
    const { session, calls } = makeSession()
    const gate = makeGatedClient()
    const runner = makeRunner(gate.client, session)
    await runner.deliverTurn(TURN)
    gate.push(APPROVAL_EVENT)
    await settle()

    const before = calls.decisionSignals.map((signal) => signal?.aborted)
    gate.push({ event: "run.completed", run_id: "run_1", output: "done" })
    gate.close()
    await settle()

    expect({
      before,
      after: calls.decisionSignals.map((signal) => signal?.aborted),
      replies: calls.replies,
    }).toEqual({ before: [false], after: [true], replies: [{ invocationId: "binv_1", text: "done" }] })
  })

  test("a denial with a note is posted as a deny and steered in as the reason", async () => {
    const { session, setOutcome } = makeSession()
    setOutcome(resolvedWith("deny", "use the make target instead"))
    const gate = makeGatedClient()
    const runner = makeRunner(gate.client, session)
    await runner.deliverTurn(TURN)
    gate.push(APPROVAL_EVENT)
    await settle()
    gate.close()

    expect({ approvals: gate.approvals, steers: gate.steers }).toEqual({
      approvals: [{ runId: "run_1", choice: "deny", requestId: "req_1" }],
      steers: [{ runId: "run_1", input: "The user denied this and said: use the make target instead" }],
    })
    runner.shutdown()
  })

  test("a denial note Hermes will not steer is held for the next turn", async () => {
    const { session, setOutcome } = makeSession()
    setOutcome(resolvedWith("deny", "no"))
    const gate = makeGatedClient()
    const runner = makeRunner(gate.client, session)
    await runner.deliverTurn(TURN)
    gate.failNextSteer(steerRejected())
    gate.push(APPROVAL_EVENT)
    await settle()
    gate.push({ event: "run.completed", run_id: "run_1", output: "ok" })
    await settle()
    await runner.deliverTurn({ ...TURN, invocationId: "binv_2", content: "Next" })
    gate.close()

    expect(gate.created[1]?.input).toBe("Next\n\n[Steer that arrived between turns]\nThe user denied this and said: no")
    runner.shutdown()
  })

  test("a steer that lands while an approval is parked is sent once the approval is answered", async () => {
    const { session, setOutcome } = makeSession()
    setOutcome(resolvedWith("once"))
    const gate = makeGatedClient()
    const runner = makeRunner(gate.client, session)
    await runner.deliverTurn(TURN)
    gate.failNextSteer(steerRejected())
    expect(await runner.steer("go left")).toBe(true)

    gate.push(APPROVAL_EVENT)
    await settle()
    gate.push({ event: "run.completed", run_id: "run_1", output: "ok" })
    await settle()
    await runner.deliverTurn({ ...TURN, invocationId: "binv_2", content: "Next" })
    gate.close()

    expect({ steers: gate.steers, nextInput: gate.created[1]?.input }).toEqual({
      steers: [{ runId: "run_1", input: "go left" }],
      nextInput: "Next",
    })
    runner.shutdown()
  })

  test("steer text a completed run never consumed is folded into the next turn", async () => {
    const { session } = makeSession()
    const gate = makeGatedClient()
    const runner = makeRunner(gate.client, session)
    await runner.deliverTurn(TURN)
    gate.push({ event: "run.completed", run_id: "run_1", output: "ok", pending_steer: "tighten the ending" })
    await settle()
    await runner.deliverTurn({ ...TURN, invocationId: "binv_2", content: "Next" })
    gate.close()

    expect(gate.created[1]?.input).toBe("Next\n\n[Steer that arrived between turns]\ntighten the ending")
    runner.shutdown()
  })

  test("a held steer whose send is still out when the run completes is folded into the next turn", async () => {
    const { session } = makeSession()
    const gate = makeGatedClient()
    let answerSteer: ((error: Error) => void) | undefined
    const sends: string[] = []
    const client = {
      ...(gate.client as unknown as Record<string, unknown>),
      steerRun: async (_runId: string, input: string) => {
        sends.push(input)
        if (sends.length === 1) throw steerRejected()
        throw await new Promise<Error>((resolve) => (answerSteer = resolve))
      },
    } as unknown as HermesRunsClient
    const runner = makeRunner(client, session)
    await runner.deliverTurn(TURN)
    await runner.steer("go left")

    gate.push({ event: "tool.started", run_id: "run_1", tool: "Bash", preview: "ls" })
    await settle()
    await runner.steer("then right")
    gate.push({ event: "run.completed", run_id: "run_1", output: "ok" })
    await settle()
    answerSteer?.(steerRejected())
    await settle()
    await runner.deliverTurn({ ...TURN, invocationId: "binv_2", content: "Next" })
    gate.close()

    expect({ sends, nextInput: gate.created[1]?.input }).toEqual({
      sends: ["go left", "go left"],
      nextInput: "Next\n\n[Steer that arrived between turns]\ngo left\nthen right",
    })
    runner.shutdown()
  })

  test("an approval seen only through the status poll gets one card and is answered", async () => {
    const { session, calls, setOutcome } = makeSession()
    setOutcome(resolvedWith("once"))
    const parked: RunStatus = { runId: "run_1", status: "waiting_for_approval", approval: APPROVAL_EVENT }
    const { client, approvals } = makeClient(
      [[]],
      [parked, parked, { runId: "run_1", status: "completed", output: "removed" }]
    )
    await makeRunner(client, session).deliverTurn(TURN)
    await settle()

    expect({
      cards: calls.decisions.map((decision) => decision.externalRef),
      approvals,
      replies: calls.replies,
    }).toEqual({
      cards: ["req_1"],
      approvals: [{ runId: "run_1", choice: "once", requestId: "req_1" }],
      replies: [{ invocationId: "binv_1", text: "removed" }],
    })
  })

  test("an expired decision denies the approval", async () => {
    const { session, setOutcome } = makeSession()
    setOutcome({ status: "expired", decision: { id: "dec_1" } as DecisionOutcome["decision"] })
    const gate = makeGatedClient()
    const runner = makeRunner(gate.client, session)
    await runner.deliverTurn(TURN)
    gate.push(APPROVAL_EVENT)
    await settle()
    gate.close()

    expect(gate.approvals).toEqual([{ runId: "run_1", choice: "deny", requestId: "req_1" }])
    runner.shutdown()
  })

  test("a bumped conversation generation is persisted and used as the next run's session id", async () => {
    const { session } = makeSession()
    const saved: ConversationState[] = []
    const store: ConversationStore = {
      load: () => ({ generations: {}, forked: ["stream_thread.1"] }),
      save: (state) => {
        saved.push(state)
      },
    }
    const { client, created } = makeClient([[{ event: "run.completed", run_id: "run_1", output: "ok" }]])
    const runner = new HermesTurnRunner({
      client,
      session,
      sessionKeyFor: () => "threa:ws_1:stream_root",
      sleep: async () => {},
      conversationStore: store,
    })

    expect(runner.conversationFor("stream_thread")).toBe("stream_thread")
    expect(runner.bumpConversation("stream_thread")).toBe("stream_thread.1")
    await runner.deliverTurn(TURN)
    await settle()

    expect({ saved, sessionId: created[0]?.sessionId }).toEqual({
      saved: [{ generations: { stream_thread: 1 }, forked: ["stream_thread.1"] }],
      sessionId: "stream_thread.1",
    })
  })

  test("a generation that fails to persist is not used", () => {
    const { session } = makeSession()
    const store: ConversationStore = {
      load: () => ({ generations: {}, forked: [] }),
      save: () => {
        throw new Error("disk full")
      },
    }
    const { client } = makeClient([])
    const runner = new HermesTurnRunner({
      client,
      session,
      sessionKeyFor: () => "threa:ws_1:stream_root",
      sleep: async () => {},
      conversationStore: store,
    })

    expect(() => runner.bumpConversation("stream_root")).toThrow("disk full")
    expect(runner.conversationFor("stream_root")).toBe("stream_root")
  })
})

describe("HermesTurnRunner threads", () => {
  function storeOf(state: ConversationState): { store: ConversationStore; saved: ConversationState[] } {
    const saved: ConversationState[] = []
    return {
      saved,
      store: {
        load: () => state,
        save: (next) => {
          saved.push(next)
        },
      },
    }
  }

  function threadRunner(
    client: HermesRunsClient,
    session: BridgeSession,
    store?: ConversationStore,
    onForked?: (sourceId: string, forkId: string) => Promise<void>
  ): HermesTurnRunner {
    return new HermesTurnRunner({
      client,
      session,
      sessionKeyFor: () => "threa:ws_1:stream_root",
      sleep: async () => {},
      ...(store ? { conversationStore: store } : {}),
      ...(onForked ? { onForked } : {}),
    })
  }

  test("the first turn on a thread forks the root conversation, and the run uses the fork", async () => {
    const { session } = makeSession()
    const { client, created, forks } = makeClient([[{ event: "run.completed", run_id: "run_1", output: "ok" }]])
    const { store, saved } = storeOf({ generations: {}, forked: [] })
    await threadRunner(client, session, store).deliverTurn(TURN)
    await settle()

    expect({ forks, sessionId: created[0]?.sessionId, saved }).toEqual({
      forks: [{ sourceId: "stream_root", forkId: "stream_thread" }],
      sessionId: "stream_thread",
      saved: [{ generations: {}, forked: ["stream_thread"] }],
    })
  })

  test("the fork is handed on before its first run, so a model lock lands first", async () => {
    const { session } = makeSession()
    const { client, created } = makeClient([[{ event: "run.completed", run_id: "run_1", output: "ok" }]])
    const handed: Array<{ sourceId: string; forkId: string; runsBefore: number }> = []
    await threadRunner(client, session, undefined, async (sourceId, forkId) => {
      handed.push({ sourceId, forkId, runsBefore: created.length })
    }).deliverTurn(TURN)
    await settle()

    expect(handed).toEqual([{ sourceId: "stream_root", forkId: "stream_thread", runsBefore: 0 }])
  })

  test("a mention in a channel runs its own unforked conversation under the channel's memory scope", async () => {
    const { session } = makeSession()
    const { client, created, forks } = makeClient([[{ event: "run.completed", run_id: "run_1", output: "ok" }]])
    const runner = new HermesTurnRunner({
      client,
      session,
      sessionKeyFor: (rootStreamId) => `threa:ws_1:${rootStreamId}`,
      sleep: async () => {},
    })
    await runner.deliverTurn({ ...TURN, streamId: "stream_channel_thread", rootStreamId: "stream_channel" })
    await settle()

    expect({ forks, sessionId: created[0]?.sessionId, sessionKey: created[0]?.sessionKey }).toEqual({
      forks: [],
      sessionId: "stream_channel_thread",
      sessionKey: "threa:ws_1:stream_channel",
    })
  })

  test("a turn on the root itself is never forked", async () => {
    const { session } = makeSession()
    const { client, created, forks } = makeClient([[{ event: "run.completed", run_id: "run_1", output: "ok" }]])
    await threadRunner(client, session).deliverTurn({ ...TURN, streamId: "stream_root" })
    await settle()

    expect({ forks, sessionId: created[0]?.sessionId }).toEqual({ forks: [], sessionId: "stream_root" })
  })

  test("the second turn on the same thread reuses the fork", async () => {
    const { session } = makeSession()
    const { client, forks } = makeClient([
      [{ event: "run.completed", run_id: "run_1", output: "ok" }],
      [{ event: "run.completed", run_id: "run_1", output: "ok" }],
    ])
    const runner = threadRunner(client, session)
    await runner.deliverTurn(TURN)
    await settle()
    await runner.deliverTurn({ ...TURN, invocationId: "binv_2" })
    await settle()

    expect(forks).toEqual([{ sourceId: "stream_root", forkId: "stream_thread" }])
  })

  test("a restart with the fork in the store does not fork again", async () => {
    const { session } = makeSession()
    const { client, created, forks } = makeClient([[{ event: "run.completed", run_id: "run_1", output: "ok" }]])
    const { store, saved } = storeOf({ generations: {}, forked: ["stream_thread"] })
    await threadRunner(client, session, store).deliverTurn(TURN)
    await settle()

    expect({ forks, saved, sessionId: created[0]?.sessionId }).toEqual({
      forks: [],
      saved: [],
      sessionId: "stream_thread",
    })
  })

  test("a root conversation that does not exist yet leaves the thread with a fresh conversation", async () => {
    const { session, calls } = makeSession()
    const { client, created, forks } = makeClient([[{ event: "run.completed", run_id: "run_1", output: "ok" }]])
    client.forkSession = async () => {
      throw new HermesApiError("Session not found", { status: 404, code: "session_not_found" })
    }
    const logs: string[] = []
    const runner = new HermesTurnRunner({
      client,
      session,
      sessionKeyFor: () => "threa:ws_1:stream_root",
      sleep: async () => {},
      log: (message) => logs.push(message),
    })
    await runner.deliverTurn(TURN)
    await settle()

    expect({
      forks,
      sessionId: created[0]?.sessionId,
      fails: calls.fails,
      replies: calls.replies,
      logged: logs.some((line) => line.includes("does not exist yet")),
    }).toEqual({
      forks: [],
      sessionId: "stream_thread",
      fails: [],
      replies: [{ invocationId: "binv_1", text: "ok" }],
      logged: true,
    })
  })

  test("a fork id Hermes already has is treated as forked", async () => {
    const { session, calls } = makeSession()
    const { client, created } = makeClient([[{ event: "run.completed", run_id: "run_1", output: "ok" }]])
    client.forkSession = async () => {
      throw new HermesApiError("Session already exists", { status: 409, code: "session_exists" })
    }
    await threadRunner(client, session).deliverTurn(TURN)
    await settle()

    expect({ sessionId: created[0]?.sessionId, fails: calls.fails, replies: calls.replies }).toEqual({
      sessionId: "stream_thread",
      fails: [],
      replies: [{ invocationId: "binv_1", text: "ok" }],
    })
  })

  test("any other fork failure rejects the delivery with the fork error and never starts a run", async () => {
    const { session, calls } = makeSession()
    const { client, created } = makeClient([[{ event: "run.completed", run_id: "run_1", output: "ok" }]])
    client.forkSession = async () => {
      throw new HermesApiError("Fork failed", { status: 500, code: "session_fork_failed" })
    }
    const delivery = threadRunner(client, session).deliverTurn(TURN)

    await expect(delivery).rejects.toThrow("Hermes could not fork stream_root: Fork failed")
    expect({ created, fails: calls.fails }).toEqual({ created: [], fails: [] })
  })

  test("a routing 404 is a gateway without the fork endpoint, not a missing source", async () => {
    const { session } = makeSession()
    const { client, created } = makeClient([[{ event: "run.completed", run_id: "run_1", output: "ok" }]])
    client.forkSession = async () => {
      throw new HermesApiError("Not Found", { status: 404, code: "not_found" })
    }
    const { store, saved } = storeOf({ generations: {}, forked: [] })
    const delivery = threadRunner(client, session, store).deliverTurn(TURN)

    await expect(delivery).rejects.toThrow("Hermes could not fork stream_root: Not Found")
    expect({ created, saved }).toEqual({ created: [], saved: [] })
  })
})

describe("HermesTurnRunner sealed turns", () => {
  test("an approval on a sealed turn is denied with a status frame instead of a card", async () => {
    const { session, calls } = makeSession()
    const gate = makeGatedClient()
    const runner = makeRunner(gate.client, session)
    await runner.deliverTurn({ ...TURN, sealed: true })
    gate.push(APPROVAL_EVENT)
    await settle()
    gate.push({ event: "run.completed", run_id: "run_1", output: "done" })
    gate.close()
    await settle()

    expect({
      approvals: gate.approvals,
      decisions: calls.decisions,
      frames: calls.steps.flatMap((call) => call.frames),
    }).toEqual({
      approvals: [{ runId: "run_1", choice: "deny", requestId: "req_1" }],
      decisions: [],
      frames: [
        { stepType: "tool_call", content: "Waiting for approval: rm -rf build" },
        {
          stepType: "tool_error",
          content:
            "Approval denied: this scratchpad is encrypted and decision cards cannot be shown there yet (rm -rf build)",
        },
      ],
    })
  })

  test("a sealed approval with no usable choices is still denied", async () => {
    const { session, calls } = makeSession()
    const gate = makeGatedClient()
    const runner = makeRunner(gate.client, session)
    await runner.deliverTurn({ ...TURN, sealed: true })
    gate.push({ ...APPROVAL_EVENT, choices: [] })
    await settle()
    gate.push({ event: "run.completed", run_id: "run_1", output: "done" })
    gate.close()
    await settle()

    expect({ approvals: gate.approvals, decisions: calls.decisions }).toEqual({
      approvals: [{ runId: "run_1", choice: "deny", requestId: "req_1" }],
      decisions: [],
    })
  })
})
