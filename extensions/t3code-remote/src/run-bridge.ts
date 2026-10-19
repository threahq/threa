import { createHash } from "node:crypto"
import {
  type DeliveredTurn,
  type RuntimeDescriptor,
  type SendResult,
  type StepFrame,
  type TraceMode,
  NO_RESPONSE_SENTINEL,
  StepBatcher,
  isNoResponse,
  redactAttachDirectives,
  toolTraceContent,
} from "@threahq/remote-session"
import { T3AuthError } from "./auth"
import type { T3Access } from "./config"
import { T3ToolError, type ModelSelection, type RunStatus, type T3Client, type ThreadItem } from "./t3-client"

/** The slice of `RemoteSession` the bridge drives, so tests can stand in a fake. */
export interface BridgeSession {
  readonly rootStreamId?: string
  recordSteps(invocationId: string, frames: StepFrame[], statusText?: string): Promise<boolean>
  reply(invocationId: string, text: string): Promise<SendResult>
  failTurn(invocationId: string, errorMessage: string): Promise<boolean>
}

/** What survives a restart: the T3 thread each Threa stream talks to, and the `/model` new threads launch on. */
export interface ThreadState {
  threads: Record<string, string>
  model?: ModelSelection
}

export interface ThreadStore {
  load(): ThreadState
  save(state: ThreadState): void
}

export const T3CODE_RUNTIME: RuntimeDescriptor = {
  kind: "t3code",
  manifest: { output: { reply: true, trace: true, sources: false } },
  busyStatusText: "Working in T3 Code…",
  shutdownErrorMessage: "T3 Code connector shut down",
  maxConcurrentTurns: 4,
}

export type RunTraceMode = TraceMode | "full"

// `t3_thread_wait` returns as soon as the run settles, so its timeout is the trace poll cadence.
const WAIT_TIMEOUT_MS = 2000
const MAX_CONSECUTIVE_POLL_FAILURES = 5
const READ_PAGE_LIMIT = 100
// Under the step content limit with room for the trace envelope.
const MAX_CHARS_PER_ITEM = 8000
const TERMINAL_RUN_STATUSES = new Set<string>(["completed", "failed", "cancelled", "interrupted", "rolled_back"])
const OPEN_ITEM_STATUSES = new Set<string>(["idle", "pending", "running", "waiting"])
const TOOL_LABELS: Record<string, string> = {
  command_execution: "Shell command",
  background_command: "Background command",
  file_change: "File change",
  dynamic_tool: "Tool call",
  web_search: "Web search",
  file_search: "File search",
  subagent: "Subagent",
  delegated_task: "Delegated task",
  background_task: "Background task",
  monitor: "Monitor",
  todo_list: "Todo list",
}
const NOTE_TYPES = new Set(["reasoning", "system_notice", "compaction", "error"])
const BLOCKING_LABELS: Record<string, string> = {
  approval_request: "an approval",
  user_input_request: "a question",
  secret_request: "a secret",
}
const PREAMBLE = [
  "You are answering through Threa, a chat app: your final message is posted there as the reply and renders as GitHub-flavored markdown.",
  "To attach a file to the reply, put a line `THREA_ATTACH: /absolute/path/to/file` in it.",
  `To stay silent, reply exactly ${NO_RESPONSE_SENTINEL}.`,
].join(" ")

function replyTextFor(output: string): string {
  return isNoResponse(output) ? "" : output
}

/** T3 item ids run long; the step id only has to be stable per item. */
function stepIdFor(itemId: string): string {
  return `t3_${createHash("sha256").update(itemId).digest("hex").slice(0, 32)}`
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0]!.trim()
}

