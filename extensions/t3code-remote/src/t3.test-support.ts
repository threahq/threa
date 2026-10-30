import {
  DecisionAbandonedError,
  type DecisionOutcome,
  type DecisionRequestInput,
  type DeliveredTurn,
  type StepFrame,
} from "@threahq/remote-session"
import { TERMINAL_RUN_STATUSES, type BridgeSession } from "./run-bridge"
import {
  T3ToolError,
  type ModelOptionDescriptor,
  type ModelSelection,
  type PendingQuestion,
  type T3Client,
  type T3ToolName,
  type T3Tools,
  type ThreadItem,
} from "./t3-client"

interface ScriptStep {
  status: string
  /** Items as of this poll; each replaces the thread's item at its position. */
  items?: ThreadItem[]
  replaceItems?: boolean
  /** The run the wait answers for, when T3 continued the waited one as a new run. */
  runId?: string
  /** The thread's model as of this poll, as when the user switches it in T3. */
  model?: ModelSelection
}

function effortOption(id: string, levels: string[]): ModelOptionDescriptor {
  return { id, type: "select", options: levels.map((level) => ({ id: level })) }
}

export const DECISION = { id: "dec_1" } as DecisionOutcome["decision"]

/** A card answered with `optionId`, and with `note` when the option takes one. */
export const picked = (optionId: string, note: string | null = null): DecisionOutcome => ({
  status: "resolved",
  optionId,
  note,
  decision: DECISION,
})

