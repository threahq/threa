import type { AttachmentRef } from "./crypto"
import {
  openSealedTurnContext,
  parseSealedTurnContext,
  scrubSealedError,
  type BotIdentityKey,
  type SealingState,
} from "./sealed"
import { isObject } from "./ws-hint"

export const BOT_INVOCATION_CANCELLATION_REASONS = [
  "source_deleted",
  "routing_changed",
  "input_restart",
  "input_stale",
  "key_grant_lost",
] as const

export type InputUpdateDisposition = "applied" | "restart-required"
export type BotInvocationCancellationReason = (typeof BOT_INVOCATION_CANCELLATION_REASONS)[number]

export interface InvocationInputUpdate {
  sourceRevision: number
  delivery: "plaintext" | "sealed"
  promptMarkdown: string
  attachmentRefs: AttachmentRef[]
  sealing?: SealingState
}

export interface InvocationCancellation {
  invocationId: string
  sourceRevision: number
  reason: BotInvocationCancellationReason
}

export interface InvocationControlCallbacks {
  onInputUpdated(
    update: InvocationInputUpdate,
    signal: AbortSignal
  ): Promise<InputUpdateDisposition> | InputUpdateDisposition
  onCancelled(): Promise<void> | void
  /** The authoritative claim no longer exists, without a typed backend cancellation. */
  onClaimLost?(): Promise<void> | void
}

export interface ObserveClaimParams {
  invocationId: string
  claimToken: string
  sourceRevision: number
  claimTtlSeconds: number
  instanceId?: string
  callbacks: InvocationControlCallbacks
  sealed?: {
    identity: BotIdentityKey
    streamId: string
    callbackToken: string
  }
}

export interface ObservedClaimHandle {
  sync(): Promise<void>
  unregister(): void
  dispose(): void
}

export type InvocationControlState =
  | { invocationId: string; status: "active"; claimExpiresAt: string; sourceRevision: number; update?: unknown }
  | {
      invocationId: string
      status: "cancelled"
      claimExpiresAt: null
      sourceRevision: number
      reason: BotInvocationCancellationReason
    }

export type ControlSyncResult =
  | { kind: "control"; state: InvocationControlState }
  | { kind: "not_found" }
  | { kind: "retry" }
  | { kind: "aborted" }

export interface InvocationControlSyncRequest {
  invocationId: string
  instanceId?: string
  claimToken: string
  claimTtlSeconds: number
  knownSourceRevision: number
  minimumSourceRevision: number
  restartRequiredRevision?: number
  ackTimeoutMs: number
  signal: AbortSignal
}

interface SealedBinding {
  identity: BotIdentityKey
  streamId: string
  callbackToken: string
}

export interface InvocationControlScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

interface Observation {
  readonly generation: number
  readonly invocationId: string
  readonly claimTtlSeconds: number
  readonly instanceId?: string
  claimToken: string
  callbacks?: InvocationControlCallbacks
  sealedBinding?: SealedBinding
  appliedRevision: number
  highWaterRevision: number
  claimExpiresAtMs?: number
  timer?: unknown
  terminal: boolean
  dirty: boolean
  drain?: Promise<void>
  abortController: AbortController
  enqueuedRevisions: Set<number>
  restartPendingRevision?: number
  immediateFollowupRevision?: number
}

interface InvocationControlManagerOptions {
  retryDelayMs?: number
  minRenewDelayMs?: number
  now?: () => number
  scheduler?: InvocationControlScheduler
}

export class InvocationControlManager {
  private readonly observations = new Map<string, Observation>()
  private readonly pendingTerminalGenerations = new Map<string, number>()
  private queue: Promise<void> = Promise.resolve()
  private stopped = false
  private generation = 0
  private readonly retryDelayMs: number
  private readonly minRenewDelayMs: number
  private readonly now: () => number
  private readonly scheduler: InvocationControlScheduler

