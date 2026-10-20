import type { DecisionOutcome, DecisionRequestInput, DeliveredTurn, StepFrame } from "@threahq/remote-session"
import type { BridgeSession } from "./run-bridge"
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
  /** The run the wait answers for, when T3 continued the waited one as a new run. */
  runId?: string
  /** The thread's model as of this poll, as when the user switches it in T3. */
  model?: ModelSelection
}

function effortOption(id: string, levels: string[]): ModelOptionDescriptor {
  return { id, type: "select", options: levels.map((level) => ({ id: level })) }
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
  const failures: Partial<Record<T3ToolName, Error[]>> = {}
  const holds: Partial<Record<T3ToolName, Promise<void>[]>> = {}
  const wakers = new Map<string, () => void>()
  const continuations = new Map<string, string>()
  const uploads: Array<{ relativeUrl: string; bytes: string }> = []
  let threads = 0
  let runs = 0
  let prepared = 0
  let steerDelivery: "steered" | "started" | "queued" = "steered"
  let envMode: "local" | "worktree" | undefined
  const models = new Map<string, ModelSelection>()
  const pending = new Map<string, { threadId: string; questions: PendingQuestion[] }>()

  const startRun = () => `run_${++runs}`
  const steerRun = () => (steerDelivery === "steered" ? `run_${runs}` : startRun())

  function apply(threadId: string, step: ScriptStep): void {
    if (step.model) models.set(threadId, step.model)
    const current = items.get(threadId) ?? []
    for (const next of step.items ?? []) {
      const index = current.findIndex((existing) => existing.position === next.position)
      if (index === -1) current.push(next)
      else current[index] = next
    }
    current.sort((a, b) => a.position - b.position)
    items.set(threadId, current)
  }

  async function nextStep(runId: string): Promise<ScriptStep> {
    for (;;) {
      const step = scripts.get(runId)?.shift()
      if (step) return step
      await new Promise<void>((resolve) => wakers.set(runId, resolve))
    }
  }

  const handlers: {
    [K in T3ToolName]: (args: T3Tools[K]["args"]) => T3Tools[K]["result"] | Promise<T3Tools[K]["result"]>
  } = {
    t3_thread_launch: (args) => {
      const threadId = `thread_${++threads}`
      if (args.modelSelection) models.set(threadId, args.modelSelection)
      return { threadId, runId: startRun() }
    },
    t3_thread_send: (args) => {
      if (args.mode === "queue") return { runId: startRun(), status: "running", delivery: "started" }
      return { runId: steerRun(), status: "running", delivery: steerDelivery }
    },
    t3_thread_send_attachments: () => ({ runId: steerRun(), status: "running" }),
    t3_attachment_prepare_upload: () => {
      prepared += 1
      return { attachmentId: `t3att_${prepared}`, relativeUrl: `/api/attachments/upload/tok_${prepared}` }
    },
    t3_thread_wait: async (args) => {
      const step = await nextStep(args.runId)
      apply(args.threadId, step)
      return {
        runId: step.runId ?? args.runId,
        status: step.status as T3Tools["t3_thread_wait"]["result"]["status"],
        timedOut: false,
      }
    },
    t3_thread_read: (args) => {
      const thread = {
        threadId: args.threadId,
        title: "Fake thread",
        status: "idle" as const,
        activeRunId: null,
        providerInstanceId: models.get(args.threadId)?.instanceId ?? "codex",
        model: models.get(args.threadId)?.model ?? "gpt-5.5",
      }
      if (args.itemId !== undefined) {
        const text = continuations.get(args.itemId) ?? ""
        const found = (items.get(args.threadId) ?? []).find((candidate) => candidate.itemId === args.itemId)!
        return {
          thread,
          items: [{ ...found, text: text.slice(args.textOffset ?? 0), nextTextOffset: null }],
          nextPosition: found.position,
          hasMore: false,
        }
      }
      const after = args.afterPosition ?? -1
      const limit = args.limit ?? 100
      const visible = (items.get(args.threadId) ?? []).filter((candidate) => candidate.position > after)
      const page = visible.slice(0, limit)
      return {
        thread,
        items: page,
        nextPosition: page.at(-1)?.position ?? null,
        hasMore: visible.length > limit,
      }
    },
    t3_thread_interrupt: () => ({ status: "interrupt_requested" }),
    t3_thread_configuration: (args) => {
      const modelSelection = models.get(args.threadId)
      if (!modelSelection) throw new Error(`Thread ${args.threadId} not found`)
      return { modelSelection }
    },
    t3_thread_configure: (args) => {
      models.set(args.threadId, args.modelSelection)
      return { sequence: 1 }
    },
    t3_thread_fork: (args) => {
      const targetThreadId = `thread_${++threads}`
      const model = models.get(args.threadId)
      if (model) models.set(targetThreadId, model)
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
    t3_pending_request_list: (args) => ({
      requestIds: [...pending].filter(([, request]) => request.threadId === args.threadId).map(([id]) => id),
    }),
    t3_pending_request_read: (args) => ({
      requestId: args.requestId,
      questions: pending.get(args.requestId)!.questions,
    }),
    t3_pending_request_respond: (args) => {
      pending.delete(args.requestId)
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
      const failure = failures[name]?.shift()
      if (failure) throw failure
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
    callsOf: (name: T3ToolName) => calls.filter((call) => call.name === name).map((call) => call.args),
    script: (runId: string, steps: ScriptStep[]) => {
      scripts.set(runId, [...(scripts.get(runId) ?? []), ...steps])
      wakers.get(runId)?.()
      wakers.delete(runId)
    },
    failNext: (name: T3ToolName, error: Error) => (failures[name] ??= []).push(error),
    /** The next call to `name` waits until the returned release runs. */
    holdNext: (name: T3ToolName) => {
      let release = () => {}
      ;(holds[name] ??= []).push(new Promise<void>((resolve) => (release = resolve)))
      return release
    },
    notSendable: () => new T3ToolError("t3_thread_send", "thread_not_sendable", "not sendable"),
    continueText: (itemId: string, fullText: string) => continuations.set(itemId, fullText),
    /** How T3 answers the next steers: folded into the run, or started or queued as their own run. */
    steerAs: (delivery: typeof steerDelivery) => (steerDelivery = delivery),
    /** Put a thread on a model, as when the user configures it in T3. */
    threadModel: (threadId: string, selection: ModelSelection) => models.set(threadId, selection),
    /** Put questions to the user on a thread, as a provider's ask-user tool does. */
    ask: (threadId: string, requestId: string, questions: PendingQuestion[]) =>
      pending.set(requestId, { threadId, questions }),
    /** The environment's default for new threads, unset unless a test sets it. */
    defaultEnvMode: (mode: typeof envMode) => (envMode = mode),
  }
}

export function fakeSession(rootStreamId = "stream_root") {
  const steps: Array<{ invocationId: string; frames: StepFrame[] }> = []
  const replies: Array<{ invocationId: string; text: string }> = []
  const fails: Array<{ invocationId: string; errorMessage: string }> = []
  const decisions: Array<{ input: DecisionRequestInput; signal?: AbortSignal }> = []
  const outcomes: DecisionOutcome[] = []
  let answer: (() => void) | undefined
  let settle: () => void = () => {}
  let settled = new Promise<void>((resolve) => (settle = resolve))
  const session: BridgeSession = {
    rootStreamId,
    recordSteps: async (invocationId, frames) => {
      steps.push({ invocationId, frames })
      return true
    },
    reply: async (invocationId, text) => {
      replies.push({ invocationId, text })
      settle()
      return { ok: true, message: "" }
    },
    failTurn: async (invocationId, errorMessage) => {
      fails.push({ invocationId, errorMessage })
      settle()
      return true
    },
    requestDecision: async (input, opts) => {
      decisions.push({ input, ...(opts?.signal ? { signal: opts.signal } : {}) })
      const aborted = new Promise<never>((_, reject) =>
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      )
      aborted.catch(() => {})
      for (;;) {
        const outcome = outcomes.shift()
        if (outcome) return outcome
        await Promise.race([new Promise<void>((resolve) => (answer = resolve)), aborted])
      }
    },
  }
  return {
    session,
    steps,
    replies,
    fails,
    decisions,
    /** Answer the open card, or the next one asked. */
    answer: (outcome: DecisionOutcome) => {
      outcomes.push(outcome)
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
