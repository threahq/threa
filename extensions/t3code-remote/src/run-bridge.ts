import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import {
  type DecisionOutcome,
  type DecisionRequestInput,
  type DeliveredTurn,
  type DownloadedAttachment,
  type RuntimeDescriptor,
  type SendResult,
  type StepFrame,
  type ToolTraceSection,
  type TraceMode,
  DecisionAbandonedError,
  NO_RESPONSE_SENTINEL,
  StepBatcher,
  isNoResponse,
  isTerminalPostError,
  redactAttachDirectives,
  toolTraceContent,
} from "@threahq/remote-session"
import { T3AuthError } from "./auth"
import type { T3Access } from "./config"
import { type CardAnswer, questionCard } from "./question-card"
import {
  T3ToolError,
  type ImageAttachment,
  type ModelSelection,
  type RunStatus,
  type T3Client,
  type T3Tools,
  type ThreadItem,
  type ThreadSummary,
} from "./t3-client"

/** The slice of `RemoteSession` the bridge drives, so tests can stand in a fake. */
export interface BridgeSession {
  readonly rootStreamId?: string
  recordSteps(invocationId: string, frames: StepFrame[], statusText?: string): Promise<boolean>
  reply(invocationId: string, text: string): Promise<SendResult>
  sendInterim(invocationId: string, text: string): Promise<SendResult>
  /** Posts outside any turn; the same `clientMessageId` posts once. */
  postToStream(streamId: string, text: string, clientMessageId: string): Promise<void>
  failTurn(invocationId: string, errorMessage: string): Promise<boolean>
  requestDecision(input: DecisionRequestInput, opts?: { signal?: AbortSignal }): Promise<DecisionOutcome>
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
const MAX_CARD_WAIT_MS = 30_000
// About five minutes of T3 being unreachable at the WAIT_TIMEOUT_MS retry cadence, enough to ride out a restart.
const MAX_CONSECUTIVE_POLL_FAILURES = 150
const READ_PAGE_LIMIT = 100
// Under the step content limit with room for the trace envelope.
const MAX_CHARS_PER_ITEM = 8000
// What T3 takes as an image attachment; anything else reaches the model only through the manifest's paths.
const IMAGE_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"])
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_IMAGES_PER_MESSAGE = 8
export const TERMINAL_RUN_STATUSES = new Set<string>(["completed", "failed", "cancelled", "interrupted", "rolled_back"])
const UNANSWERED_MESSAGE = "T3 Code asked a question that went unanswered."
const OPEN_ITEM_STATUSES = new Set<string>(["idle", "pending", "running", "waiting"])
// Chips are fixed text per item type: a chip is shown to everyone in the stream, whatever the trace mode.
const TOOLS: Record<string, { label: string; statusText: string }> = {
  command_execution: { label: "Shell command", statusText: "Running a command…" },
  background_command: { label: "Background command", statusText: "Running a command…" },
  file_change: { label: "File change", statusText: "Editing files…" },
  dynamic_tool: { label: "Tool call", statusText: "Using a tool…" },
  web_search: { label: "Web search", statusText: "Searching the web…" },
  file_search: { label: "File search", statusText: "Searching files…" },
  subagent: { label: "Subagent", statusText: "Running a subagent…" },
  delegated_task: { label: "Delegated task", statusText: "Delegating a task…" },
  background_task: { label: "Background task", statusText: "Running a background task…" },
  monitor: { label: "Monitor", statusText: "Monitoring…" },
  todo_list: { label: "Todo list", statusText: "Updating the todo list…" },
}
const NOTE_TYPES = new Set(["reasoning", "system_notice", "compaction", "error"])
const BLOCKING_LABELS: Record<string, string> = {
  approval_request: "an approval",
  secret_request: "a secret",
}
const UPDATE_PREFIX = "THREA_UPDATE:"

function isUpdate(text: string | null | undefined): boolean {
  return (text ?? "").trimStart().startsWith(UPDATE_PREFIX)
}

function withoutUpdatePrefix(text: string): string {
  return isUpdate(text) ? text.trimStart().slice(UPDATE_PREFIX.length).trim() : text
}

const PREAMBLE = [
  "You are answering through Threa, a chat app: your final message is posted there as the reply and renders as GitHub-flavored markdown.",
  "To attach a file to the reply, put a line `THREA_ATTACH: /absolute/path/to/file` in it.",
  `To stay silent, reply exactly ${NO_RESPONSE_SENTINEL}.`,
  `Your messages before the final one are not posted, except one that starts with ${UPDATE_PREFIX}, which is posted right away: use it to keep the user posted on longer work.`,
  "A run that starts without a message from Threa, such as one started when background work finishes, has its final message posted there too.",
].join(" ")

/** T3 item ids run long; the step id only has to be stable per item. */
function stepIdFor(itemId: string): string {
  return `t3_${createHash("sha256").update(itemId).digest("hex").slice(0, 32)}`
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0]!.trim()
}

/** T3 lists each step of a todo list as `[status] text`; the count shows progress without the steps' text. */
function todoProgress(text: string): string | undefined {
  const statuses = text.split("\n").flatMap((line) => /^\[(\w+)\] /.exec(line)?.slice(1) ?? [])
  if (statuses.length === 0) return undefined
  return `${statuses.filter((status) => status === "completed").length}/${statuses.length} done`
}