  constructor(
    private readonly hooks: {
      sync(request: InvocationControlSyncRequest): Promise<ControlSyncResult>
      socketReady(): boolean
      log(message: string): void
    },
    options: InvocationControlManagerOptions = {}
  ) {
    this.retryDelayMs = options.retryDelayMs ?? 5_000
    this.minRenewDelayMs = options.minRenewDelayMs ?? 1_000
    this.now = options.now ?? Date.now
    this.scheduler = options.scheduler ?? {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }
  }

  observe(params: ObserveClaimParams): ObservedClaimHandle {
    this.pendingTerminalGenerations.delete(params.invocationId)
    const prior = this.observations.get(params.invocationId)
    if (prior) this.unregister(prior)
    const observation: Observation = {
      generation: ++this.generation,
      invocationId: params.invocationId,
      claimTtlSeconds: params.claimTtlSeconds,
      instanceId: params.instanceId,
      claimToken: params.claimToken,
      callbacks: params.callbacks,
      sealedBinding: params.sealed
        ? {
            identity: params.sealed.identity,
            streamId: params.sealed.streamId,
            callbackToken: params.sealed.callbackToken,
          }
        : undefined,
      appliedRevision: params.sourceRevision,
      highWaterRevision: params.sourceRevision,
      terminal: false,
      dirty: false,
      abortController: new AbortController(),
      enqueuedRevisions: new Set(),
    }
    this.observations.set(params.invocationId, observation)
    void this.requestSync(observation)
    return {
      sync: () => this.syncAndDrain(observation),
      unregister: () => this.unregister(observation),
      dispose: () => this.unregister(observation),
    }
  }

  hint(payload: unknown, cancelled: boolean): void {
    const hint = cancelled ? parseInvocationCancellation(payload) : parseUpdateHint(payload)
    if (!hint) return
    const observation = this.observations.get(hint.invocationId)
    if (!observation) return
    if (cancelled) {
      this.terminalizeCancellation(observation, hint as InvocationCancellation)
      return
    }
    if (hint.sourceRevision <= observation.highWaterRevision) return
    observation.highWaterRevision = hint.sourceRevision
    void this.requestSync(observation)
  }

  async bootstrap(recentCancellations: unknown[], callback: () => void): Promise<void> {
    for (const value of recentCancellations) {
      const cancellation = parseInvocationCancellation(value)
      if (!cancellation) continue
      const observation = this.observations.get(cancellation.invocationId)
      if (observation) this.terminalizeCancellation(observation, cancellation)
    }
    for (const observation of this.observations.values()) void this.requestSync(observation)
    await this.enqueueAdapter(callback)
  }

  wake(): void {
    for (const observation of this.observations.values()) void this.requestSync(observation)
  }

  async enqueueAdapter(callback: () => void): Promise<void> {
    await this.awaitStableControls()
    if (!this.stopped) {
      await this.enqueue(async () => {
        if (this.stopped) return
        try {
          callback()
        } catch {
          this.hooks.log("invocation availability callback failed")
        }
      })
    }
  }

  stop(): void {
    this.stopped = true
    this.pendingTerminalGenerations.clear()
    for (const observation of [...this.observations.values()]) this.unregister(observation)
  }

  private async syncAndDrain(observation: Observation): Promise<void> {
    if (this.isCurrent(observation)) void this.requestSync(observation)
    await this.awaitStableControls()
  }

  private requestSync(observation: Observation): Promise<void> {
    if (!this.isCurrent(observation)) return Promise.resolve()
    observation.dirty = true
    if (observation.drain) return observation.drain
    const drain = Promise.resolve().then(() => this.runDrain(observation))
    observation.drain = drain
    return drain
  }

