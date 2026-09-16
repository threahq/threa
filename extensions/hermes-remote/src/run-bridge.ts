import { createHash } from "node:crypto"
import {
  DecisionAbandonedError,
  type DecisionOutcome,
  type DecisionRequestInput,
  type DeliveredTurn,
  type RuntimeDescriptor,
  type SendResult,
  type StepFrame,
} from "@threahq/remote-session"
import { HermesApiError, type HermesRunEvent, type HermesRunsClient, type RunStatus } from "./hermes-client"

/** The slice of `RemoteSession` the bridge drives, so tests can stand in a fake. */
export interface BridgeSession {
  readonly rootStreamId?: string
  recordSteps(invocationId: string, frames: StepFrame[], statusText?: string): Promise<boolean>
  reply(invocationId: string, text: string): Promise<SendResult>
  failTurn(invocationId: string, errorMessage: string): Promise<boolean>
  requestDecision(input: DecisionRequestInput, opts?: { signal?: AbortSignal }): Promise<DecisionOutcome>
}

/** What survives a restart: the per-stream `/clear` count, and which conversations were forked from the root. */
export interface ConversationState {
  generations: Record<string, number>
  forked: string[]
}

export interface ConversationStore {
  load(): ConversationState
  save(state: ConversationState): void
}

export const HERMES_RUNTIME: RuntimeDescriptor = {
  kind: "hermes",
  manifest: { output: { reply: true, trace: true, sources: false } },
  busyStatusText: "Working in Hermes…",
  forwardedNote: "Forwarded to Hermes.",
  shutdownErrorMessage: "Hermes connector shut down",
}

const FLUSH_DELAY_MS = 500
const TERMINAL_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled"])
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"])
const STATUS_POLL_MS = 2000
// A gateway restart takes a few seconds; five misses in a row (10 s) is a dead gateway, not a blip.
const MAX_CONSECUTIVE_POLL_FAILURES = 5
const NO_RESPONSE_SENTINEL = "THREA_NO_RESPONSE"
const STEER_REJECTED_CODE = "run_not_accepting_steer"
// Hermes's default `approvals.timeout`: past it the gateway denies the command itself, so the card must not outlive it.
const APPROVAL_CARD_EXPIRES_MS = 300_000
const APPROVAL_OPTION_LABELS: Record<string, { label: string; tone?: "primary" | "destructive" }> = {
  once: { label: "Allow once", tone: "primary" },
  session: { label: "Allow this session" },
  always: { label: "Always allow" },
  deny: { label: "Deny", tone: "destructive" },
}
const MEDIA_LINE_RE = /^MEDIA:[ \t]*(.+)$/gm

export interface HermesTurnRunnerOptions {
  client: HermesRunsClient
  session: BridgeSession
  /** X-Hermes-Session-Key for a stream tree, keyed by the turn's root stream. */
  sessionKeyFor(rootStreamId: string): string
  log?: (message: string) => void
  /** Injectable for tests; paces the status poll that replaces a lost event stream. */
  sleep?: (ms: number) => Promise<void>
  conversationStore?: ConversationStore
}

/** A run being consumed: what the event stream and the status poll both act on. */
interface ConsumedRun {
  runId: string
  streamId: string
  sealed: boolean
  batcher: StepBatcher
  signal: AbortSignal
  answered: Set<string>
}

interface OpenRun {
  runId: string
  streamId: string
  abort: AbortController
}

/** Buffers trace frames so a chatty run does not post one steps call per tool event. */
class StepBatcher {
  private frames: StepFrame[] = []
  private timer?: ReturnType<typeof setTimeout>
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly invocationId: string,
    private readonly session: BridgeSession
  ) {}

  add(frame: StepFrame): void {
    this.frames.push(frame)
    this.timer ??= setTimeout(() => void this.flush(), FLUSH_DELAY_MS)
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.frames.length === 0) return this.tail
    const batch = this.frames
    this.frames = []
    // recordSteps chunks to the wire limit and logs its own failures.
    this.tail = this.tail.then(async () => {
      await this.session.recordSteps(this.invocationId, batch)
    })
    return this.tail
  }
}

