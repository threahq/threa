import type { SealedReplyBody } from "@threahq/bot-runtime-client"
import type { ClaimedInvocation } from "./client"

/** Exact failed POST bytes and id, retained because an ambiguous failure may have committed. */
export type PreparedPost =
  | {
      kind: "plaintext"
      seq: number
      text: string
      retryKey?: string
      body: {
        instanceId: string
        claimToken: string
        content: string
        clientMessageId: string
        metadata: Record<string, unknown>
      }
    }
  | {
      kind: "sealed"
      seq: number
      text: string
      retryKey?: string
      body: SealedReplyBody
      attachmentIds: string[]
    }

export interface PostIntent {
  text: string
  retryKey?: string
  retry?: PreparedPost
}

export type PlaintextCompletionBody = {
  instanceId: string
  claimToken: string
  sourceRevision: number
  metadata: Record<string, unknown>
} & ({ finalMessageMarkdown: string } | { noResponse: true })

export type SealedCompletionBody = (
  | { reply: SealedReplyBody & { attachmentIds?: string[] } }
  | { noResponse: true }
) & {
  sourceRevision: number
}

export type PreparedCompletionWire =
  | { kind: "plaintext"; body: PlaintextCompletionBody }
  | { kind: "sealed"; callbackToken: string; body: SealedCompletionBody }

export type PreparedClose =
  | { reason: "reply"; sourceText: string; wire: PreparedCompletionWire }
  | { reason: "timeout"; wire: PreparedCompletionWire }

export type CloseRequest = { kind: "reply"; text: string } | { kind: "timeout" }

export type RouteState = "open" | "closing" | "closed"

export class RouteRevokedError extends Error {}

/**
 * One claimed invocation's delivery route. The session's maps and queued posts
 * share this object so reserved ids survive state transitions. Route death has
 * three private signals with distinct meanings — `state` (turn protocol
 * progress), `revoked` (this session stopped speaking for the stream), and
 * `terminal` (the server refused the route for good) — mutated only through
 * the named transitions below; `generation` fences a route created before a
 * session teardown (`isFenced`).
 */
export class TurnRoute {
  readonly invocation: ClaimedInvocation
  /** Registration order distinguishes an older route from a newer owner of the same stream. */
  readonly order: number
  /** The session lifecycle this route belongs to; a bump fences it out for good. */
  readonly generation: number
  sentCount = 0
  /** The accepted final reply's exact text, for idempotent reply retries. */
  replyText?: string
  /** Exact close body retained after an ambiguous completion. */
  prepared?: PreparedClose
  /** The completion currently on the wire, so shutdown can settle it instead of racing it. */
  closing?: Promise<unknown>
  deadline?: ReturnType<typeof setTimeout>
  readonly pending = new Map<number, PreparedPost>()
  /** Source-backed inputs folded into this turn; they close with it and fail with it. */
  contributors: ClaimedInvocation[]
  /** Aborts the completion on the wire when any folded source changes underneath it. */
  readonly execution = new AbortController()
  /** FIFO tail: every post on this route runs behind it, in call order. */
  private tail: Promise<unknown> = Promise.resolve()
  /** Highest sequence handed out. Reserved before the write, so a failure spends it. */
  private reservedSeq = 0
  /** Bumped on every (re-)arm, so a fired timeout queued behind a post can tell it is stale. */
  private deadlineGeneration = 0
  private stateValue: RouteState = "open"
  private revokedFlag = false
  private terminalFlag = false
  private readonly idleTimeoutMs: number
  private readonly onIdleDeadline: (route: TurnRoute, deadlineGeneration: number) => void

  constructor(options: {
    invocation: ClaimedInvocation
    order: number
    generation: number
    idleTimeoutMs: number
    onIdleDeadline: (route: TurnRoute, deadlineGeneration: number) => void
    contributors?: ClaimedInvocation[]
  }) {
    this.invocation = options.invocation
    this.contributors = [...(options.contributors ?? [])]
    this.order = options.order
    this.generation = options.generation
    this.idleTimeoutMs = options.idleTimeoutMs
    this.onIdleDeadline = options.onIdleDeadline
  }

