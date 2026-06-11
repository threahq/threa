import type { Socket } from "socket.io-client"

/**
 * Minimal registration surface shared by the raw socket and the gate. Handler
 * registration code (workspace-sync, stream-sync, useStreamSocket) is written
 * against this so the SyncEngine can interpose the gate in active sync-v2
 * mode without the handlers knowing.
 */
export interface SyncEventSource {
  // `any[]` (not `unknown[]`) so the raw socket.io `Socket` stays structurally
  // assignable — its listener types are `(...args: any[]) => void` and the
  // strict contravariant check rejects narrower parameter types.
  on(event: string, listener: (...args: any[]) => void): unknown
  off(event: string, listener: (...args: any[]) => void): unknown
}

type SyncEventHandler = (...args: unknown[]) => unknown

interface BufferedEvent {
  eventType: string
  payload: unknown
  syncId: bigint
}

/**
 * Soft cap on the pause buffer. Catch-up pauses for seconds at most; a
 * workspace producing this many live events in that window is far outside
 * normal load, and falling back to immediate (live) application there merely
 * reverts to today's delivery semantics for the overflow.
 */
const DEFAULT_BUFFER_LIMIT = 2_000

/**
 * The single delivery chokepoint for sync-v2 active mode. Live socket events
 * and catch-up log entries must apply through the SAME registered handlers
 * (the protocol guarantees `entry.payload` is the exact payload the socket
 * emits), so handlers register here instead of on the raw socket and the
 * gate forwards real socket events into them.
 *
 * While catch-up pages the sync log, the gate is paused: live events that
 * carry a `syncId` for this workspace are buffered instead of applied, then
 * spliced in syncId order once catch-up lands (doc Part 5, pressure test 7 —
 * exact integer reconciliation, no wall-clock heuristics). Events without a
 * syncId (ephemeral presence, pre-deploy emits) and other workspaces' events
 * pass through untouched — they are not in the log, so there is no splice
 * position to order them against.
 *
 * `onApplied` fires with the syncId after the gate applies a live or spliced
 * event — the engine advances the workspace cursor there, so the cursor only
 * ever moves past entries that were actually handed to handlers.
 */
export class SocketEventGate implements SyncEventSource {
  private readonly handlers = new Map<string, Set<SyncEventHandler>>()
  private readonly forwarders = new Map<string, SyncEventHandler>()
  private socket: Socket | null = null
  private paused = false
  /** Bumped on every pause so an in-flight resume from an older cycle can
   *  detect that a newer pause owns the gate and must not reopen it. */
  private pauseEpoch = 0
  private buffer: BufferedEvent[] = []
  private overflowWarned = false
  private disposed = false

  constructor(
    private readonly workspaceId: string,
    private readonly opts: {
      onApplied?: (syncId: string) => void
      bufferLimit?: number
    } = {}
  ) {}

  /**
   * Points the gate at the engine's current socket, moving every event-type
   * forwarder over. Idempotent for the same socket instance (reconnects reuse
   * the socket.io client), so handler registrations survive reconnect cycles
   * exactly like raw `socket.on` registrations do today.
   */
  attach(socket: Socket): void {
    if (this.disposed || this.socket === socket) return
    this.detach()
    this.socket = socket
    for (const [eventType, forwarder] of this.forwarders) {
      socket.on(eventType, forwarder)
    }
  }

  detach(): void {
    if (!this.socket) return
    for (const [eventType, forwarder] of this.forwarders) {
      this.socket.off(eventType, forwarder)
    }
    this.socket = null
  }

  on(event: string, listener: SyncEventHandler): this {
    if (this.disposed) return this
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(listener)
    if (!this.forwarders.has(event)) {
      const forwarder = (...args: unknown[]) => this.handleIncoming(event, args)
      this.forwarders.set(event, forwarder)
      this.socket?.on(event, forwarder)
    }
    return this
  }

  off(event: string, listener: SyncEventHandler): this {
    const set = this.handlers.get(event)
    if (!set) return this
    set.delete(listener)
    if (set.size === 0) {
      this.handlers.delete(event)
      const forwarder = this.forwarders.get(event)
      if (forwarder) {
        this.forwarders.delete(event)
        this.socket?.off(event, forwarder)
      }
    }
    return this
  }