  private async runDrain(observation: Observation): Promise<void> {
    while (this.isCurrent(observation) && observation.dirty) {
      observation.dirty = false
      const restartRevision = observation.restartPendingRevision
      const knownSourceRevision = restartRevision ?? observation.appliedRevision
      const request: InvocationControlSyncRequest = {
        invocationId: observation.invocationId,
        instanceId: observation.instanceId,
        claimToken: observation.claimToken,
        claimTtlSeconds: observation.claimTtlSeconds,
        knownSourceRevision,
        minimumSourceRevision: observation.appliedRevision,
        ...(restartRevision === undefined ? {} : { restartRequiredRevision: restartRevision }),
        ackTimeoutMs: Math.min(5_000, (observation.claimTtlSeconds * 1_000) / 6),
        signal: observation.abortController.signal,
      }
      const authorityBehind = await this.runSync(observation, request)
      if (!this.isCurrent(observation)) break
      if (authorityBehind) {
        // Equal high-water marks mean authority repeated the same behind revision; defer to the scheduled retry.
        if (observation.immediateFollowupRevision !== observation.highWaterRevision) {
          observation.immediateFollowupRevision = observation.highWaterRevision
          observation.dirty = true
        } else {
          this.schedule(observation, this.retryDelayMs)
        }
      } else {
        observation.immediateFollowupRevision = undefined
      }
    }
    observation.drain = undefined
  }

  private async runSync(observation: Observation, request: InvocationControlSyncRequest): Promise<boolean> {
    let result: ControlSyncResult
    try {
      result = await this.hooks.sync(request)
    } catch {
      result = { kind: "retry" }
      this.hooks.log(`invocation control sync failed (${observation.invocationId})`)
    }
    if (!this.isCurrent(observation) || result.kind === "aborted") return false
    if (result.kind === "not_found") {
      if (request.restartRequiredRevision !== undefined) {
        observation.restartPendingRevision = undefined
        observation.dirty = true
      } else {
        const callback = observation.callbacks?.onClaimLost
        this.makeTerminal(observation, callback)
      }
      return false
    }
    if (result.kind === "retry") {
      this.schedule(observation, this.retryDelayMs)
      return false
    }

    const state = result.state
    if (state.status === "cancelled") {
      const cancellation = {
        invocationId: state.invocationId,
        sourceRevision: state.sourceRevision,
        reason: state.reason,
      }
      if (!this.terminalizeCancellation(observation, cancellation)) this.schedule(observation, this.retryDelayMs)
      return false
    }

    const expiresAt = Date.parse(state.claimExpiresAt)
    if (!Number.isFinite(expiresAt)) {
      this.schedule(observation, this.retryDelayMs)
      return false
    }
    observation.claimExpiresAtMs = expiresAt
    observation.highWaterRevision = Math.max(observation.highWaterRevision, state.sourceRevision)
    this.schedule(observation)

    if (request.restartRequiredRevision !== undefined) {
      if (observation.restartPendingRevision === request.restartRequiredRevision) {
        this.schedule(observation, this.retryDelayMs)
      }
      return state.sourceRevision < observation.highWaterRevision
    }

    if (state.sourceRevision > observation.appliedRevision) {
      if (state.update) await this.prepareUpdate(observation, state.update)
      else this.schedule(observation, this.retryDelayMs)
    }
    return state.sourceRevision < observation.highWaterRevision
  }