function toolStepContent(item: ThreadItem, mode: RunTraceMode): string {
  const label = TOOL_LABELS[item.type]!
  const text = item.text ?? ""
  if (item.type === "command_execution" || item.type === "background_command") {
    if (mode === "headline") return toolTraceContent({ headline: label, sections: [] })
    // T3 joins the command and its output with a newline, so only the first line is surely the command.
    const command = firstLine(text).replace(/^\$ /, "")
    return toolTraceContent({
      headline: item.title ?? command,
      sections:
        mode === "commands"
          ? [{ label: "Details", body: command, lang: "bash" }]
          : [{ label: "Output", body: text, lang: null }],
    })
  }
  if (item.type === "file_change") {
    const path = firstLine(text)
    return toolTraceContent({
      headline: path ? `${label}: ${path.split("/").pop()}` : label,
      sections: mode === "full" ? [{ label: "Details", body: text, lang: null }] : [],
    })
  }
  if (mode !== "full") return toolTraceContent({ headline: label, sections: [] })
  return toolTraceContent({ headline: item.title ?? label, sections: [{ label: "Details", body: text, lang: null }] })
}

function noteFrame(item: ThreadItem, mode: RunTraceMode): StepFrame {
  const text = item.text ?? ""
  switch (item.type) {
    case "reasoning":
      return { stepType: "thinking", content: mode === "full" ? text : "Thinking content omitted for safety." }
    case "error":
      return {
        stepType: "tool_error",
        content: toolTraceContent({ headline: "Error", sections: [{ label: "Error output", body: text, lang: null }] }),
      }
    default:
      return { stepType: "thinking", content: item.title ?? text }
  }
}

/**
 * Turns a turn's T3 items into Threa trace frames. A turn starts as one run and
 * also owns the runs T3 continues it with (a restart, or a steer T3 started as its
 * own run). An assistant message is held until a later item shows it was
 * narration; the one still held when the last run settles is the reply.
 */
export class RunTrace {
  private readonly emitted = new Map<string, "started" | "final">()
  readonly runIds: Set<string>
  held?: ThreadItem
  blockedOn?: string
  lastError?: string

  constructor(
    runId: string,
    private readonly mode: RunTraceMode
  ) {
    this.runIds = new Set([runId])
  }

  owns(item: ThreadItem): boolean {
    return item.runId !== null && this.runIds.has(item.runId)
  }

  observe(item: ThreadItem): StepFrame[] {
    if (!this.owns(item) || item.type === "checkpoint") return []
    if (this.emitted.get(item.itemId) === "final") return []
    const frames: StepFrame[] = []
    if (this.held && item.position > this.held.position) {
      frames.push({ stepType: "thinking", content: redactAttachDirectives(this.held.text ?? "") })
      this.emitted.set(this.held.itemId, "final")
      this.held = undefined
    }
    const open = OPEN_ITEM_STATUSES.has(item.status ?? "")
    if (item.type === "assistant_message") {
      this.held = item
    } else if (item.type in BLOCKING_LABELS) {
      if (open) this.blockedOn = item.type
    } else if (item.type in TOOL_LABELS) {
      const clientStepId = stepIdFor(item.itemId)
      const content = toolStepContent(item, this.mode)
      if (!open) {
        frames.push({ stepType: item.status === "failed" ? "tool_error" : "tool_call", clientStepId, content })
        this.emitted.set(item.itemId, "final")
      } else if (!this.emitted.has(item.itemId)) {
        frames.push({ stepType: "tool_call", phase: "started", clientStepId, content })
        this.emitted.set(item.itemId, "started")
      }
    } else if (NOTE_TYPES.has(item.type) && !open) {
      if (item.type === "error") this.lastError = item.text ?? undefined
      frames.push(noteFrame(item, this.mode))
      this.emitted.set(item.itemId, "final")
    }
    return frames.filter((frame) => frame.content.length > 0)
  }
}

export interface T3TurnRunnerOptions {
  client: T3Client
  session: BridgeSession
  access: T3Access
  /** Threads launch into this T3 project; unset, each launches in its own scratch folder. */
  projectId?: string
  traceMode: TraceMode
  sealedFullTrace: boolean
  threadStore?: ThreadStore
  log?: (message: string) => void
  sleep?: (ms: number) => Promise<void>
}