  get state(): RouteState {
    return this.stateValue
  }

  get revoked(): boolean {
    return this.revokedFlag
  }

  get terminal(): boolean {
    return this.terminalFlag
  }

  isFenced(lifecycle: number): boolean {
    return this.revokedFlag || this.generation !== lifecycle
  }

  /** FIFO allocation keeps concurrent posts on distinct ids and orders them against completion. */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    // `.then(task, task)` so one rejected post never wedges the queue behind it.
    const run = this.tail.then(task, task)
    this.tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** Snapshot retry intent before queueing so concurrent callers cannot adopt each other's failure. */
  snapshotIntent(text: string, retryKey?: string): PostIntent {
    let retry: PreparedPost | undefined
    for (const pending of this.pending.values()) {
      if (pending.text === text && pending.retryKey === retryKey && (!retry || pending.seq < retry.seq)) {
        retry = pending
      }
    }
    return {
      text,
      ...(retryKey === undefined ? {} : { retryKey }),
      ...(retry ? { retry } : {}),
    }
  }

  /** An ambiguous failure reserves its id and exact bytes; changed text takes the next id. */
  claimSeq(retry: PreparedPost | undefined): number {
    return retry?.seq ?? (this.reservedSeq += 1)
  }

  rememberFailedPost(seq: number, prepared: PreparedPost, lifecycle: number): void {
    if (!this.isFenced(lifecycle)) this.pending.set(seq, prepared)
  }

  recordLandedPost(seq: number, prepared: PreparedPost): void {
    if (this.pending.get(seq) === prepared) this.pending.delete(seq)
    this.sentCount += 1
  }

  /** The source changed under a prepared body: never replay bytes sealed or revisioned against the old input. */
  discardPrepared(): void {
    this.pending.clear()
    this.prepared = undefined
  }

  /** This session stopped speaking for the route's stream; pending retries and the deadline die with it. */
  revoke(): void {
    this.revokedFlag = true
    this.pending.clear()
    this.prepared = undefined
    this.clearDeadline()
  }

  /** The server refused the route for good: drop write credentials and every pending payload. */
  markTerminal(): void {
    this.stateValue = "closed"
    this.terminalFlag = true
    this.revokedFlag = true
    this.clearDeadline()
    this.deadlineGeneration += 1
    this.closing = undefined
    this.pending.clear()
    this.prepared = undefined
    this.invocation.claimToken = ""
    this.invocation.sealing = undefined
    this.invocation.sealedAttachments = undefined
    this.invocation.sealedAck = undefined
  }

  beginClosing(): void {
    this.stateValue = "closing"
    this.clearDeadline()
  }

  markClosed(): void {
    this.stateValue = "closed"
  }

  settleClosed(replyText: string | undefined): void {
    this.stateValue = "closed"
    this.prepared = undefined
    if (replyText === undefined) delete this.replyText
    else this.replyText = replyText
  }

  reopen(prepared: PreparedClose | undefined): void {
    this.stateValue = "open"
    this.prepared = prepared
  }

  /** Track the completion on the wire so shutdown can settle it instead of racing it. */
  trackClosing<T>(task: Promise<T>): Promise<T> {
    this.closing = task
    return task.finally(() => {
      if (this.closing === task) this.closing = undefined
    })
  }

  armIdleTimeout(): void {
    const generation = (this.deadlineGeneration += 1)
    this.deadline = setTimeout(() => this.onIdleDeadline(this, generation), this.idleTimeoutMs)
  }

  /** Reset the idle timeout after a sign of life. */
  touchIdleTimeout(): void {
    if (this.stateValue !== "open" || this.revokedFlag) return
    this.clearDeadline()
    this.armIdleTimeout()
  }

  isCurrentDeadline(deadlineGeneration: number): boolean {
    return this.deadlineGeneration === deadlineGeneration
  }

  private clearDeadline(): void {
    clearTimeout(this.deadline)
    this.deadline = undefined
  }
}