/** Rewrite Hermes' `MEDIA:` output lines into the directive the SDK uploads attachments from. */
export function rewriteMediaDirectives(output: string): string {
  return output.replace(MEDIA_LINE_RE, (_line, path: string) => `THREA_ATTACH: ${path}`)
}

export function replyTextFor(output: string): string {
  return output.trim() === NO_RESPONSE_SENTINEL ? "" : rewriteMediaDirectives(output)
}

/**
 * Hermes replays a key only for a byte-identical body and answers a changed body
 * with a 409 it keeps for 24 h. A redelivered invocation rebuilds its content
 * (fold set, attachment manifest), so the key carries the content too: the same
 * body replays, a different one starts a fresh run instead of a permanent 409.
 */
export function idempotencyKeyFor(invocationId: string, input: string): string {
  const digest = createHash("sha256").update(input).digest("hex").slice(0, 16)
  return `${invocationId}.${digest}`
}

export function approvalBody(command: string, description?: string): string {
  const fenced = ["```sh", command, "```"].join("\n")
  return description ? `${fenced}\n\n${description}` : fenced
}

export function approvalOptions(choices: readonly string[]): DecisionRequestInput["options"] {
  return choices.flatMap((choice) => {
    const option = APPROVAL_OPTION_LABELS[choice]
    if (!option) return []
    return [{ id: choice, label: option.label, ...(option.tone ? { tone: option.tone } : {}) }]
  })
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function seconds(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : undefined
}

export function frameForEvent(event: HermesRunEvent): StepFrame | undefined {
  switch (event.event) {
    case "tool.started": {
      const tool = text(event.tool) ?? "tool"
      const preview = text(event.preview)
      return { stepType: "tool_call", content: preview ? `${tool}: ${preview}` : tool }
    }
    case "tool.completed": {
      const tool = text(event.tool) ?? "tool"
      const outcome = event.error === true ? "failed" : "done"
      const duration = seconds(event.duration)
      const head = duration ? `${tool} ${outcome} (${duration}s)` : `${tool} ${outcome}`
      const preview = text(event.preview)
      return { stepType: "tool_call", content: preview ? `${head}: ${preview}` : head }
    }
    case "subagent.start": {
      const label = text(event.summary) ?? text(event.delegation_id)
      return { stepType: "thinking", content: label ? `Subagent started: ${label}` : "Subagent started" }
    }
    case "subagent.complete": {
      const status = text(event.status) ?? "finished"
      const summary = text(event.summary)
      return { stepType: "thinking", content: summary ? `Subagent ${status}: ${summary}` : `Subagent ${status}` }
    }
    default:
      return undefined
  }
}

/**
 * One Threa turn to one Hermes run. `deliverTurn` resolves at admission; the run
 * is then consumed in the background, its tool events traced as steps and its
 * terminal event closing the Threa turn.
 */
export class HermesTurnRunner {
  private readonly client: HermesRunsClient
  private readonly session: BridgeSession
  private readonly sessionKeyFor: (rootStreamId: string) => string
  private readonly log: (message: string) => void
  private readonly sleep: (ms: number) => Promise<void>
  private readonly conversationStore: ConversationStore | undefined
  private generations: Record<string, number>
  private readonly forked: Set<string>
  private readonly pendingSteers = new Map<string, string[]>()
  // Steer text for an open run that was not `running` when it arrived (queued,
  // parked on an approval): sent once the run resumes, else carried to the next turn.
  private readonly runSteers = new Map<string, string[]>()
  private readonly steerFlushes = new Map<string, Promise<void>>()
  // Turns inside createRun: an interrupt or shutdown that lands during admission
  // marks them here, and the run is stopped the moment Hermes returns its id.
  private readonly admitting = new Map<string, AbortController>()
  readonly runs = new Map<string, OpenRun>()

  constructor(options: HermesTurnRunnerOptions) {
    this.client = options.client
    this.session = options.session
    this.sessionKeyFor = options.sessionKeyFor
    this.log = options.log ?? (() => {})
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.conversationStore = options.conversationStore
    const state = options.conversationStore?.load()
    this.generations = state?.generations ?? {}
    this.forked = new Set(state?.forked ?? [])
  }

  /** The Hermes conversation for a stream: the stream id, suffixed once per `/clear`. */
  conversationFor(streamId: string): string {
    const generation = this.generations[streamId] ?? 0
    return generation === 0 ? streamId : `${streamId}.${generation}`
  }

  /** Start a fresh conversation on a stream; returns the new conversation id. */
  bumpConversation(streamId: string): string {
    const next = { ...this.generations, [streamId]: (this.generations[streamId] ?? 0) + 1 }
    this.conversationStore?.save({ generations: next, forked: [...this.forked] })
    this.generations = next
    return this.conversationFor(streamId)
  }

  /** Runs still inside admission count too: they have no run id yet but will. */
  hasOpenTurns(): boolean {
    return this.runs.size > 0 || this.admitting.size > 0
  }

  openRuns(): Array<{ invocationId: string; runId: string; streamId: string }> {
    return [...this.runs.entries()].map(([invocationId, run]) => ({
      invocationId,
      runId: run.runId,
      streamId: run.streamId,
    }))
  }

  /**
   * Fold text into every open run. A run Hermes will not steer right now
   * (queued, or parked on an approval) is not a failure: the text waits for the
   * run to resume, and if it settles first it is prepended to the next turn.
   */
  async steer(text: string): Promise<boolean> {
    const open = this.openRuns()
    if (open.length === 0) return false
    for (const run of open) {
      try {
        await this.steerOrHold(run.runId, text)
      } catch (error) {
        this.log(`run ${run.runId} steer failed: ${this.summarize(error)}`)
        return false
      }
    }
    return true
  }

  /** Throws only for a failure other than the run not accepting steer yet. */
  private async steerOrHold(runId: string, text: string): Promise<void> {
    const held = this.runSteers.get(runId)
    if (held) {
      held.push(text)
      return
    }
    try {
      await this.client.steerRun(runId, text)
    } catch (error) {
      if (!(error instanceof HermesApiError && error.code === STEER_REJECTED_CODE)) throw error
      const waiting = this.runSteers.get(runId)
      if (waiting) waiting.push(text)
      else this.runSteers.set(runId, [text])
    }
  }

  /**
   * Send the steer text a run held while it was not `running`, in arrival order.
   * One send at a time per run: text stays held until Hermes takes it, so a steer
   * arriving mid-flush queues behind it and a run that ends mid-flush keeps the rest.
   */
  private flushRunSteers(runId: string): Promise<void> {
    const inFlight = this.steerFlushes.get(runId)
    if (inFlight) return inFlight
    const flush = this.sendHeldSteers(runId).finally(() => this.steerFlushes.delete(runId))
    this.steerFlushes.set(runId, flush)
    return flush
  }

  private async sendHeldSteers(runId: string): Promise<void> {
    const held = this.runSteers.get(runId)
    if (!held) return
    while (held.length > 0) {
      try {
        await this.client.steerRun(runId, held[0]!)
      } catch (error) {
        if (error instanceof HermesApiError && error.code === STEER_REJECTED_CODE) return
        this.log(`run ${runId} held steer failed: ${this.summarize(error)}`)
      }
      held.shift()
    }
    if (this.runSteers.get(runId) === held) this.runSteers.delete(runId)
  }

  /**
   * Stop every open run and drop it here first: the SDK closes the turn as
   * interrupted, so the consumer must never come back and reply to it.
   */
  interrupt(): boolean {
    try {
      for (const pending of this.admitting.values()) pending.abort()
      for (const [invocationId, run] of [...this.runs.entries()]) {
        void this.client.stopRun(run.runId).catch((error) => {
          this.log(`run ${run.runId} stop failed: ${this.summarize(error)}`)
        })
        run.abort.abort()
        this.runs.delete(invocationId)
      }
      return true
    } catch (error) {
      this.log(`interrupt failed: ${this.summarize(error)}`)
      return false
    }
  }

  private holdSteer(streamId: string, text: string): void {
    const held = this.pendingSteers.get(streamId) ?? []
    held.push(text)
    this.pendingSteers.set(streamId, held)
  }

  private inputFor(turn: DeliveredTurn): string {
    const held = this.pendingSteers.get(turn.streamId)
    if (!held || held.length === 0) return turn.content
    return `${turn.content}\n\n[Steer that arrived between turns]\n${held.join("\n")}`
  }

  /**
   * A stream that is not the scratchpad root runs in its own Hermes conversation,
   * forked once from the root's so a thread starts with the scratchpad's context.
   * A later `/clear` on the root bumps the root only; an existing fork stays.
   * Throws on any fork failure other than a missing source (a routing 404 is a gateway
   * without the fork endpoint, not a missing source), and the SDK's delivery catch fails the
   * turn once with that message.
   */
  private async ensureConversation(turn: DeliveredTurn): Promise<void> {
    const root = this.session.rootStreamId
    // Only a thread under the scratchpad inherits its conversation; a mention
    // elsewhere starts its own, so scratchpad context never leaks into a channel.
    if (!root || turn.streamId === root || turn.rootStreamId !== root) return
    const forkId = this.conversationFor(turn.streamId)
    if (this.forked.has(forkId)) return
    const sourceId = this.conversationFor(root)
    try {
      await this.client.forkSession(sourceId, forkId)
    } catch (error) {
      if (error instanceof HermesApiError && error.status === 404 && error.code === "session_not_found") {
        this.log(`conversation ${sourceId} does not exist yet; ${forkId} starts fresh instead of forking`)
      } else if (error instanceof HermesApiError && error.code === "session_exists") {
        this.log(`conversation ${forkId} was already forked`)
      } else {
        throw new Error(`Hermes could not fork ${sourceId}: ${this.summarize(error)}`)
      }
    }
    this.conversationStore?.save({ generations: { ...this.generations }, forked: [...this.forked, forkId] })
    this.forked.add(forkId)
  }

  async deliverTurn(turn: DeliveredTurn): Promise<void> {
    await this.ensureConversation(turn)
    const abort = new AbortController()
    const input = this.inputFor(turn)
    const admission = new AbortController()
    this.admitting.set(turn.invocationId, admission)
    let created: Awaited<ReturnType<HermesRunsClient["createRun"]>>
    try {
      created = await this.client.createRun(
        {
          input,
          sessionId: this.conversationFor(turn.streamId),
          idempotencyKey: idempotencyKeyFor(turn.invocationId, input),
          sessionKey: this.sessionKeyFor(turn.rootStreamId),
        },
        abort.signal
      )
    } finally {
      this.admitting.delete(turn.invocationId)
    }
    // Held steer text is consumed only by an admitted run; a failed admission
    // keeps it for the retry.
    this.pendingSteers.delete(turn.streamId)
    if (admission.signal.aborted) {
      void this.client.stopRun(created.runId).catch((error) => {
        this.log(`run ${created.runId} stop after interrupted admission failed: ${this.summarize(error)}`)
      })
      return
    }
    this.runs.set(turn.invocationId, { runId: created.runId, streamId: turn.streamId, abort })
    // A replayed admission points at a run whose event transport may be gone
    // already (Hermes drops it when the first subscriber leaves), so its status
    // is the source of truth from the start.
    void this.consume(
      turn.invocationId,
      created.runId,
      turn.streamId,
      turn.sealed === true,
      abort,
      created.replayed
    ).catch((error) => {
      this.log(`run ${created.runId} bridge failed: ${this.summarize(error)}`)
      void this.session.failTurn(turn.invocationId, this.summarize(error)).catch(() => undefined)
    })
  }

  /** Abort every open subscription; the SDK's own shutdown fails the turns. */
  shutdown(): void {
    for (const pending of this.admitting.values()) pending.abort()
    for (const run of this.runs.values()) run.abort.abort()
    this.runs.clear()
  }

  private async consume(
    invocationId: string,
    runId: string,
    streamId: string,
    sealed: boolean,
    abort: AbortController,
    replayed: boolean
  ): Promise<void> {
    const batcher = new StepBatcher(invocationId, this.session)
    const run: ConsumedRun = { runId, streamId, sealed, batcher, signal: abort.signal, answered: new Set() }
    let terminal: HermesRunEvent | undefined
    try {
      terminal = replayed ? undefined : await this.drain(run)
      terminal ??= await this.awaitStatus(run)
      await batcher.flush()
      if (terminal && !abort.signal.aborted) await this.settle(invocationId, terminal)
    } catch (error) {
      // Shutdown aborts the poll mid-flight; the SDK's own shutdown fails the turn.
      if (abort.signal.aborted) return
      throw error
    } finally {
      await batcher.flush()
      // A settled run can still hold an unanswered approval card; aborting withdraws it.
      abort.abort()
      await this.steerFlushes.get(runId)
      const pendingSteer = text(terminal?.pending_steer)
      const unsent = [...(this.runSteers.get(runId) ?? []), ...(pendingSteer === undefined ? [] : [pendingSteer])]
      this.runSteers.delete(runId)
      for (const steer of unsent) this.holdSteer(streamId, steer)
      const open = this.runs.get(invocationId)
      if (open?.runId === runId) this.runs.delete(invocationId)
    }
  }

  /**
   * The event stream is gone (it ended early, or the run was replayed): Hermes
   * drops a run's transport once its subscriber leaves, so a resubscribe 404s.
   * The run itself carries on, and its status record survives, so poll that
   * until it settles. Returns undefined only when the subscription was aborted.
   */
  private async awaitStatus(run: ConsumedRun): Promise<HermesRunEvent | undefined> {
    const { runId, signal } = run
    let failures = 0
    for (;;) {
      if (signal.aborted) return undefined
      try {
        const status = await this.client.getRun(runId, signal)
        if (TERMINAL_STATUSES.has(status.status)) return terminalFromStatus(status)
        if (status.approval) this.answerApproval(run, status.approval)
        if (status.status === "running") await this.flushRunSteers(runId)
        failures = 0
      } catch (error) {
        if (signal.aborted) return undefined
        failures += 1
        if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) throw error
        this.log(`run ${runId} status poll failed (${failures}): ${this.summarize(error)}`)
      }
      await this.sleep(STATUS_POLL_MS)
    }
  }

  /** Consume one subscription; returns the terminal event if the stream carried one. */
  private async drain(run: ConsumedRun): Promise<HermesRunEvent | undefined> {
    const { runId, batcher, signal } = run
    let terminal: HermesRunEvent | undefined
    try {
      for await (const event of this.client.streamEvents(runId, signal)) {
        if (signal.aborted) return undefined
        if (event.event === "approval.request") {
          this.answerApproval(run, event)
          continue
        }
        if (TERMINAL_EVENTS.has(event.event)) {
          terminal = event
          break
        }
        void this.flushRunSteers(runId)
        const frame = frameForEvent(event)
        if (frame && frame.content.length > 0) batcher.add(frame)
      }
    } catch (error) {
      if (signal.aborted) return undefined
      this.log(`run ${runId} event stream lost, falling back to its status: ${this.summarize(error)}`)
    }
    return terminal
  }

  private async settle(invocationId: string, terminal: HermesRunEvent): Promise<void> {
    if (terminal.event === "run.failed") {
      const reason = text(terminal.error) ?? "Hermes run failed"
      if (!(await this.session.failTurn(invocationId, reason))) {
        this.log(`turn ${invocationId} was already closed; run failure not recorded: ${reason}`)
      }
      return
    }
    const replyText =
      terminal.event === "run.cancelled" ? "" : replyTextFor(typeof terminal.output === "string" ? terminal.output : "")
    const result = await this.session.reply(invocationId, replyText)
    // The SDK returns refusals instead of throwing; a run that outlived its turn
    // (idle timeout, superseded) would otherwise vanish without a trace.
    if (!result.ok)
      this.log(`run ${terminal.run_id} reply ${result.retryable ? "deferred" : "refused"}: ${result.message}`)
  }

  /**
   * The same approval reaches us from the event stream and, after a fallback,
   * from the status record; it is carded once per request id. The run is parked
   * until it is answered, so the card resolves off the caller's loop.
   */
  private answerApproval(run: ConsumedRun, event: HermesRunEvent): void {
    const requestId = text(event.request_id)
    if (requestId) {
      if (run.answered.has(requestId)) return
      run.answered.add(requestId)
    }
    run.batcher.add({ stepType: "tool_call", content: `Waiting for approval: ${text(event.command) ?? "a command"}` })
    void this.resolveApproval(run, event)
  }

  /**
   * Answer one `approval.request` through a Threa decision card. Every exit
   * except a successful answer leaves the gateway's own approval timeout to
   * deny the command, so a lost card never parks the run forever.
   */
  private async resolveApproval(run: ConsumedRun, event: HermesRunEvent): Promise<void> {
    const { runId, streamId, batcher, signal } = run
    const choices = Array.isArray(event.choices) ? event.choices.flatMap((c) => text(c) ?? []) : []
    const requestId = text(event.request_id)
    const command = text(event.command) ?? "(command withheld)"
    if (run.sealed) {
      batcher.add({
        stepType: "tool_error",
        content: `Approval denied: this scratchpad is encrypted and decision cards cannot be shown there yet (${command})`,
      })
      try {
        await this.client.respondApproval(runId, { choice: "deny", ...(requestId ? { requestId } : {}) })
      } catch (error) {
        this.log(`run ${runId} sealed approval denial failed: ${this.summarize(error)}`)
        return
      }
      await this.flushRunSteers(runId)
      return
    }
    const options = approvalOptions(choices)
    if (options.length === 0) {
      this.log(`run ${runId} approval request carried no usable choices`)
      return
    }
    let outcome: DecisionOutcome
    try {
      outcome = await this.session.requestDecision(
        {
          title: "Hermes wants to run a command",
          body: approvalBody(command, text(event.description)),
          options,
          allowNote: true,
          streamId,
          expiresInMs: APPROVAL_CARD_EXPIRES_MS,
          ...(requestId ? { externalRef: requestId } : {}),
        },
        { signal }
      )
    } catch (error) {
      if (error instanceof DecisionAbandonedError) return
      this.log(`run ${runId} approval card failed: ${this.summarize(error)}`)
      return
    }
    const choice = outcome.status === "resolved" ? outcome.optionId : "deny"
    const note = outcome.status === "resolved" ? outcome.note : null
    try {
      await this.client.respondApproval(runId, { choice, ...(requestId ? { requestId } : {}) })
    } catch (error) {
      this.log(`run ${runId} approval response failed: ${this.summarize(error)}`)
      return
    }
    await this.flushRunSteers(runId)
    if (choice !== "deny" || !note) return
    try {
      await this.steerOrHold(runId, `The user denied this and said: ${note}`)
    } catch (error) {
      this.log(`run ${runId} denial note could not be steered in: ${this.summarize(error)}`)
    }
  }

  private summarize(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}

function terminalFromStatus(status: RunStatus): HermesRunEvent {
  return {
    event: `run.${status.status === "interrupted" ? "failed" : status.status}`,
    run_id: status.runId,
    ...(status.output === undefined ? {} : { output: status.output }),
    ...(status.error === undefined ? {} : { error: status.error }),
    ...(status.pendingSteer === undefined ? {} : { pending_steer: status.pendingSteer }),
    ...(status.status === "interrupted" && status.error === undefined
      ? { error: "The Hermes gateway restarted before this run settled." }
      : {}),
  }
}