interface OpenRun {
  threadId: string
  /** The latest run of the turn's chain, the one to wait on and stop. */
  runId: string
  streamId: string
  trace: RunTrace
  abort: AbortController
  /** The last read position this run no longer needs to re-read. */
  cursor?: number
}

/**
 * One Threa turn to one T3 Code run. `deliverTurn` resolves at admission; the run
 * is then followed in the background by polling its thread's activity, tracing
 * its items as steps, and its settled state closes the Threa turn.
 */
export class T3TurnRunner {
  private readonly client: T3Client
  private readonly session: BridgeSession
  private readonly options: T3TurnRunnerOptions
  private readonly log: (message: string) => void
  private readonly sleep: (ms: number) => Promise<void>
  private state: ThreadState
  // Per thread, where the next run's read starts; lost on restart, which only costs one full re-read.
  private readonly cursors = new Map<string, number>()
  // Turns inside admission: an interrupt that lands meanwhile stops the run once T3 returns its id.
  private readonly admitting = new Map<string, { abort: AbortController; streamId: string }>()
  readonly runs = new Map<string, OpenRun>()

  constructor(options: T3TurnRunnerOptions) {
    this.options = options
    this.client = options.client
    this.session = options.session
    this.log = options.log ?? (() => {})
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.state = options.threadStore?.load() ?? { threads: {} }
  }

  threadFor(streamId: string): string | undefined {
    return this.state.threads[streamId]
  }

  get model(): ModelSelection | undefined {
    return this.state.model
  }

  setModel(model: ModelSelection): void {
    this.saveState({ ...this.state, model })
  }

  /** The stream's next turn launches a fresh thread. */
  forgetThread(streamId: string): void {
    const { [streamId]: _dropped, ...threads } = this.state.threads
    this.saveState({ ...this.state, threads })
  }

  hasOpenTurns(streamId?: string): boolean {
    const inScope = (candidate: string) => streamId === undefined || candidate === streamId
    return (
      [...this.runs.values()].some((run) => inScope(run.streamId)) ||
      [...this.admitting.values()].some((pending) => inScope(pending.streamId))
    )
  }

  openRuns(): OpenRun[] {
    return [...this.runs.values()]
  }

  /**
   * Once T3 takes the text it belongs to the open turn: when the run already
   * ended, T3 starts it as the next run and the turn follows that one instead.
   */
  async steer(text: string, streamId: string): Promise<boolean> {
    const run = this.openRuns().find((open) => open.streamId === streamId)
    if (!run) return false
    try {
      const sent = await this.client.call("t3_thread_send", { threadId: run.threadId, message: text, mode: "steer" })
      if (sent.runId !== run.runId) adopt(run, sent.runId)
      return true
    } catch (error) {
      if (error instanceof T3ToolError && error.code === "thread_not_sendable") return false
      throw error
    }
  }

  /** Drop every open run in scope before stopping it, so its follower never replies to the closed turn. */
  interrupt(streamId?: string): boolean {
    const inScope = (candidate: string) => streamId === undefined || candidate === streamId
    for (const pending of this.admitting.values()) if (inScope(pending.streamId)) pending.abort.abort()
    for (const [invocationId, run] of [...this.runs.entries()]) {
      if (!inScope(run.streamId)) continue
      run.abort.abort()
      this.runs.delete(invocationId)
      this.stopRun(run.threadId, run.runId)
    }
    return true
  }

  shutdown(): void {
    for (const pending of this.admitting.values()) pending.abort.abort()
    for (const run of this.runs.values()) run.abort.abort()
    this.runs.clear()
  }