export async function until(done: () => boolean): Promise<void> {
  while (!done()) await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

export function item(
  position: number,
  type: string,
  fields: Partial<ThreadItem> & { runId?: string | null } = {}
): ThreadItem {
  return {
    position,
    itemId: `turn-item:${position}`,
    runId: "run_1",
    visibility: "local",
    type,
    status: "completed",
    title: null,
    text: null,
    nextTextOffset: null,
    ...fields,
  }
}

/**
 * An in-memory T3 orchestrator: runs advance one scripted step per `t3_thread_wait`,
 * and a wait with no step left blocks until the test scripts more.
 */
export function fakeT3() {
  const calls: Array<{ name: T3ToolName; args: Record<string, unknown> }> = []
  const items = new Map<string, ThreadItem[]>()
  const scripts = new Map<string, ScriptStep[]>()
  const failures: Partial<
    Record<T3ToolName, Array<{ error: Error; matches?: (args: Record<string, unknown>) => boolean }>>
  > = {}
  const holds: Partial<Record<T3ToolName, Promise<void>[]>> = {}
  const wakers = new Map<string, Array<() => void>>()
  const continuations = new Map<string, string>()
  const uploads: Array<{ relativeUrl: string; bytes: string }> = []
  let threads = 0
  let runs = 0
  let prepared = 0
  let steerDelivery: "steered" | "started" | "queued" = "steered"
  let envMode: "local" | "worktree" | undefined
  const models = new Map<string, ModelSelection>()
  const pending = new Map<string, { threadId: string; questions: PendingQuestion[]; startsRun: boolean }>()
  const latestRuns = new Map<string, string>()
  const archived = new Set<string>()
  const threadRuns = new Map<string, string[]>()
  // Like T3, a wait on a run that already ended returns at once with how it ended.
  const ended = new Map<string, string>()
  // A run waiting on the user has finished its provider turn, so it takes no steer.
  const waiting = new Set<string>()

  const pendingRequest = (tool: T3ToolName, requestId: string) => {
    const request = pending.get(requestId)
    if (!request) throw new T3ToolError(tool, "invalid_request", "The pending user-input request was not found.")
    return request
  }
  const startRun = (threadId: string) => {
    const runId = `run_${++runs}`
    latestRuns.set(threadId, runId)
    threadRuns.set(threadId, [...(threadRuns.get(threadId) ?? []), runId])
    return runId
  }
  const notSendable = () => new T3ToolError("t3_thread_send", "thread_not_sendable", "not sendable")
  // A queued run starts once the runs ahead of it end, so the running run is the earliest one still going.
  const activeRun = (threadId: string) =>
    threadRuns.get(threadId)?.find((runId) => !ended.has(runId) && !waiting.has(runId))
  const runStatus = (threadId: string, runId: string): T3Tools["t3_thread_wait"]["result"]["status"] => {
    const terminal = ended.get(runId)
    if (terminal) return terminal as T3Tools["t3_thread_wait"]["result"]["status"]
    if (waiting.has(runId)) return "waiting"
    return activeRun(threadId) === runId ? "running" : "queued"
  }
  // Like T3, only a running run takes a steer; with none, the send is refused.
  const steerRun = (threadId: string) => {
    if (steerDelivery !== "steered") return startRun(threadId)
    const runId = activeRun(threadId)
    if (!runId) throw notSendable()
    return runId
  }
  // An answer sent as a message joins the running run when the provider steers, else starts the next run.
  const answerAsMessage = (threadId: string) => {
    if (steerDelivery !== "steered" || !activeRun(threadId)) startRun(threadId)
  }

  function apply(threadId: string, step: ScriptStep): void {
    if (step.model) models.set(threadId, step.model)
    const current = step.replaceItems ? [] : (items.get(threadId) ?? [])
    for (const next of step.items ?? []) {
      const index = current.findIndex((existing) => existing.position === next.position)
      if (index === -1) current.push(next)
      else current[index] = next
    }
    current.sort((a, b) => a.position - b.position)
    items.set(threadId, current)
  }

  // Takes a step and records what it did at once, so every other waiter on the run sees it end.
  async function nextStep(threadId: string, runId: string): Promise<{ runId: string; status: string }> {
    for (;;) {
      const step = scripts.get(runId)?.shift()
      if (step) {
        apply(threadId, step)
        const stepRunId = step.runId ?? runId
        if (TERMINAL_RUN_STATUSES.has(step.status)) ended.set(stepRunId, step.status)
        if (step.status === "waiting") waiting.add(stepRunId)
        else waiting.delete(stepRunId)
        return { runId: stepRunId, status: step.status }
      }
      const status = ended.get(runId)
      if (status) return { runId, status }
      await new Promise<void>((resolve) => wakers.set(runId, [...(wakers.get(runId) ?? []), resolve]))
    }
  }

  const handlers: {
    [K in T3ToolName]: (args: T3Tools[K]["args"]) => T3Tools[K]["result"] | Promise<T3Tools[K]["result"]>
  } = {
    t3_thread_launch: (args) => {
      const threadId = `thread_${++threads}`
      if (args.modelSelection) models.set(threadId, args.modelSelection)
      return { threadId, runId: startRun(threadId) }
    },
    t3_thread_send: (args) => {
      if (args.mode === "queue") return { runId: startRun(args.threadId), status: "running", delivery: "started" }
      return { runId: steerRun(args.threadId), status: "running", delivery: steerDelivery }
    },
    t3_thread_send_attachments: (args) => ({ runId: steerRun(args.threadId), status: "running" }),
    t3_attachment_prepare_upload: () => {
      prepared += 1
      return { attachmentId: `t3att_${prepared}`, relativeUrl: `/api/attachments/upload/tok_${prepared}` }
    },
    t3_thread_wait: async (args) => {
      if (args.timeoutMs === 1) {
        return {
          runId: args.runId,
          status: runStatus(args.threadId, args.runId),
          timedOut: !ended.has(args.runId),
        }
      }
      const { runId, status } = await nextStep(args.threadId, args.runId)
      return {
        runId,
        status: status as T3Tools["t3_thread_wait"]["result"]["status"],
        timedOut: false,
      }
    },
    t3_thread_read: (args) => {
      const thread = {
        threadId: args.threadId,
        title: "Fake thread",
        status: activeRun(args.threadId)
          ? ("running" as const)
          : threadRuns.get(args.threadId)?.some((runId) => !ended.has(runId) && waiting.has(runId))
            ? ("waiting" as const)
            : ("idle" as const),
        latestRunId: latestRuns.get(args.threadId) ?? null,
        activeRunId: activeRun(args.threadId) ?? null,
        providerInstanceId: models.get(args.threadId)?.instanceId ?? "codex",
        model: models.get(args.threadId)?.model ?? "gpt-5.5",
        archived: archived.has(args.threadId),
      }
      const recentRuns = (threadRuns.get(args.threadId) ?? [])
        .map((runId, index) => ({ runId, ordinal: index + 1, status: runStatus(args.threadId, runId) }))
        .reverse()
        .slice(0, 10)
      if (args.itemId !== undefined) {
        const text = continuations.get(args.itemId) ?? ""
        const found = (items.get(args.threadId) ?? []).find((candidate) => candidate.itemId === args.itemId)!
        return {
          thread,
          recentRuns,
          items: found
            ? [
                {
                  ...found,
                  ...(args.textOffset === undefined ? {} : { text: text.slice(args.textOffset), nextTextOffset: null }),
                },
              ]
            : [],
          nextPosition: found?.position ?? null,
          hasMore: false,
        }
      }
      const after = args.afterPosition ?? -1
      const limit = args.limit ?? 100
      const visible = (items.get(args.threadId) ?? []).filter((candidate) => candidate.position > after)
      const page = visible.slice(0, limit)
      return {
        thread,
        recentRuns,
        items: page,
        nextPosition: page.at(-1)?.position ?? null,
        hasMore: visible.length > limit,
      }
    },
    t3_thread_interrupt: () => ({ status: "interrupt_requested" }),
    t3_thread_configure: (args) => {
      if (!args.modelSelection)
        return {
          modelSelection: models.get(args.threadId) ?? { instanceId: "codex", model: "gpt-5.5" },
          runtimeMode: "full-access",
        }
      models.set(args.threadId, args.modelSelection)
      return { sequence: 1 }
    },
    t3_thread_organize: (args) => {
      if (archived.has(args.threadId)) throw new Error(`Thread ${args.threadId} is already archived.`)
      archived.add(args.threadId)
      return { sequence: 1 }
    },
    t3_thread_transfer: (args) => {
      const targetThreadId = `thread_${++threads}`
      const model = models.get(args.threadId)
      if (model) models.set(targetThreadId, model)
      // Like T3, a fork reads its source's items as inherited, with the source's run ids.
      const inherited = (items.get(args.threadId) ?? []).map((source) => ({
        ...source,
        visibility: "inherited" as const,
      }))
      items.set(targetThreadId, inherited)
      return { targetThreadId }
    },
    orchestrator_capabilities: () => ({
      providers: [
        {
          providerInstanceId: "codex",
          displayName: "Codex",
          models: [
            {
              id: "gpt-5.5",
              label: "GPT-5.5",
              options: [effortOption("reasoningEffort", ["low", "medium", "high", "xhigh"])],
            },
            { id: "gpt-5.5-mini" },
          ],
        },
        {
          providerInstanceId: "claudeAgent",
          displayName: "Claude",
          models: [
            {
              id: "claude-opus-5-5",
              options: [effortOption("effort", ["low", "medium", "high", "max"]), { id: "fastMode", type: "boolean" }],
            },
          ],
        },
      ],
    }),
    t3_pending_request: (args) => {
      if (args.action === "list")
        return {
          requestIds: [...pending].filter(([, request]) => request.threadId === args.threadId).map(([id]) => id),
        }
      if (args.action === "read")
        return {
          requestId: args.requestId,
          questions: pendingRequest("t3_pending_request", args.requestId).questions,
        }
      const request = pendingRequest("t3_pending_request", args.requestId)
      // Like T3, only an answer sent as a message is checked.
      if (request.startsRun) {
        for (const question of request.questions) {
          if (question.required !== false && !args.answers[question.id]?.trim()) throw new Error("Answer each question")
        }
        if (Object.keys(args.answers).length === 0) throw new Error("Enter an answer before sending.")
      }
      pending.delete(args.requestId)
      if (request.startsRun) answerAsMessage(args.threadId)
      return {}
    },
    t3_environment_read: () => ({
      preferences: {
        ...(envMode ? { defaultThreadEnvMode: envMode } : {}),
        newWorktreesStartFromOrigin: true,
      },
    }),
  }

  const client = {
    baseUrl: "http://t3.test",
    call: async <K extends T3ToolName>(name: K, args: T3Tools[K]["args"]): Promise<T3Tools[K]["result"]> => {
      calls.push({ name, args: args as Record<string, unknown> })
      await holds[name]?.shift()
      const queued = failures[name]?.[0]
      if (queued && (!queued.matches || queued.matches(args as Record<string, unknown>))) {
        failures[name]!.shift()
        throw queued.error
      }
      return handlers[name](args)
    },
    upload: async (relativeUrl: string, bytes: Uint8Array) => {
      uploads.push({ relativeUrl, bytes: new TextDecoder().decode(bytes) })
    },
  } as unknown as T3Client

  return {
    client,
    calls,
    uploads,
    replaceActivity: (threadId: string, activity: ThreadItem[]) => items.set(threadId, activity),
    callsOf: (name: T3ToolName, action?: string) =>
      calls
        .filter((call) => call.name === name && (action === undefined || call.args.action === action))
        .map((call) => call.args),
    script: (runId: string, steps: ScriptStep[]) => {
      scripts.set(runId, [...(scripts.get(runId) ?? []), ...steps])
      for (const wake of wakers.get(runId) ?? []) wake()
      wakers.delete(runId)
    },
    failNext: (name: T3ToolName, error: Error, matches?: (args: Record<string, unknown>) => boolean) =>
      (failures[name] ??= []).push({ error, matches }),
    /** The next call to `name` waits until the returned release runs. */
    holdNext: (name: T3ToolName) => {
      let release = () => {}
      ;(holds[name] ??= []).push(new Promise<void>((resolve) => (release = resolve)))
      return release
    },
    notSendable,
    continueText: (itemId: string, fullText: string) => continuations.set(itemId, fullText),
    /** How T3 answers the next steers: folded into the run, or started or queued as their own run. */
    steerAs: (delivery: typeof steerDelivery) => (steerDelivery = delivery),
    /** Put a thread on a model, as when the user configures it in T3. */
    threadModel: (threadId: string, selection: ModelSelection) => models.set(threadId, selection),
    /** Archive a thread in T3 itself. */
    archiveInT3: (threadId: string) => archived.add(threadId),
    /**
     * Put questions to the user on a thread, as a provider's ask-user tool does. `startsRun` asks
     * them as Codex's async questions do, where the answer arrives as a message that starts a run.
     */
    ask: (threadId: string, requestId: string, questions: PendingQuestion[], startsRun = false) =>
      pending.set(requestId, { threadId, questions, startsRun }),
    /** Answer a request in T3 itself; for a question asked as a message the answer is a message. */
    answerInT3: (requestId: string) => {
      const request = pending.get(requestId)!
      pending.delete(requestId)
      if (request.startsRun) answerAsMessage(request.threadId)
    },
    /** Start a run from T3 itself, as when background agents finish or a message is queued in T3's composer. */
    startInT3: (threadId: string) => startRun(threadId),
    /** End a run in T3 with no one waiting on it, as one that finished while the connector was down. */
    endInT3: (runId: string) => ended.set(runId, "completed"),
    /** Items a run wrote that no wait has seen yet. */
    addItems: (threadId: string, added: ThreadItem[]) => apply(threadId, { status: "running", items: added }),
    /** The environment's default for new threads, unset unless a test sets it. */
    defaultEnvMode: (mode: typeof envMode) => (envMode = mode),
  }
}

export function fakeSession(rootStreamId = "stream_root") {
  const steps: Array<{ invocationId: string; frames: StepFrame[]; statusText?: string }> = []
  const replies: Array<{ invocationId: string; text: string }> = []
  const posts: Array<{ streamId: string; text: string; clientMessageId: string }> = []
  const interims: Array<{ invocationId: string; text: string }> = []
  const replyResults: Array<Awaited<ReturnType<BridgeSession["reply"]>>> = []
  const interimResults: Array<Awaited<ReturnType<BridgeSession["sendInterim"]>>> = []
  const postFailures: Error[] = []
  const encrypted = new Set<string>()
  const fails: Array<{ invocationId: string; errorMessage: string }> = []
  const decisions: Array<{ input: DecisionRequestInput; signal?: AbortSignal }> = []
  const outcomes: Array<DecisionOutcome | DecisionAbandonedError> = []
  const adoptions: Array<{ responseStreamId: string; externalRunId: string; attachmentRequestId: string }> = []
  const observations = new Map<string, AbortController>()
  let answer: (() => void) | undefined
  let settle: () => void = () => {}
  let settled = new Promise<void>((resolve) => (settle = resolve))
  const session: BridgeSession = {
    rootStreamId,
    adoptRuntimeRun: async (input) => {
      adoptions.push(input)
      const abort = new AbortController()
      observations.set(`adopt-${input.externalRunId}`, abort)
      return { status: "claimed", invocationId: `adopt-${input.externalRunId}`, signal: abort.signal }
    },
    postToInvocation: async (invocationId, body) => {
      const failure = postFailures.shift()
      if (failure) throw failure
      posts.push({
        streamId: adoptions.find((input) => `adopt-${input.externalRunId}` === invocationId)!.responseStreamId,
        text: body.content,
        clientMessageId: body.clientMessageId,
      })
    },
    endTurn: async (id) => {
      observations.get(id)?.abort()
      return { ok: true, message: "" }
    },
    recordSteps: async (invocationId, frames, statusText) => {
      steps.push({ invocationId, frames, ...(statusText === undefined ? {} : { statusText }) })
      return true
    },
    reply: async (invocationId, text) => {
      const result = replyResults.shift() ?? { ok: true, message: "" }
      if (result.ok) {
        replies.push({ invocationId, text })
        settle()
      }
      return result
    },
    sendInterim: async (invocationId, text) => {
      const result = interimResults.shift() ?? { ok: true, message: "" }
      if (result.ok) interims.push({ invocationId, text })
      return result
    },
    isEncrypted: async (streamId) => encrypted.has(streamId),
    failTurn: async (invocationId, errorMessage) => {
      fails.push({ invocationId, errorMessage })
      settle()
      return true
    },
    requestDecision: async (input, opts) => {
      decisions.push({ input, ...(opts?.signal ? { signal: opts.signal } : {}) })
      const aborted = new Promise<never>((_, reject) =>
        opts?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        })
      )
      aborted.catch(() => {})
      for (;;) {
        const outcome = outcomes.shift()
        if (outcome instanceof DecisionAbandonedError) throw outcome
        if (outcome) return outcome
        await Promise.race([new Promise<void>((resolve) => (answer = resolve)), aborted])
      }
    },
  }
  return {
    session,
    adoptions,
    observations,
    steps,
    replies,
    posts,
    interims,
    /** How the next interim posts answer; unset, they post. */
    interimResults,
    replyResults,
    /** What the next posts to a stream throw; unset, they post. */
    postFailures,
    /** Streams Threa reports as end-to-end encrypted. */
    encrypted,
    fails,
    decisions,
    /** Answer the open card, or the next one asked. */
    answer: (outcome: DecisionOutcome) => {
      outcomes.push(outcome)
      answer?.()
    },
    /** Abandon the open card, as the SDK does when the session shuts down on its own. */
    abandon: () => {
      outcomes.push(new DecisionAbandonedError("dec_1"))
      answer?.()
    },
    frames: () => steps.flatMap((batch) => batch.frames),
    /** Resolves when the next turn closes. */
    settled: async () => {
      await settled
      settled = new Promise<void>((resolve) => (settle = resolve))
    },
  }
}

export function turn(overrides: Partial<DeliveredTurn> = {}): DeliveredTurn {
  return {
    invocationId: "binv_1",
    streamId: "stream_root",
    rootStreamId: "stream_root",
    sourceMessageId: "msg_1",
    content: "Fix the flaky test",
    attachments: [],
    sealed: false,
    ...overrides,
  }
}