  private async prepareUpdate(observation: Observation, raw: unknown): Promise<void> {
    const revision = parseRevision(isObject(raw) ? raw.sourceRevision : undefined)
    if (revision === undefined || revision <= observation.appliedRevision) return
    const highestEnqueued = Math.max(observation.appliedRevision, ...observation.enqueuedRevisions)
    if (revision <= highestEnqueued || observation.restartPendingRevision !== undefined) return

    let update: InvocationInputUpdate
    try {
      update = await openUpdate(observation, raw)
    } catch (error) {
      this.hooks.log(`sealed invocation update failed (${observation.invocationId}): ${scrubSealedError(error)}`)
      this.markRestartPending(observation, revision)
      return
    }
    if (!this.isCurrent(observation)) return

    observation.enqueuedRevisions.add(revision)
    const invocationId = observation.invocationId
    const generation = observation.generation
    void this.enqueue(async () => {
      const current = this.observations.get(invocationId)
      if (!current || current.generation !== generation || current.terminal || this.stopped) return
      if (revision <= current.appliedRevision || current.restartPendingRevision !== undefined) {
        current.enqueuedRevisions.delete(revision)
        return
      }
      let disposition: InputUpdateDisposition = "restart-required"
      try {
        disposition =
          (await current.callbacks?.onInputUpdated(update, current.abortController.signal)) ?? "restart-required"
      } catch {
        disposition = "restart-required"
      }
      const stillCurrent = this.observations.get(invocationId)
      if (!stillCurrent || stillCurrent.generation !== generation || stillCurrent.terminal) return
      stillCurrent.enqueuedRevisions.delete(revision)
      if (disposition === "applied") {
        stillCurrent.appliedRevision = revision
        if (stillCurrent.highWaterRevision > revision) void this.requestSync(stillCurrent)
      } else {
        this.markRestartPending(stillCurrent, revision)
      }
    })
  }

  private markRestartPending(observation: Observation, revision: number): void {
    if (!this.isCurrent(observation)) return
    if (observation.restartPendingRevision !== undefined && observation.restartPendingRevision >= revision) return
    observation.restartPendingRevision = revision
    observation.enqueuedRevisions.clear()
    void this.requestSync(observation)
  }

  private highestLocallyKnownRevision(observation: Observation): number {
    return Math.max(
      observation.appliedRevision,
      observation.highWaterRevision,
      ...observation.enqueuedRevisions,
      observation.restartPendingRevision ?? -1
    )
  }

  private terminalizeCancellation(observation: Observation, cancellation: InvocationCancellation): boolean {
    if (!this.isCurrent(observation) || cancellation.sourceRevision < this.highestLocallyKnownRevision(observation)) {
      return false
    }
    this.makeTerminal(observation, observation.callbacks?.onCancelled)
    return true
  }

  private makeTerminal(observation: Observation, callback?: () => void | Promise<void>): void {
    if (!this.isCurrent(observation)) return
    this.teardown(observation)
    if (!callback) return
    const { generation, invocationId } = observation
    this.pendingTerminalGenerations.set(invocationId, generation)
    void this.enqueue(async () => {
      if (this.stopped || this.pendingTerminalGenerations.get(invocationId) !== generation) return
      try {
        await callback()
      } finally {
        if (this.pendingTerminalGenerations.get(invocationId) === generation) {
          this.pendingTerminalGenerations.delete(invocationId)
        }
      }
    })
  }

  private unregister(observation: Observation): void {
    if (this.pendingTerminalGenerations.get(observation.invocationId) === observation.generation) {
      this.pendingTerminalGenerations.delete(observation.invocationId)
    }
    if (observation.terminal) return
    this.teardown(observation)
  }

  private teardown(observation: Observation): void {
    observation.terminal = true
    observation.abortController.abort()
    if (observation.timer !== undefined) this.scheduler.clearTimeout(observation.timer)
    observation.timer = undefined
    if (this.observations.get(observation.invocationId) === observation) {
      this.observations.delete(observation.invocationId)
    }
    this.scrub(observation)
  }

  private scrub(observation: Observation): void {
    observation.claimToken = ""
    observation.callbacks = undefined
    observation.sealedBinding = undefined
    observation.enqueuedRevisions.clear()
    observation.restartPendingRevision = undefined
    observation.immediateFollowupRevision = undefined
  }