  async deliverTurn(turn: DeliveredTurn): Promise<void> {
    const admission = new AbortController()
    this.admitting.set(turn.invocationId, { abort: admission, streamId: turn.streamId })
    let started: { threadId: string; runId: string }
    try {
      started = await this.admit(turn)
    } finally {
      this.admitting.delete(turn.invocationId)
    }
    if (admission.signal.aborted) {
      this.stopRun(started.threadId, started.runId)
      return
    }
    const mode: RunTraceMode = turn.sealed && this.options.sealedFullTrace ? "full" : this.options.traceMode
    const run: OpenRun = {
      ...started,
      streamId: turn.streamId,
      trace: new RunTrace(started.runId, mode),
      abort: new AbortController(),
      ...(this.cursors.has(started.threadId) ? { cursor: this.cursors.get(started.threadId)! } : {}),
    }
    this.runs.set(turn.invocationId, run)
    void this.follow(turn.invocationId, run).catch((error) => {
      this.log(`run ${run.runId} follow failed: ${errorText(error)}`)
      void this.session.failTurn(turn.invocationId, errorText(error)).catch(() => undefined)
    })
  }

  /**
   * A stream with a thread sends to it; a thread under the scratchpad forks the
   * scratchpad's thread so it starts with its context; anything else launches.
   */
  private async admit(turn: DeliveredTurn): Promise<{ threadId: string; runId: string }> {
    const existing = this.threadFor(turn.streamId)
    if (existing) return this.send(existing, turn)
    const root = this.session.rootStreamId
    const rootThread = root ? this.threadFor(root) : undefined
    // Only a thread under the scratchpad inherits; a mention elsewhere starts its own, so scratchpad context never leaks into a channel.
    if (rootThread && turn.streamId !== root && turn.rootStreamId === root) {
      const fork = await this.client.call("t3_thread_fork", {
        threadId: rootThread,
        sourcePoint: { type: "latest_stable" },
        title: titleFor(turn.content),
      })
      this.saveState({ ...this.state, threads: { ...this.state.threads, [turn.streamId]: fork.targetThreadId } })
      return this.send(fork.targetThreadId, turn)
    }
    const { projectId } = this.options
    const launched = await this.client.call("t3_thread_launch", {
      title: titleFor(turn.content),
      message: `${PREAMBLE}\n\n${turn.content}`,
      runtimeMode: this.options.access,
      ...(projectId === undefined ? { scratch: true } : { projectId }),
      ...(this.state.model ? { modelSelection: this.state.model } : {}),
    })
    this.saveState({ ...this.state, threads: { ...this.state.threads, [turn.streamId]: launched.threadId } })
    if (!launched.runId) throw new Error("T3 Code created the thread but started no run.")
    return { threadId: launched.threadId, runId: launched.runId }
  }

  private async send(threadId: string, turn: DeliveredTurn): Promise<{ threadId: string; runId: string }> {
    const sent = await this.client.call("t3_thread_send", {
      threadId,
      message: turn.content,
      mode: "queue",
      clientRequestId: turn.invocationId,
    })
    return { threadId, runId: sent.runId }
  }

  private stopRun(threadId: string, runId: string): void {
    void this.client.call("t3_thread_interrupt", { threadId, runId, reason: "Stopped from Threa" }).catch((error) => {
      this.log(`run ${runId} stop failed: ${errorText(error)}`)
    })
  }