function toolStepContent(item: ThreadItem, mode: RunTraceMode): string {
  const { label } = TOOLS[item.type]!
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
  const sections: ToolTraceSection[] = mode === "full" ? [{ label: "Details", body: text, lang: null }] : []
  const detail = toolDetail(item, text, mode)
  if (detail) return toolTraceContent({ headline: `${label}: ${detail}`, sections })
  return toolTraceContent({ headline: mode === "full" ? (item.title ?? label) : label, sections })
}

function toolDetail(item: ThreadItem, text: string, mode: RunTraceMode): string | undefined {
  switch (item.type) {
    case "file_change":
      return firstLine(text).split("/").pop()
    case "todo_list":
      return todoProgress(text)
    // A subagent's title is the one its parent gave it, or the start of its prompt, so a headline trace leaves it out.
    case "subagent":
      return mode === "headline" ? undefined : (item.title ?? undefined)
  }
  return undefined
}

function noteFrame(item: ThreadItem, mode: RunTraceMode): StepFrame {
  const text = item.text ?? ""
  switch (item.type) {
    case "reasoning":
      // Reasoning can quote what the agent read, so only a full trace carries it; otherwise the step is dropped.
      return { stepType: "thinking", content: mode === "full" ? text : "" }
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
  /** Finished `THREA_UPDATE:` messages not yet posted. */
  readonly updates: ThreadItem[] = []
  blockedOn?: string
  /** The item ids of questions still waiting on an answer. */
  readonly questions = new Set<string>()
  lastError?: string
  /** The chip for the frames the last observed item made. */
  statusText = T3CODE_RUNTIME.busyStatusText

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
      if (isUpdate(this.held.text)) this.updates.push(this.held)
      else frames.push({ stepType: "thinking", content: redactAttachDirectives(this.held.text ?? "") })
      this.emitted.set(this.held.itemId, "final")
      this.held = undefined
    }
    const open = OPEN_ITEM_STATUSES.has(item.status ?? "")
    this.statusText = (open && TOOLS[item.type]?.statusText) || T3CODE_RUNTIME.busyStatusText
    if (item.type === "assistant_message") {
      this.held = item
    } else if (item.type in BLOCKING_LABELS) {
      if (open) this.blockedOn = item.type
    } else if (item.type === "user_input_request") {
      if (open) this.questions.add(item.itemId)
      else this.questions.delete(item.itemId)
    } else if (item.type in TOOLS) {
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

/** Runs T3 started by itself, followed one by one until each ends; a turn that takes one over continues its trace. */
interface Relay {
  runId: string
  /** Runs found after this one, relayed next. */
  queue: string[]
  /** Where each run's read starts: the read of the run before may have passed a queued run's settled items. */
  from: number | undefined
  abort: AbortController
  read: Pick<OpenRun, "threadId" | "trace" | "cursor">
}

interface OpenRun {
  threadId: string
  /** The latest run of the turn's chain, the one to wait on and stop. */
  runId: string
  streamId: string
  trace: RunTrace
  abort: AbortController
  /** Steers still uploading or sending: the run is not over until they land, since one may start its next run. */
  steers: Set<Promise<boolean>>
  /** The last read position this run no longer needs to re-read. */
  cursor?: number
  /** Set while the run's questions are being put to the user; aborting it withdraws the card. */
  asking?: {
    done: Promise<void>
    abort: AbortController
    requestId?: string
    /** Set while a card that takes a written answer is up: a message typed meanwhile answers it, as T3's composer does. */
    answerTyped?: (text: string) => boolean
  }
  /** Requests never to put to the user: answered from Threa, or pending before the turn began. */
  asked: Set<string>
  /** Set once the run ends with a question open, whose answer, given anywhere, starts the run that carries on. */
  endedAsking?: boolean
  /** The run T3 started for an answer sent from Threa, which carries on once this one ends. */
  answerRunId?: string
  /** Why the turn fails instead of settling, once a question goes unanswered. */
  unanswered?: string
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
  // Per thread, the `instance::model` last read, so only a switch in T3 moves the model new threads launch on.
  private readonly threadModels = new Map<string, string>()
  // Turns inside admission: an interrupt that lands meanwhile stops the run once T3 returns its id.
  private readonly admitting = new Map<string, { abort: AbortController; streamId: string }>()
  readonly runs = new Map<string, OpenRun>()
  // Per thread, the runs a turn or relay already accounts for, or that ran before the first look; any other was started in T3 itself.
  private readonly accounted = new Map<string, Set<string>>()
  // Per thread, the runs T3 started on their own that are being followed until they end.
  private readonly unprompted = new Map<string, Relay>()
  // Streams whose latest Threa message arrived in plaintext. A post outside a turn can't be sealed, so only these get one.
  private readonly plaintextStreams = new Set<string>()
  // Per thread, the last watch failure logged, so a T3 outage logs once rather than every poll.
  private readonly watchErrors = new Map<string, string>()
  private watching = false
  // Counts shutdowns, so a look that read the thread before one posts nothing after it.
  private generation = 0

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

  /**
   * New threads launch on a model a thread is switched to in T3, or on the first one seen when none is set. A thread
   * that merely keeps its model, like a running one /model couldn't move, never overrides the pick.
   */
  private noteModel({ threadId, providerInstanceId: instanceId, model }: ThreadSummary): void {
    const key = `${instanceId}::${model}`
    const seen = this.threadModels.get(threadId)
    this.threadModels.set(threadId, key)
    if (seen === key || (seen === undefined && this.state.model)) return
    if (this.state.model?.instanceId === instanceId && this.state.model.model === model) return
    this.saveState({ ...this.state, model: { instanceId, model } })
  }

  /** The stream's next turn launches a fresh thread. */
  forgetThread(streamId: string): void {
    const relay = this.unprompted.get(this.state.threads[streamId] ?? "")
    if (relay) {
      relay.abort.abort()
      this.release(relay)
    }
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
  async steer(
    text: string,
    streamId: string,
    attachments: DownloadedAttachment[],
    options?: { edit?: boolean }
  ): Promise<boolean> {
    const run = this.openRuns().find((open) => open.streamId === streamId)
    if (!run) return false
    if (!options?.edit && attachments.length === 0 && run.asking?.answerTyped?.(text)) return true
    const steering = this.steerInto(run, text, attachments, options?.edit === true)
    run.steers.add(steering)
    try {
      return await steering
    } finally {
      run.steers.delete(steering)
    }
  }

  private async steerInto(
    run: OpenRun,
    text: string,
    attachments: DownloadedAttachment[],
    edit: boolean
  ): Promise<boolean> {
    const images = await this.uploadImages(attachments)
    if (run.abort.signal.aborted) return false
    try {
      const sent = images.length
        ? await this.client.call("t3_thread_send_attachments", {
            threadId: run.threadId,
            message: text,
            attachments: images,
          })
        : await this.sendText(run.threadId, text, edit)
      // A /stop that landed during the send has already stopped the chain it knew about. T3 folds a steer into
      // whichever run is going, which can be one ahead of this turn's: a relay posts that run's answer, and without
      // one the turn traces it but still settles on its own run.
      if (run.abort.signal.aborted) this.stopRun(run.threadId, sent.runId)
      else if (sent.runId !== run.runId && !this.relaying(run.threadId, sent.runId)) {
        if (this.accounted.get(run.threadId)?.has(sent.runId)) run.trace.runIds.add(sent.runId)
        else adopt(run, sent.runId)
      }
      return true
    } catch (error) {
      if (error instanceof T3ToolError && error.code === "thread_not_sendable") return false
      throw error
    }
  }

  /**
   * A run that can't take a steer leaves a message for the next turn. An edit can't wait: the SDK
   * restarts what it can't apply, and that restart comes back as a plain message, which a card
   * would take as its answer. So it runs after the active run instead.
   */
  private async sendText(threadId: string, message: string, edit: boolean) {
    try {
      return await this.client.call("t3_thread_send", { threadId, message, mode: "steer" })
    } catch (error) {
      if (!edit || !(error instanceof T3ToolError && error.code === "thread_not_sendable")) throw error
      return this.client.call("t3_thread_send", { threadId, message, mode: "queue" })
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
      this.account(run.threadId, run.trace.runIds)
      this.stopChain(run)
    }
    return true
  }

  get busy(): boolean {
    return this.runs.size > 0 || this.admitting.size > 0 || this.unprompted.size > 0
  }

  shutdown(): void {
    this.generation += 1
    for (const pending of this.admitting.values()) pending.abort.abort()
    for (const run of this.runs.values()) run.abort.abort()
    for (const relay of this.unprompted.values()) relay.abort.abort()
    this.runs.clear()
    this.unprompted.clear()
  }

  /**
   * Finds runs T3 started without a Threa message, as when background agents finish or a message is queued in T3
   * itself, and posts each one's reply to its stream once it ends.
   */
  async watch(): Promise<void> {
    if (this.watching) return
    this.watching = true
    const generation = this.generation
    try {
      for (const [streamId, threadId] of Object.entries(this.state.threads)) {
        if (!this.plaintextStreams.has(streamId) || this.unprompted.has(threadId) || this.hasOpenTurns(streamId))
          continue
        let runs: string[]
        try {
          runs = await this.unaccountedRuns(threadId)
          this.watchErrors.delete(threadId)
        } catch (error) {
          if (this.forgetIfGone(error, streamId, threadId)) continue
          const text = errorText(error)
          if (this.watchErrors.get(threadId) !== text) this.log(`watching thread ${threadId} failed: ${text}`)
          this.watchErrors.set(threadId, text)
          continue
        }
        if (this.generation !== generation) return
        // A turn that opened during the read owns what it saw, and a /clear during it let the thread go.
        if (this.hasOpenTurns(streamId) || this.threadFor(streamId) !== threadId) continue
        this.relayUnaccounted(streamId, threadId, runs)
      }
    } finally {
      this.watching = false
    }
  }

  /** Marks runs accounted for and returns the ones that weren't. */
  private account(threadId: string, runIds: Iterable<string>): string[] {
    const accounted = this.accounted.get(threadId) ?? new Set<string>()
    this.accounted.set(threadId, accounted)
    const fresh = [...runIds].filter((runId) => !accounted.has(runId))
    for (const runId of fresh) accounted.add(runId)
    return fresh
  }

  private isAccounted(threadId: string, runId: string): boolean {
    return this.accounted.get(threadId)?.has(runId) === true || this.turnOwns(threadId, runId)
  }

  /** A thread's read may pass an item no unaccounted run owns, since only a relay of that run still needs it. */
  private passable(threadId: string, item: ThreadItem): boolean {
    return item.runId === null || item.visibility !== "local" || this.isAccounted(threadId, item.runId)
  }

  /**
   * The thread's runs no turn or relay accounts for, oldest first. The first look at a thread accounts for every run
   * it finds, so a run from before the connector started is never posted.
   */
  private async unaccountedRuns(threadId: string): Promise<string[]> {
    const items: ThreadItem[] = []
    let latest: string | null = null
    let after = this.cursors.get(threadId)
    for (;;) {
      const page = await this.client.call("t3_thread_read", {
        threadId,
        view: "activity",
        limit: READ_PAGE_LIMIT,
        maxCharsPerItem: 1,
        ...(after === undefined ? {} : { afterPosition: after }),
      })
      latest = page.thread.latestRunId
      items.push(...page.items)
      if (!page.hasMore || page.nextPosition === null) break
      after = page.nextPosition
    }
    const runIds = new Set(
      items.flatMap((item) => (item.runId !== null && item.visibility === "local" ? [item.runId] : []))
    )
    if (latest) runIds.add(latest)
    if (!this.accounted.has(threadId)) this.account(threadId, runIds)
    let cursor: number | undefined
    for (const item of items) {
      if (!this.passable(threadId, item)) break
      cursor = item.position
    }
    this.advanceCursor(threadId, cursor)
    return [...runIds].filter((runId) => !this.isAccounted(threadId, runId))
  }

  /** Posts the replies of runs T3 started by itself, in order, after the ones already being relayed. */
  private relayUnaccounted(streamId: string, threadId: string, runIds: string[]): void {
    const fresh = this.account(threadId, runIds)
    const relay = this.unprompted.get(threadId)
    if (relay) relay.queue.push(...fresh)
    else this.relay(streamId, threadId, fresh)
  }

  private relay(streamId: string, threadId: string, runIds: string[], from = this.cursors.get(threadId)): void {
    const [runId, ...queue] = runIds
    if (!runId) return
    const relay: Relay = {
      runId,
      queue,
      from,
      abort: new AbortController(),
      read: { threadId, trace: new RunTrace(runId, this.options.traceMode), cursor: from },
    }
    this.unprompted.set(threadId, relay)
    void this.relayRuns(streamId, relay)
      .catch((error) => this.log(`run ${relay.runId} relay failed: ${errorText(error)}`))
      .finally(() => this.release(relay))
  }

  private relaying(threadId: string, runId: string): boolean {
    const relay = this.unprompted.get(threadId)
    return relay !== undefined && (relay.runId === runId || relay.queue.includes(runId))
  }

  private release(relay: Relay): void {
    if (this.unprompted.get(relay.read.threadId) === relay) this.unprompted.delete(relay.read.threadId)
  }

  private async relayRuns(streamId: string, relay: Relay): Promise<void> {
    for (;;) {
      this.log(`run ${relay.runId} started in T3 Code; posting its reply to ${streamId}`)
      await this.relayRun(streamId, relay)
      const next = relay.queue.shift()
      if (relay.abort.signal.aborted) return
      // Released in the tick the queue runs dry, so a run found meanwhile starts a relay of its own.
      if (!next) return this.release(relay)
      relay.runId = next
      relay.read = {
        threadId: relay.read.threadId,
        trace: new RunTrace(next, this.options.traceMode),
        cursor: relay.from,
      }
    }
  }

  private async relayRun(streamId: string, relay: Relay): Promise<void> {
    const { signal } = relay.abort
    const { read } = relay
    const { threadId, trace } = read
    let failures = 0
    try {
      while (!signal.aborted) {
        try {
          const waited = await this.client.call("t3_thread_wait", {
            threadId,
            runId: relay.runId,
            timeoutMs: WAIT_TIMEOUT_MS,
          })
          // A turn that took the run over posts its updates from here.
          if (signal.aborted) return
          const adopted = waited.runId && waited.runId !== relay.runId ? waited.runId : undefined
          // A turn's images restart the run as one the turn follows and replies with; this run's updates are still ours.
          const handedOver = adopted !== undefined && this.turnOwns(threadId, adopted)
          if (adopted && !handedOver) {
            this.account(threadId, [adopted])
            relay.queue = relay.queue.filter((queued) => queued !== adopted)
            relay.runId = adopted
            trace.runIds.add(adopted)
          }
          await this.drain(read, () => {})
          if (signal.aborted) return
          await this.postUpdates(read, (item, text) => this.postOrDrop(relay, streamId, text, `t3upd-${item.itemId}`))
          if (handedOver) return
          if (!adopted && TERMINAL_RUN_STATUSES.has(waited.status)) {
            await this.postFinal(streamId, relay, waited.status)
            return
          }
          failures = 0
        } catch (error) {
          if (signal.aborted) return
          failures += 1
          if (error instanceof T3ToolError) this.unlessGone(error, streamId, threadId)
          if (error instanceof T3AuthError || failures >= MAX_CONSECUTIVE_POLL_FAILURES) throw error
          await this.sleep(WAIT_TIMEOUT_MS)
        }
      }
    } finally {
      this.advanceCursor(threadId, read.cursor)
    }
  }

  private async postFinal(streamId: string, relay: Relay, status: string): Promise<void> {
    const { threadId, trace } = relay.read
    const clientMessageId = `t3run-${relay.runId}`
    if (status === "completed") {
      const text = trace.held ? await this.replyText(threadId, trace.held) : ""
      if (text.trim() && !isNoResponse(text)) await this.postOrDrop(relay, streamId, text, clientMessageId)
    } else if (status === "failed") {
      await this.postOrDrop(relay, streamId, trace.lastError ?? "The T3 Code run failed.", clientMessageId)
    } else {
      this.log(`run ${relay.runId} started in T3 Code ended ${status}`)
    }
  }

  /**
   * A post Threa refuses would be refused again, so it is dropped instead of retried. A relay aborted while it awaited
   * an earlier post or a text read posts nothing more.
   */
  private async postOrDrop(relay: Relay, streamId: string, text: string, clientMessageId: string): Promise<void> {
    if (relay.abort.signal.aborted) return
    try {
      await this.session.postToStream(streamId, text, clientMessageId)
    } catch (error) {
      if (!isTerminalPostError(error)) throw error
      this.log(`${clientMessageId} not posted to ${streamId}: ${errorText(error)}`)
    }
  }

  async deliverTurn(turn: DeliveredTurn): Promise<void> {
    const generation = this.generation
    const admission = new AbortController()
    this.admitting.set(turn.invocationId, { abort: admission, streamId: turn.streamId })
    let started: { threadId: string; runId: string }
    let stale: string[] = []
    let ahead: string[] = []
    if (turn.sealed) this.plaintextStreams.delete(turn.streamId)
    else this.plaintextStreams.add(turn.streamId)
    try {
      // A question an earlier turn left open belongs to that turn, not this one.
      const existing = this.threadFor(turn.streamId)
      if (existing) {
        const [pending, unaccounted] = await Promise.all([
          this.client.call("t3_pending_request_list", { threadId: existing }),
          this.unaccountedRuns(existing),
        ]).catch((error) => this.unlessGone(error, turn.streamId, existing))
        stale = pending.requestIds
        ahead = unaccounted
      }
      started = await this.admit(turn)
    } finally {
      this.admitting.delete(turn.invocationId)
    }
    const { threadId, runId } = started
    const aborted = admission.signal.aborted
    if (aborted) this.stopRun(threadId, runId)
    this.account(threadId, [runId])
    if (this.generation !== generation) return
    const relay = this.unprompted.get(threadId)
    const takenOver = !aborted && relay?.runId === runId ? relay : undefined
    if (relay) relay.queue = relay.queue.filter((queued) => queued !== runId)
    if (takenOver) {
      takenOver.abort.abort()
      this.unprompted.delete(threadId)
      if (!turn.sealed) this.relay(turn.streamId, threadId, takenOver.queue, takenOver.from)
    }
    // Runs T3 started by itself since the last look, which this turn's message queued behind. A post outside a turn
    // can't be sealed, so on a sealed stream they are only accounted for.
    if (turn.sealed) this.account(threadId, ahead)
    else this.relayUnaccounted(turn.streamId, threadId, ahead)
    if (aborted) return
    const mode: RunTraceMode = turn.sealed && this.options.sealedFullTrace ? "full" : this.options.traceMode
    const run: OpenRun = {
      ...started,
      streamId: turn.streamId,
      // Taking a relayed run over continues its trace, so the updates it already posted aren't posted again.
      trace: takenOver?.read.trace ?? new RunTrace(started.runId, mode),
      abort: new AbortController(),
      steers: new Set(),
      asked: new Set(stale),
      ...(takenOver
        ? { cursor: takenOver.read.cursor }
        : this.cursors.has(started.threadId)
          ? { cursor: this.cursors.get(started.threadId)! }
          : {}),
    }
    this.runs.set(turn.invocationId, run)
    void this.follow(turn.invocationId, run).catch((error) => {
      this.log(`run ${run.runId} follow failed: ${errorText(error)}`)
      this.stopChain(run)
      void this.session.failTurn(turn.invocationId, errorText(error)).catch(() => undefined)
    })
  }

  /**
   * A stream with a thread sends to it; a thread under the scratchpad forks the
   * scratchpad's thread so it starts with its context; anything else launches.
   */
  private async admit(turn: DeliveredTurn): Promise<{ threadId: string; runId: string }> {
    const existing = this.threadFor(turn.streamId)
    if (existing) return this.send(existing, turn).catch((error) => this.unlessGone(error, turn.streamId, existing))
    const root = this.session.rootStreamId
    const rootThread = root ? this.threadFor(root) : undefined
    // Only a thread under the scratchpad inherits; a mention elsewhere starts its own, so scratchpad context never leaks into a channel.
    if (rootThread && turn.streamId !== root && turn.rootStreamId === root) {
      const fork = await this.client
        .call("t3_thread_fork", {
          threadId: rootThread,
          sourcePoint: { type: "latest_stable" },
          title: titleFor(turn.content),
        })
        .catch((error) => this.unlessGone(error, turn.rootStreamId, rootThread))
      this.saveState({ ...this.state, threads: { ...this.state.threads, [turn.streamId]: fork.targetThreadId } })
      return this.send(fork.targetThreadId, turn)
    }
    const { projectId } = this.options
    // A scratch thread's project is new, so it has no default model to fall back on.
    if (projectId === undefined && !this.state.model) {
      throw new Error("T3 Code needs a model for new threads: pick one with /model.")
    }
    const place = projectId === undefined ? { scratch: true } : { projectId, ...(await this.workspaceFor()) }
    const images = await this.uploadImages(turn.attachments)
    const launched = await this.client.call("t3_thread_launch", {
      title: titleFor(turn.content),
      message: `${PREAMBLE}\n\n${turn.content}`,
      runtimeMode: this.options.access,
      ...place,
      ...(this.state.model ? { modelSelection: this.state.model } : {}),
      ...(images.length ? { attachments: images } : {}),
    })
    this.saveState({ ...this.state, threads: { ...this.state.threads, [turn.streamId]: launched.threadId } })
    if (!launched.runId) throw new Error("T3 Code created the thread but started no run.")
    return { threadId: launched.threadId, runId: launched.runId }
  }

  /** A project thread gets a T3-made worktree when the environment's default for new threads says so. */
  private async workspaceFor(): Promise<Pick<T3Tools["t3_thread_launch"]["args"], "workspaceStrategy">> {
    const { preferences } = await this.client.call("t3_environment_read", {})
    if (preferences.defaultThreadEnvMode !== "worktree") return {}
    return {
      workspaceStrategy: {
        type: "worktree",
        baseRef: "HEAD",
        startFromOrigin: preferences.newWorktreesStartFromOrigin,
      },
    }
  }

  /** Images go through T3's attachment send, which has no queue mode or retry key: it steers a steerable run, else starts one. */
  private async send(threadId: string, turn: DeliveredTurn): Promise<{ threadId: string; runId: string }> {
    const images = await this.uploadImages(turn.attachments)
    if (images.length) {
      const sent = await this.client.call("t3_thread_send_attachments", {
        threadId,
        message: turn.content,
        attachments: images,
      })
      return { threadId, runId: sent.runId }
    }
    const sent = await this.client.call("t3_thread_send", {
      threadId,
      message: turn.content,
      mode: "queue",
      clientRequestId: turn.invocationId,
    })
    return { threadId, runId: sent.runId }
  }

  /**
   * Uploads the images on the messages being sent, which T3 takes natively; context
   * messages' images were sent with their own turn. The manifest still lists every file by path.
   */
  private async uploadImages(attachments: DownloadedAttachment[]): Promise<ImageAttachment[]> {
    const uploaded: ImageAttachment[] = []
    const seen = new Set<string>()
    for (const { attachment, localPath, isSource } of attachments) {
      if (!isSource || !IMAGE_MIME_TYPES.has(attachment.mimeType) || seen.has(attachment.id)) continue
      seen.add(attachment.id)
      const skipped =
        uploaded.length === MAX_IMAGES_PER_MESSAGE
          ? `T3 takes ${MAX_IMAGES_PER_MESSAGE} per message`
          : imageSizeProblem((await stat(localPath)).size)
      if (skipped) {
        this.log(`${attachment.filename} reaches T3 only by path: ${skipped}`)
        continue
      }
      const bytes = await readFile(localPath)
      const upload = {
        type: "image" as const,
        name: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: bytes.byteLength,
      }
      const prepared = await this.client.call("t3_attachment_prepare_upload", { upload })
      await this.client.upload(prepared.relativeUrl, bytes)
      uploaded.push({ ...upload, id: prepared.attachmentId })
    }
    return uploaded
  }

  /** A thread deleted in T3 is forgotten, so the stream's next message launches a new one instead of failing forever. */
  private unlessGone(error: unknown, streamId: string, threadId: string): never {
    if (!this.forgetIfGone(error, streamId, threadId)) throw error
    throw new Error(`T3 Code thread \`${threadId}\` is gone; the next message starts a new one.`)
  }

  private forgetIfGone(error: unknown, streamId: string, threadId: string): boolean {
    if (!(error instanceof T3ToolError) || error.code !== "thread_not_found") return false
    if (this.threadFor(streamId) === threadId) this.forgetThread(streamId)
    return true
  }

  private turnOwns(threadId: string, runId: string): boolean {
    return [...this.runs.values()].some((run) => run.threadId === threadId && run.trace.runIds.has(runId))
  }

  private stopRun(threadId: string, runId: string): void {
    void this.client.call("t3_thread_interrupt", { threadId, runId, reason: "Stopped from Threa" }).catch((error) => {
      this.log(`run ${runId} stop failed: ${errorText(error)}`)
    })
  }

  /** A steer T3 queued as its own run is still part of the turn, and interrupting a finished run is a no-op. */
  private stopChain(run: OpenRun): void {
    for (const runId of run.trace.runIds) this.stopRun(run.threadId, runId)
  }

  private async follow(invocationId: string, run: OpenRun): Promise<void> {
    const { trace } = run
    const batcher = new StepBatcher(invocationId, this.session)
    const { signal } = run.abort
    let status: RunStatus | "idle" | undefined
    let failures = 0
    let cardWaits = 0
    try {
      while (!signal.aborted && !trace.blockedOn && !run.unanswered) {
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
          await this.drain(run, (frame) =>
            frame.phase === "started"
              ? void batcher.addNow(frame, trace.statusText)
              : batcher.add(frame, trace.statusText)
          )
          await this.postUpdates(run, async (_item, text) => {
            const result = await this.session.sendInterim(invocationId, text)
            if (result.ok) return
            if (result.retryable) throw new Error(`update not posted: ${result.message}`)
            this.log(`run ${run.runId} update not posted: ${result.message}`)
          })
          await this.withdrawAnsweredCard(run)
          if (trace.questions.size > 0 && !run.asking) this.askQuestions(invocationId, run)
          failures = 0
          status = waited.status
          if (TERMINAL_RUN_STATUSES.has(status) && run.runId === waitedOn) {
            if (run.steers.size > 0) {
              await Promise.allSettled(run.steers)
              continue
            }
            // A run can end with its question still open, as Codex's async questions do, or with the answer
            // queued behind it. The answer starts the run that carries on, so the turn follows that one.
            if (run.asking) {
              run.endedAsking = true
              // Only the card is left; T3 is checked less often the longer it goes unanswered.
              const wait = Math.min(WAIT_TIMEOUT_MS * 2 ** cardWaits++, MAX_CARD_WAIT_MS)
              await Promise.race([run.asking.done, this.sleep(wait)])
              if (run.asking || run.unanswered || signal.aborted) continue
            }
            const next = run.answerRunId ?? (run.endedAsking ? await this.latestRunId(run.threadId) : undefined)
            if (!next || next === run.runId) break
            run.endedAsking = false
            run.answerRunId = undefined
            cardWaits = 0
            adopt(run, next)
          }
        } catch (error) {
          if (signal.aborted) break
          failures += 1
          if (error instanceof T3ToolError) this.unlessGone(error, run.streamId, run.threadId)
          if (error instanceof T3AuthError) throw error
          if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) throw error
          this.log(`run ${run.runId} poll failed (${failures}): ${errorText(error)}`)
          await this.sleep(WAIT_TIMEOUT_MS)
        }
      }
    } finally {
      run.asking?.abort.abort()
      // Released before any await, so a steer can't join a run already judged over, and before the
      // turn closes, so a command right after the reply sees no open run.
      if (this.runs.get(invocationId) === run) this.runs.delete(invocationId)
      this.account(run.threadId, run.trace.runIds)
      await batcher.flush()
      this.advanceCursor(run.threadId, run.cursor)
    }
    if (signal.aborted) return
    if (run.unanswered) {
      this.stopChain(run)
      await this.session.failTurn(invocationId, run.unanswered)
      return
    }
    if (trace.blockedOn) {
      this.stopChain(run)
      await this.session.failTurn(
        invocationId,
        `T3 Code stopped to ask for ${BLOCKING_LABELS[trace.blockedOn]}, which Threa can't answer yet. Give the connector full-access (t3Access) so runs never wait on one.`
      )
      return
    }
    await this.settle(invocationId, run, status!)
  }

  /** A card whose request left T3's pending list was answered in T3 itself, so it comes down. */
  private async withdrawAnsweredCard(run: OpenRun): Promise<void> {
    const requestId = run.asking?.requestId
    if (!requestId) return
    const { requestIds } = await this.client.call("t3_pending_request_list", { threadId: run.threadId })
    const asking = run.asking
    if (requestIds.includes(requestId) || asking?.requestId !== requestId) return
    asking.abort.abort()
    await asking.done
  }

  /**
   * Put each question T3 is waiting on to the user as a card, one at a time, and send the
   * answers back. Any question left without an answer ends the turn.
   */
  private askQuestions(invocationId: string, run: OpenRun): void {
    const abort = new AbortController()
    const signal = AbortSignal.any([abort.signal, run.abort.signal])
    const asking: NonNullable<OpenRun["asking"]> = { abort, done: Promise.resolve() }
    run.asking = asking
    asking.done = (async () => {
      try {
        const { requestIds } = await this.client.call("t3_pending_request_list", { threadId: run.threadId })
        for (const requestId of requestIds) {
          if (run.asked.has(requestId)) continue
          asking.requestId = requestId
          const read = await this.whilePending(run, requestId, () =>
            this.client.call("t3_pending_request_read", { threadId: run.threadId, requestId })
          )
          if (!read) continue
          const { questions } = read.result
          const answers: Record<string, string> = {}
          for (const [index, question] of questions.entries()) {
            // T3 refuses a reply with no answers, so the last optional question can't be skipped too.
            const skippable =
              Object.keys(answers).length > 0 || questions.slice(index + 1).some((later) => later.required !== false)
            const card = questionCard(question, { skippable })
            for (;;) {
              // The card posts before the SDK checks the signal.
              if (signal.aborted) return
              const typed = Promise.withResolvers<CardAnswer>()
              const withdraw = new AbortController()
              if (card.input.allowNote) {
                asking.answerTyped = (text) => {
                  if (!text.trim()) return false
                  asking.answerTyped = undefined
                  typed.resolve({ kind: "answered", text: text.trim() })
                  withdraw.abort()
                  return true
                }
              }
              const decided = this.session
                .requestDecision(
                  { ...card.input, streamId: run.streamId, invocationId, externalRef: requestId },
                  { signal: AbortSignal.any([signal, withdraw.signal]) }
                )
                .then((outcome) => card.answerFor(outcome))
              const answer = await Promise.race([decided, typed.promise]).finally(() => {
                asking.answerTyped = undefined
              })
              if (answer.kind === "blank") continue
              if (answer.kind === "unanswered") {
                run.unanswered = UNANSWERED_MESSAGE
                return
              }
              if (answer.kind === "answered") answers[question.id] = answer.text
              break
            }
          }
          // An answer to a question asked as a message starts a run; one the user queued in T3 meanwhile isn't it.
          const before = await this.latestRunId(run.threadId)
          const sent = await this.whilePending(run, requestId, () =>
            this.client.call("t3_pending_request_respond", { threadId: run.threadId, requestId, answers })
          )
          run.asked.add(requestId)
          if (!sent) continue
          const after = await this.latestRunId(run.threadId)
          // The turn follows the last answer's run; earlier ones still belong to it.
          if (after && after !== before) {
            run.answerRunId = after
            run.trace.runIds.add(after)
          }
        }
      } catch (error) {
        if (signal.aborted) return
        // An archived scratchpad abandons the card without stopping the run.
        run.unanswered =
          error instanceof DecisionAbandonedError
            ? UNANSWERED_MESSAGE
            : `T3 Code's question couldn't be answered from Threa: ${errorText(error)}`
      } finally {
        if (run.asking === asking) run.asking = undefined
      }
    })()
  }

  /** A call on a request that fails because the request was answered or dismissed in T3 meanwhile gives undefined. */
  private async whilePending<T>(
    run: OpenRun,
    requestId: string,
    call: () => Promise<T>
  ): Promise<{ result: T } | undefined> {
    try {
      return { result: await call() }
    } catch (error) {
      const { requestIds } = await this.client.call("t3_pending_request_list", { threadId: run.threadId })
      if (requestIds.includes(requestId)) throw error
      return undefined
    }
  }

  private async latestRunId(threadId: string): Promise<string | undefined> {
    const { thread } = await this.client.call("t3_thread_read", { threadId, limit: 1 })
    return thread.latestRunId ?? undefined
  }

  /** Read the thread's activity past the run's cursor; the cursor stops at the run's first unsettled item. */
  private async drain(
    run: Pick<OpenRun, "threadId" | "trace" | "cursor">,
    emit: (frame: StepFrame) => void
  ): Promise<void> {
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
      this.noteModel(page.thread)
      for (const item of page.items) {
        for (const frame of trace.observe(item)) emit(frame)
        // A run no turn or relay accounts for yet keeps its items ahead of the cursor for the next look.
        if (trace.owns(item) ? OPEN_ITEM_STATUSES.has(item.status ?? "") : !this.passable(run.threadId, item)) {
          advancing = false
        }
        if (advancing) run.cursor = item.position
      }
      if (!page.hasMore || page.nextPosition === null) return
      after = page.nextPosition
    }
  }

  private advanceCursor(threadId: string, cursor: number | undefined): void {
    if (cursor !== undefined && cursor > (this.cursors.get(threadId) ?? -1)) this.cursors.set(threadId, cursor)
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
    const text = trace.held ? await this.replyText(run.threadId, trace.held) : ""
    const result = await this.session.reply(invocationId, text)
    if (!result.ok) this.log(`run ${run.runId} reply ${result.retryable ? "deferred" : "refused"}: ${result.message}`)
  }

  private async replyText(threadId: string, item: ThreadItem): Promise<string> {
    return withoutUpdatePrefix(await this.fullText(threadId, item))
  }

  private async postUpdates(
    run: Pick<OpenRun, "threadId" | "trace">,
    post: (item: ThreadItem, text: string) => Promise<void>
  ): Promise<void> {
    const { updates } = run.trace
    // Taken before posting, so a relay and the turn that took its run over never post one twice.
    for (let item = updates.shift(); item; item = updates.shift()) {
      try {
        const text = await this.replyText(run.threadId, item)
        if (text) await post(item, text)
      } catch (error) {
        updates.unshift(item)
        throw error
      }
    }
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

function imageSizeProblem(size: number): string | undefined {
  if (size === 0) return "it is empty"
  if (size > MAX_IMAGE_BYTES) return "it is over 10 MiB"
  return undefined
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