  private schedule(observation: Observation, requestedDelay?: number): void {
    if (!this.isCurrent(observation)) return
    if (observation.timer !== undefined) this.scheduler.clearTimeout(observation.timer)
    const nominalLeaseMs = observation.claimTtlSeconds * 1_000
    const safetyMs = Math.min(30_000, Math.max(this.minRenewDelayMs, nominalLeaseMs / 3))
    const authoritativeDelay =
      observation.claimExpiresAtMs === undefined
        ? this.retryDelayMs
        : Math.max(this.minRenewDelayMs, observation.claimExpiresAtMs - this.now() - safetyMs)
    let delay = requestedDelay === undefined ? authoritativeDelay : Math.min(authoritativeDelay, requestedDelay)
    if (!this.hooks.socketReady()) delay = Math.min(delay, this.retryDelayMs)
    observation.timer = this.scheduler.setTimeout(
      () => {
        observation.timer = undefined
        void this.requestSync(observation)
      },
      Math.max(this.minRenewDelayMs, delay)
    )
  }

  private isCurrent(observation: Observation): boolean {
    return !this.stopped && !observation.terminal && this.observations.get(observation.invocationId) === observation
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.queue.then(work, work)
    this.queue = result.catch(() => {})
    return result
  }

  private async awaitStableControls(): Promise<void> {
    while (true) {
      const drains = [...this.observations.values()].flatMap((observation) =>
        observation.drain ? [observation.drain] : []
      )
      await Promise.allSettled(drains)
      const adapterQueue = this.queue
      await adapterQueue
      if (
        this.queue === adapterQueue &&
        [...this.observations.values()].every((observation) => observation.drain === undefined)
      ) {
        return
      }
    }
  }
}

async function openUpdate(observation: Observation, raw: unknown): Promise<InvocationInputUpdate> {
  if (!isObject(raw)) throw new Error("Invalid update")
  const sourceRevision = parseRevision(raw.sourceRevision)
  if (sourceRevision === undefined) throw new Error("Invalid update")
  const expectsSealed = observation.sealedBinding !== undefined
  if (!expectsSealed && raw.delivery === "plaintext" && typeof raw.promptMarkdown === "string") {
    return {
      sourceRevision,
      delivery: "plaintext",
      promptMarkdown: raw.promptMarkdown,
      attachmentRefs: [],
    }
  }
  if (!expectsSealed || raw.delivery !== "sealed" || !observation.sealedBinding) {
    throw new Error("Invalid update delivery")
  }
  const sealed = parseSealedTurnContext({
    callbackToken: observation.sealedBinding.callbackToken,
    wraps: raw.wraps,
    history: [],
    prompt: raw.prompt,
    reply: raw.reply,
  })
  if (!sealed) throw new Error("Invalid sealed update")
  const opened = await openSealedTurnContext({
    sealed,
    identity: observation.sealedBinding.identity,
    streamId: observation.sealedBinding.streamId,
  })
  return {
    sourceRevision,
    delivery: "sealed",
    promptMarkdown: opened.promptMarkdown,
    attachmentRefs: opened.promptAttachmentRefs,
    sealing: opened.sealing,
  }
}

const cancellationReasonSet = new Set<string>(BOT_INVOCATION_CANCELLATION_REASONS)

export function parseCancellationReason(value: unknown): BotInvocationCancellationReason | undefined {
  if (value === "adapter_restart_required") return "input_restart"
  return typeof value === "string" && cancellationReasonSet.has(value)
    ? (value as BotInvocationCancellationReason)
    : undefined
}

export function parseInvocationCancellation(value: unknown): InvocationCancellation | undefined {
  if (!isObject(value) || typeof value.invocationId !== "string") return
  const sourceRevision = parseRevision(value.sourceRevision)
  const reason = parseCancellationReason(value.reason)
  if (sourceRevision === undefined || !reason) return
  return { invocationId: value.invocationId, sourceRevision, reason }
}

function parseUpdateHint(value: unknown): { invocationId: string; sourceRevision: number } | undefined {
  if (!isObject(value) || typeof value.invocationId !== "string") return
  const sourceRevision = parseRevision(value.sourceRevision)
  return sourceRevision === undefined ? undefined : { invocationId: value.invocationId, sourceRevision }
}

export function parseRevision(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined
}
