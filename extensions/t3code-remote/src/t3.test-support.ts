import type { DeliveredTurn, StepFrame } from "@threahq/remote-session"
import type { BridgeSession } from "./run-bridge"
import { T3ToolError, type T3Client, type T3ToolName, type T3Tools, type ThreadItem } from "./t3-client"

interface ScriptStep {
  status: string
  /** Items as of this poll; each replaces the thread's item at its position. */
  items?: ThreadItem[]
  /** The run the wait answers for, when T3 continued the waited one as a new run. */
  runId?: string
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
  let threads = 0
  let runs = 0
  let steerDelivery: "steered" | "started" | "queued" = "steered"

  const startRun = () => `run_${++runs}`

  function apply(threadId: string, step: ScriptStep): void {
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
    t3_thread_launch: () => {
      const threadId = `thread_${++threads}`
      return { threadId, runId: startRun() }
    },
    t3_thread_send: (args) => {
      if (args.mode === "queue") return { runId: startRun(), status: "running", delivery: "started" }
      const runId = steerDelivery === "steered" ? `run_${runs}` : startRun()
      return { runId, status: "running", delivery: steerDelivery }
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
        providerInstanceId: "codex",
        model: "gpt-5.5",
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
    t3_thread_configure: () => ({ sequence: 1 }),
    t3_thread_fork: () => ({ targetThreadId: `thread_${++threads}` }),
    orchestrator_capabilities: () => ({
      providers: [
        {
          providerInstanceId: "codex",
          displayName: "Codex",
          models: [{ id: "gpt-5.5", label: "GPT-5.5" }, { id: "gpt-5.5-mini" }],
        },
        { providerInstanceId: "claudeAgent", displayName: "Claude", models: [{ id: "claude-opus-5-5" }] },
      ],
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
  } as unknown as T3Client

  return {
    client,
    calls,
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
  }
}

export function fakeSession(rootStreamId = "stream_root") {
  const steps: Array<{ invocationId: string; frames: StepFrame[] }> = []
  const replies: Array<{ invocationId: string; text: string }> = []
  const fails: Array<{ invocationId: string; errorMessage: string }> = []
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
  }
  return {
    session,
    steps,
    replies,
    fails,
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
    sealed: false,
    ...overrides,
  }
}