  private async follow(invocationId: string, run: OpenRun): Promise<void> {
    const { trace } = run
    const batcher = new StepBatcher(invocationId, this.session)
    const { signal } = run.abort
    let status: RunStatus | "idle" | undefined
    let failures = 0
    try {
      while (!signal.aborted && !trace.blockedOn) {
        try {
          const waitedOn = run.runId
          const waited = await this.client.call("t3_thread_wait", {
            threadId: run.threadId,
            runId: waitedOn,
            timeoutMs: WAIT_TIMEOUT_MS,
          })
          if (signal.aborted) break
          // T3 continues a restarted run as a new one; a steer's adoption meanwhile wins.
          if (waited.runId && waited.runId !== waitedOn) {
            if (run.runId === waitedOn) adopt(run, waited.runId)
            else run.trace.runIds.add(waited.runId)
          }
          await this.drain(run, batcher)
          failures = 0
          status = waited.status
          if (TERMINAL_RUN_STATUSES.has(status) && run.runId === waitedOn) break
        } catch (error) {
          if (signal.aborted) break
          failures += 1
          if (error instanceof T3AuthError || failures >= MAX_CONSECUTIVE_POLL_FAILURES) throw error
          this.log(`run ${run.runId} poll failed (${failures}): ${errorText(error)}`)
          await this.sleep(WAIT_TIMEOUT_MS)
        }
      }
    } finally {
      await batcher.flush()
      if (run.cursor !== undefined && run.cursor > (this.cursors.get(run.threadId) ?? -1)) {
        this.cursors.set(run.threadId, run.cursor)
      }
      // Released before the turn closes, so a command right after the reply sees no open run.
      if (this.runs.get(invocationId) === run) this.runs.delete(invocationId)
    }
    if (signal.aborted) return
    if (trace.blockedOn) {
      this.stopRun(run.threadId, run.runId)
      await this.session.failTurn(
        invocationId,
        `T3 Code stopped to ask for ${BLOCKING_LABELS[trace.blockedOn]}, which Threa can't answer yet. Give the connector full-access (t3Access) so runs never wait on one.`
      )
      return
    }
    await this.settle(invocationId, run, status!)
  }

  /** Read the thread's activity past the run's cursor; the cursor stops at the run's first unsettled item. */
  private async drain(run: OpenRun, batcher: StepBatcher): Promise<void> {
    const { trace } = run
    let after = run.cursor
    let advancing = true
    for (;;) {
      const page = await this.client.call("t3_thread_read", {
        threadId: run.threadId,
        view: "activity",
        limit: READ_PAGE_LIMIT,
        maxCharsPerItem: MAX_CHARS_PER_ITEM,
        ...(after === undefined ? {} : { afterPosition: after }),
      })
      for (const item of page.items) {
        for (const frame of trace.observe(item)) {
          if (frame.phase === "started") void batcher.addNow(frame)
          else batcher.add(frame)
        }
        if (trace.owns(item) && OPEN_ITEM_STATUSES.has(item.status ?? "")) advancing = false
        if (advancing) run.cursor = item.position
      }
      if (!page.hasMore || page.nextPosition === null) return
      after = page.nextPosition
    }
  }

  private async settle(invocationId: string, run: OpenRun, status: string): Promise<void> {
    const { trace } = run
    if (status !== "completed") {
      const reason = trace.lastError ?? `The T3 Code run ended ${status.replace("_", " ")}.`
      if (!(await this.session.failTurn(invocationId, reason))) {
        this.log(`turn ${invocationId} was already closed; run ${run.runId} ${status}: ${reason}`)
      }
      return
    }
    const text = trace.held ? await this.fullText(run.threadId, trace.held) : ""
    const result = await this.session.reply(invocationId, replyTextFor(text))
    if (!result.ok) this.log(`run ${run.runId} reply ${result.retryable ? "deferred" : "refused"}: ${result.message}`)
  }

  /** Activity reads cap each item's text; the reply continues from the offset until T3 has no more. */
  private async fullText(threadId: string, item: ThreadItem): Promise<string> {
    let text = item.text ?? ""
    let offset = item.nextTextOffset
    while (offset != null) {
      const page = await this.client.call("t3_thread_read", {
        threadId,
        itemId: item.itemId,
        textOffset: offset,
        maxCharsPerItem: MAX_CHARS_PER_ITEM,
      })
      const next = page.items[0]
      if (!next) throw new Error(`T3 Code lost the reply's text at offset ${offset}.`)
      text += next.text ?? ""
      offset = next.nextTextOffset
    }
    return text
  }

  /** Written before memory changes, so a failed write leaves both unchanged. */
  private saveState(next: ThreadState): void {
    this.options.threadStore?.save(next)
    this.state = next
  }
}

function adopt(run: OpenRun, runId: string): void {
  run.runId = runId
  run.trace.runIds.add(runId)
}

function titleFor(content: string): string {
  const line = firstLine(content) || "Threa"
  return line.length <= 80 ? line : `${line.slice(0, 79)}…`
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
