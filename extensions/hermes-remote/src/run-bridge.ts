import { createHash } from "node:crypto"
import type { DeliveredTurn, RuntimeDescriptor, SendResult, StepFrame } from "@threahq/remote-session"
import type { HermesRunEvent, HermesRunsClient, RunStatus } from "./hermes-client"

/** The slice of `RemoteSession` the bridge drives, so tests can stand in a fake. */
export interface BridgeSession {
  readonly rootStreamId?: string
  recordSteps(invocationId: string, frames: StepFrame[], statusText?: string): Promise<boolean>
  reply(invocationId: string, text: string): Promise<SendResult>
  failTurn(invocationId: string, errorMessage: string): Promise<boolean>
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
const MEDIA_LINE_RE = /^MEDIA:[ \t]*(.+)$/gm

export interface HermesTurnRunnerOptions {
  client: HermesRunsClient
  session: BridgeSession
  sessionKeyFor(streamId: string): string
  log?: (message: string) => void
  /** Injectable for tests; paces the status poll that replaces a lost event stream. */
  sleep?: (ms: number) => Promise<void>
}

interface OpenRun {
  runId: string
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
export function idempotencyKeyFor(turn: DeliveredTurn): string {
  const digest = createHash("sha256").update(turn.content).digest("hex").slice(0, 16)
  return `${turn.invocationId}.${digest}`
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
  readonly runs = new Map<string, OpenRun>()

  constructor(options: HermesTurnRunnerOptions) {
    this.client = options.client
    this.session = options.session
    this.sessionKeyFor = options.sessionKeyFor
    this.log = options.log ?? (() => {})
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  async deliverTurn(turn: DeliveredTurn): Promise<void> {
    const abort = new AbortController()
    const created = await this.client.createRun(
      {
        input: turn.content,
        sessionId: turn.streamId,
        idempotencyKey: idempotencyKeyFor(turn),
        sessionKey: this.sessionKeyFor(turn.streamId),
      },
      abort.signal
    )
    this.runs.set(turn.invocationId, { runId: created.runId, abort })
    // A replayed admission points at a run whose event transport may be gone
    // already (Hermes drops it when the first subscriber leaves), so its status
    // is the source of truth from the start.
    void this.consume(turn.invocationId, created.runId, abort, created.replayed).catch((error) => {
      this.log(`run ${created.runId} bridge failed: ${this.summarize(error)}`)
      void this.session.failTurn(turn.invocationId, this.summarize(error)).catch(() => undefined)
    })
  }

  /** Abort every open subscription; the SDK's own shutdown fails the turns. */
  shutdown(): void {
    for (const run of this.runs.values()) run.abort.abort()
    this.runs.clear()
  }

  private async consume(invocationId: string, runId: string, abort: AbortController, replayed: boolean): Promise<void> {
    const batcher = new StepBatcher(invocationId, this.session)
    try {
      let terminal = replayed ? undefined : await this.drain(runId, abort, batcher)
      terminal ??= await this.awaitStatus(runId, abort)
      await batcher.flush()
      if (terminal) await this.settle(invocationId, terminal)
    } catch (error) {
      // Shutdown aborts the poll mid-flight; the SDK's own shutdown fails the turn.
      if (abort.signal.aborted) return
      throw error
    } finally {
      await batcher.flush()
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
    abort: AbortController,
    batcher: StepBatcher
  ): Promise<HermesRunEvent | undefined> {
    let terminal: HermesRunEvent | undefined
    try {
      for await (const event of this.client.streamEvents(runId, abort.signal)) {
        if (event.event === "approval.request") {
          this.log(`run ${runId} is waiting for an approval; approvals are not answered from Threa yet`)
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
