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

/** Where the per-stream conversation generation (`/clear` count) survives a restart. */
export interface ConversationStore {
  load(): Record<string, number>
  save(generations: Record<string, number>): void
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
  sessionKeyFor(streamId: string): string
  log?: (message: string) => void
  /** Injectable for tests; paces the status poll that replaces a lost event stream. */
  sleep?: (ms: number) => Promise<void>
  conversationStore?: ConversationStore
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
  private readonly sessionKeyFor: (streamId: string) => string
  private readonly log: (message: string) => void
  private readonly sleep: (ms: number) => Promise<void>
  private readonly conversationStore: ConversationStore | undefined
  private readonly generations: Record<string, number>
  private readonly pendingSteers = new Map<string, string[]>()
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
    this.generations = options.conversationStore?.load() ?? {}
  }

  /** The Hermes conversation for a stream: the stream id, suffixed once per `/clear`. */
  conversationFor(streamId: string): string {
    const generation = this.generations[streamId] ?? 0
    return generation === 0 ? streamId : `${streamId}.${generation}`
  }

  /** Start a fresh conversation on a stream; returns the new conversation id. */
  bumpConversation(streamId: string): string {
    this.generations[streamId] = (this.generations[streamId] ?? 0) + 1
    this.conversationStore?.save({ ...this.generations })
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
   * (queued, or already finishing) is not a failure: the text is held and
   * prepended to the next turn on that stream instead of being lost.
   */
  async steer(text: string): Promise<boolean> {
    const open = this.openRuns()
    if (open.length === 0) return false
    for (const run of open) {
      try {
        await this.client.steerRun(run.runId, text)
      } catch (error) {
        if (error instanceof HermesApiError && error.code === STEER_REJECTED_CODE) {
          this.holdSteer(run.streamId, text)
          continue
        }
        this.log(`run ${run.runId} steer failed: ${this.summarize(error)}`)
        return false
      }
    }
    return true
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

  async deliverTurn(turn: DeliveredTurn): Promise<void> {
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
          sessionKey: this.sessionKeyFor(turn.streamId),
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
    void this.consume(turn.invocationId, created.runId, turn.streamId, abort, created.replayed).catch((error) => {
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
    abort: AbortController,
    replayed: boolean
  ): Promise<void> {
    const batcher = new StepBatcher(invocationId, this.session)
    try {
      let terminal = replayed ? undefined : await this.drain(runId, streamId, abort, batcher)
      terminal ??= await this.awaitStatus(runId, abort)
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
  private async awaitStatus(runId: string, abort: AbortController): Promise<HermesRunEvent | undefined> {
    let failures = 0
    for (;;) {
      if (abort.signal.aborted) return undefined
      try {
        const status = await this.client.getRun(runId, abort.signal)
        if (TERMINAL_STATUSES.has(status.status)) return terminalFromStatus(status)
        failures = 0
      } catch (error) {
        if (abort.signal.aborted) return undefined
        failures += 1
        if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) throw error
        this.log(`run ${runId} status poll failed (${failures}): ${this.summarize(error)}`)
      }
      await this.sleep(STATUS_POLL_MS)
    }
  }

  /** Consume one subscription; returns the terminal event if the stream carried one. */
  private async drain(
    runId: string,
    streamId: string,
    abort: AbortController,
    batcher: StepBatcher
  ): Promise<HermesRunEvent | undefined> {
    let terminal: HermesRunEvent | undefined
    try {
      for await (const event of this.client.streamEvents(runId, abort.signal)) {
        if (abort.signal.aborted) return undefined
        if (event.event === "approval.request") {
          batcher.add({ stepType: "status", content: `Waiting for approval: ${text(event.command) ?? "a command"}` })
          // The run is parked until it is answered, so the card is resolved
          // off the drain loop; blocking here would stall nothing but would
          // also never see the resume events.
          void this.resolveApproval(runId, streamId, event, abort.signal)
          continue
        }
        if (TERMINAL_EVENTS.has(event.event)) {
          terminal = event
          break
        }
        const frame = frameForEvent(event)
        if (frame && frame.content.length > 0) batcher.add(frame)
      }
    } catch (error) {
      if (abort.signal.aborted) return undefined
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
   * Answer one `approval.request` through a Threa decision card. Every exit
   * except a successful answer leaves the gateway's own approval timeout to
   * deny the command, so a lost card never parks the run forever.
   */
  private async resolveApproval(
    runId: string,
    streamId: string,
    event: HermesRunEvent,
    signal: AbortSignal
  ): Promise<void> {
    const choices = Array.isArray(event.choices) ? event.choices.flatMap((c) => text(c) ?? []) : []
    const options = approvalOptions(choices)
    if (options.length === 0) {
      this.log(`run ${runId} approval request carried no usable choices`)
      return
    }
    const requestId = text(event.request_id)
    const command = text(event.command) ?? "(command withheld)"
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
    if (choice !== "deny" || !note) return
    const denial = `The user denied this and said: ${note}`
    try {
      await this.client.steerRun(runId, denial)
    } catch (error) {
      if (error instanceof HermesApiError && error.code === STEER_REJECTED_CODE) {
        this.holdSteer(streamId, denial)
        return
      }
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
    ...(status.status === "interrupted" && status.error === undefined
      ? { error: "The Hermes gateway restarted before this run settled." }
      : {}),
  }
}