  /** Start buffering this workspace's syncId-bearing live events. */
  pause(): void {
    if (this.disposed) return
    this.paused = true
    this.pauseEpoch += 1
  }

  /**
   * Applies buffered events that pass `applyIf` in ascending syncId order
   * (awaiting each event's handlers, so applies cannot interleave), then
   * reopens live flow. Events arriving while the splice is draining keep
   * buffering and are drained by the same loop, so nothing applies out of
   * order during the handoff back to live.
   *
   * If a NEW pause lands while this splice is draining (a reconnect/resume
   * cycle started), the drain stops, the remaining events go back to the
   * buffer, and the gate stays paused — the new cycle's own resume owns the
   * splice from there. Reopening here would let live events flow into the
   * new cycle's bootstrap window.
   */
  async resume(applyIf: (eventType: string, syncId: bigint) => boolean): Promise<void> {
    const epoch = this.pauseEpoch
    while (this.buffer.length > 0) {
      if (this.disposed) return
      const batch = this.buffer
      this.buffer = []
      batch.sort((a, b) => {
        if (a.syncId < b.syncId) return -1
        if (a.syncId > b.syncId) return 1
        return 0
      })
      for (let i = 0; i < batch.length; i++) {
        if (this.disposed) return
        if (this.pauseEpoch !== epoch) {
          this.buffer = [...batch.slice(i), ...this.buffer]
          return
        }
        const event = batch[i]
        if (!applyIf(event.eventType, event.syncId)) continue
        await this.dispatch(event.eventType, event.payload)
        this.opts.onApplied?.(event.syncId.toString())
      }
    }
    if (this.pauseEpoch !== epoch) return
    this.paused = false
    this.overflowWarned = false
  }

  /**
   * Invokes every registered handler for `eventType` with `payload`, awaiting
   * them all. Used by the catch-up loop (log entries) and the resume splice;
   * a rejecting handler is logged and skipped — same net effect as a live
   * handler throwing today, and the entry is not redelivered either way.
   */
  async dispatch(eventType: string, payload: unknown): Promise<void> {
    const set = this.handlers.get(eventType)
    if (!set || set.size === 0) return
    const snapshot = Array.from(set)
    const results = await Promise.allSettled(snapshot.map(async (handler) => handler(payload)))
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("Sync-v2 catch-up handler failed", { eventType, error: result.reason })
      }
    }
  }

  /** Drops the buffer and all socket forwarders. Never applies on dispose —
   *  engine destroy can be an account switch, and a post-destroy apply would
   *  write one account's events into another account's database. */
  dispose(): void {
    this.disposed = true
    this.detach()
    this.buffer = []
    this.handlers.clear()
    this.forwarders.clear()
  }

  private handleIncoming(eventType: string, args: unknown[]): void {
    if (this.disposed) return
    const payload = args[0] as { workspaceId?: unknown; syncId?: unknown } | undefined

    if (this.paused && payload && payload.workspaceId === this.workspaceId && typeof payload.syncId === "string") {
      const syncId = parseBufferSyncId(payload.syncId)
      if (syncId !== null) {
        if (this.buffer.length < (this.opts.bufferLimit ?? DEFAULT_BUFFER_LIMIT)) {
          this.buffer.push({ eventType, payload, syncId })
          return
        }
        if (!this.overflowWarned) {
          this.overflowWarned = true
          console.warn("Sync-v2 gate buffer overflow — applying live events immediately", {
            workspaceId: this.workspaceId,
          })
        }
        // Fall through: overflow reverts to live (immediate) application.
      }
    }

    // Live path: apply immediately without awaiting (matches raw socket
    // delivery), advancing the cursor for syncId-bearing payloads.
    void this.dispatch(eventType, args[0])
    if (payload && payload.workspaceId === this.workspaceId && typeof payload.syncId === "string") {
      this.opts.onApplied?.(payload.syncId)
    }
  }
}

function parseBufferSyncId(value: string): bigint | null {
  try {
    return BigInt(value)
  } catch {
    return null
  }
}
