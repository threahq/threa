// Namespace import so tests can spyOn the `io` factory (INV-48) — the transport
// is otherwise untestable without dialing a real Socket.IO server.
import * as socketIoClient from "socket.io-client"
import type { Socket } from "socket.io-client"
import { THREA_CALLBACK_TOKEN_HEADER, type SealedStepFrame } from "./sealed"
import { buildBotSocketUrl, isObject, parseWsHint, type WsHint } from "./ws-hint"
import type {
  BotHelloBootstrap,
  BotRuntimeTransportCallbacks,
  DelegationAvailableNudge,
  BotRuntimeTransportOptions,
  BotWriteAck,
  StepFrame,
} from "./types"

const DEFAULT_WS_ACK_TIMEOUT_MS = 5_000
const DEFAULT_RECONNECTION_DELAY_MAX_MS = 30_000
const DEFAULT_FETCH_TIMEOUT_MS = 30_000
const DEFAULT_STALE_SOCKET_REDIAL_MS = 3 * 60 * 1000

/**
 * Owns the `/bot` WebSocket and the routing for a runtime's background writes.
 *
 * Why it exists: every `presence` / `renew` / `steps` POST goes through the edge
 * Worker (`app.threa.io/api/*`) and is billed as a request; the same frame over
 * the already-open socket (a direct CNAME to the regional backend) is free. A
 * single agentic turn can fire 150+ step writes, so moving them off HTTP is the
 * difference between an idle daemon costing nothing and one steadily burning the
 * Cloudflare quota.
 *
 * Routing rule for the three write methods: prefer the socket; if the server
 * acks (ok or a definitive failure) trust it; only a missing ack or a dead
 * socket triggers the HTTP fallback. `renewClaim` always falls back (a claim
 * must never lapse because the socket flapped); steps are best-effort; presence
 * is low-stakes.
 *
 * The transport owns ONLY these three ops + the socket. Durable, low-frequency
 * writes (claim/complete/fail/session) stay on each extension's own HTTP client.
 */
export class BotRuntimeTransport {
  private readonly base: string
  private readonly workspaceId: string
  private readonly apiKey: string
  private readonly hello: BotRuntimeTransportOptions["hello"]
  private readonly callbacks: BotRuntimeTransportCallbacks
  private readonly wsAckTimeoutMs: number
  private readonly reconnectionDelayMaxMs: number
  private readonly fetchTimeoutMs: number
  private readonly staleSocketRedialMs: number
  private readonly logFn: (message: string) => void

  private socket: Socket | undefined
  private connected = false
  private connecting = false
  private stopped = false
  /** When the current outage started: set at attach and on disconnect, cleared on connect. */
  private disconnectedAt: number | undefined
  /** The cursor echoed by the last hello ack; re-sent on the next hello so the bootstrap only replays unseen events. */
  private cursor: string | undefined

  constructor(opts: BotRuntimeTransportOptions) {
    this.base = opts.baseUrl.replace(/\/$/, "")
    this.workspaceId = opts.workspaceId
    this.apiKey = opts.apiKey
    this.hello = opts.hello
    this.callbacks = opts.callbacks ?? {}
    this.wsAckTimeoutMs = opts.wsAckTimeoutMs ?? DEFAULT_WS_ACK_TIMEOUT_MS
    this.reconnectionDelayMaxMs = opts.reconnectionDelayMaxMs ?? DEFAULT_RECONNECTION_DELAY_MAX_MS
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
    this.staleSocketRedialMs = opts.staleSocketRedialMs ?? DEFAULT_STALE_SOCKET_REDIAL_MS
    this.logFn = opts.log ?? (() => {})
  }

  /** Whether the `/bot` socket is currently connected. */
  get socketConnected(): boolean {
    return this.connected
  }

  // --- Socket lifecycle -----------------------------------------------------

  /**
   * Resolve the WS hint and open the socket (idempotent — a guard keeps the boot
   * call and the first poll tick from opening two). The hint resolve is the only
   * HTTP the transport does on the hot path; a failure leaves the socket closed
   * and the caller keeps polling/HTTP-writing until the next `connect()`.
   *
   * An existing-but-disconnected socket is normally left to Socket.IO's own
   * retry loop, EXCEPT when the outage has outlived `staleSocketRedialMs`: then
   * the socket is wedged in a state retries can't fix (a stale ws hint after the
   * backend moved, a dead retry loop) and the only cure is a teardown + fresh
   * dial. Without this, one wedged socket leaves the runtime on the fast HTTP
   * poll forever — the exact Cloudflare-quota burn the transport exists to avoid.
   */
  async connect(): Promise<void> {
    if (this.connecting || this.stopped) return
    if (this.socket) {
      if (this.connected) return
      const outageMs = Date.now() - (this.disconnectedAt ?? Date.now())
      if (outageMs < this.staleSocketRedialMs) return
      this.logFn(`socket disconnected for ${Math.round(outageMs / 1000)}s; redialing from a fresh hint`)
      this.teardownSocket()
    }
    this.connecting = true
    try {
      let hint: WsHint | undefined
      try {
        hint = await this.resolveWsHint()
      } catch (error) {
        this.logFn(`ws hint resolve failed (staying on HTTP): ${summarize(error)}`)
      }
      if (hint) this.attachSocket(hint)
    } finally {
      this.connecting = false
    }
  }

  private attachSocket(hint: WsHint): void {
    if (this.socket || this.stopped) return
    let socket: Socket
    try {
      socket = socketIoClient.io(buildBotSocketUrl(hint), {
        path: hint.path,
        auth: { token: this.apiKey },
        transports: ["websocket"],
        reconnection: true,
        reconnectionDelayMax: this.reconnectionDelayMaxMs,
      })
    } catch (error) {
      this.logFn(`socket attach failed (HTTP only): ${summarize(error)}`)
      return
    }
    this.socket = socket
    this.disconnectedAt = Date.now()
    socket.on("connect", () => {
      this.connected = true
      this.disconnectedAt = undefined
      this.sendHello()
    })
    socket.on("disconnect", (reason: string) => {
      this.connected = false
      this.disconnectedAt ??= Date.now()
      // Socket.IO's auto-reconnect covers every disconnect reason EXCEPT a
      // server-initiated one (deploy drain, kick) — there the client stays down
      // until someone calls connect(). Redial immediately; a flap lands on the
      // normal reconnection backoff.
      if (reason === "io server disconnect") socket.connect()
    })
    socket.on("connect_error", (error: unknown) => {
      this.connected = false
      this.disconnectedAt ??= Date.now()
      this.logFn(`socket connect_error: ${summarize(error)}`)
    })
    socket.on("bot_invocation:available", () => this.callbacks.onInvocationAvailable?.())
    socket.on("delegation:available", (payload: unknown) =>
      this.callbacks.onDelegationAvailable?.(payload as DelegationAvailableNudge)
    )
    socket.on("bot_invocation:claimed", (payload: unknown) => this.callbacks.onInvocationClaimed?.(payload))
    socket.on("bot:active_actor_changed", (payload: unknown) => this.callbacks.onActiveActorChanged?.(payload))
    socket.on("bot:session_archived", (payload: unknown) => this.callbacks.onSessionArchived?.(payload))
    socket.on("bot:session_restored", (payload: unknown) => this.callbacks.onSessionRestored?.(payload))
    socket.on("bot:resync", () => {
      this.sendHello()
      this.callbacks.onResync?.()
    })
  }

  /** (Re)announce this instance + capabilities and pull the bootstrap snapshot. */
  sendHello(): void {
    const socket = this.socket
    if (!socket) return
    socket.emit(
      "bot:hello",
      { ...this.hello, ...(this.cursor ? { sinceCursor: this.cursor } : {}) },
      (ack: unknown) => {
        if (!isObject(ack) || ack.ok !== true) {
          this.logFn(`bot:hello rejected: ${isObject(ack) ? String(ack.error) : "no ack"}`)
          return
        }
        if (typeof ack.serverGeneratedAt === "string") this.cursor = ack.serverGeneratedAt
        const bootstrap: BotHelloBootstrap = {
          serverGeneratedAt: typeof ack.serverGeneratedAt === "string" ? ack.serverGeneratedAt : undefined,
          availableInvocations: Array.isArray(ack.availableInvocations) ? ack.availableInvocations : [],
          ownedClaims: Array.isArray(ack.ownedClaims) ? ack.ownedClaims : [],
        }
        this.callbacks.onBootstrap?.(bootstrap)
      }
    )
  }

  /** Tear the socket down (idempotent). After this the transport is HTTP-only and won't reconnect. */
  disconnect(): void {
    this.stopped = true
    this.teardownSocket()
  }

  /** Drop the current socket without stopping the transport — the next `connect()` dials fresh. */
  private teardownSocket(): void {
    this.connected = false
    this.disconnectedAt = undefined
    const socket = this.socket
    this.socket = undefined
    if (socket) {
      try {
        socket.removeAllListeners()
        socket.disconnect()
      } catch {
        // already closed
      }
    }
  }

  // --- Routed background writes (WS-first, HTTP fallback) --------------------

  /**
   * Record one or more trace steps. Best-effort: a turn's narration is nice to
   * have, not load-bearing, so a failure is logged and dropped rather than
   * surfaced. This is the high-volume op the whole exercise targets.
   */
  async recordSteps(
    invocationId: string,
    claimToken: string,
    steps: StepFrame[],
    statusText?: string,
    // The instance that holds the claim. Defaults to the hello instance; the
    // override exists for runtimes (pi-remote) whose claim instance can differ
    // from the session instance the transport registered with.
    instanceId: string = this.hello.instanceId
  ): Promise<void> {
    if (steps.length === 0) return
    // Stamp each frame with an idempotency key (shared across the WS frame and the
    // HTTP fallback) so the server can never persist the same step twice.
    const keyed = steps.map((step) => ({ ...step, clientStepId: step.clientStepId ?? crypto.randomUUID() }))
    const { sent, ack } = await this.emitWrite("bot:invocation:steps", {
      invocationId,
      instanceId,
      claimToken,
      steps: keyed,
      ...(statusText ? { statusText } : {}),
    })
    if (ack) {
      if (!ack.ok) this.logFn(`steps rejected (${ack.code ?? "?"}): ${ack.message ?? ""}`)
      return
    }
    if (sent) {
      // The frame is in flight; the ack just didn't arrive in time. Steps are
      // best-effort, so rather than re-POST (an edge request we're avoiding,
      // dedup'd server-side or not) we drop and trust the in-flight frame.
      this.logFn("steps ack timed out; relying on the in-flight frame (no HTTP retry)")
      return
    }
    // Socket was down — the frame never left, so HTTP is the only path. The
    // idempotency key still guards against a late WS delivery racing this POST.
    await this.httpRecordStepsFallback(invocationId, claimToken, keyed, statusText, instanceId)
  }

  /**
   * Record one or more SEALED trace steps for an E2E turn. Same routing and
   * best-effort semantics as {@link recordSteps} — WS frame first, per-step HTTP
   * fallback — but the frames carry ciphertext + envelope instead of plaintext
   * content, and auth is the per-claim callback token (model A), not
   * `instanceId`/`claimToken`. `stepId` is the idempotency key: the server
   * finalizes/upserts by it, so a duplicate delivery can't double-persist.
   */
  async recordSealedSteps(invocationId: string, callbackToken: string, steps: SealedStepFrame[]): Promise<void> {
    if (steps.length === 0) return
    const { sent, ack } = await this.emitWrite("bot:invocation:sealed-steps", {
      invocationId,
      callbackToken,
      steps,
    })
    if (ack) {
      if (!ack.ok) this.logFn(`sealed steps rejected (${ack.code ?? "?"}): ${ack.message ?? ""}`)
      return
    }
    if (sent) {
      this.logFn("sealed steps ack timed out; relying on the in-flight frame (no HTTP retry)")
      return
    }
    await this.httpRecordSealedStepsFallback(invocationId, callbackToken, steps)
  }

  /**
   * Renew a claim's lease. Correctness-critical, so the HTTP fallback is
   * mandatory: a missing ack, a dead socket, or any non-`NOT_FOUND` server error
   * all retry over HTTP. Returns `{ notFound: true }` when the claim is gone
   * (the caller should drop it); the caller never lets it silently lapse.
   */
  async renewClaim(
    invocationId: string,
    claimToken: string,
    claimTtlSeconds: number,
    instanceId: string = this.hello.instanceId
  ): Promise<{ notFound: boolean }> {
    const { ack } = await this.emitWrite("bot:invocation:renew", {
      invocationId,
      instanceId,
      claimToken,
      claimTtlSeconds,
    })
    if (ack) {
      if (ack.ok) return { notFound: false }
      if (ack.code === "NOT_FOUND") return { notFound: true }
      this.logFn(`renew rejected (${ack.code ?? "?"}); retrying over HTTP`)
    }
    // Renew is an idempotent CAS (re-setting claim_expires_at is harmless), so —
    // unlike steps — we retry over HTTP on ANY missing ack (not sent OR timed
    // out). The lease must not lapse because the socket flapped; a redundant
    // renew when the WS frame also lands just re-sets the same expiry.
    return this.httpRenewFallback(invocationId, claimToken, claimTtlSeconds, instanceId)
  }

  /**
   * Push a presence update. Low-stakes (the socket connection itself is the
   * primary liveness signal); if the socket can't ack it, fall back to HTTP so
   * the row still lands. `body` is the full presence body, identical to the HTTP
   * `/bot-runtime/presence` payload.
   */
  async updatePresence(body: Record<string, unknown>): Promise<void> {
    const { ack } = await this.emitWrite("bot:presence:update", body)
    if (ack) {
      if (!ack.ok) this.logFn(`presence rejected (${ack.code ?? "?"}): ${ack.message ?? ""}`)
      return
    }
    // Idempotent upsert on (workspace, bot, instance) — safe to retry over HTTP on
    // any missing ack; a redundant upsert when the WS frame lands is last-writer-wins.
    await this.httpPresenceFallback(body)
  }

  // --- Socket write primitive -----------------------------------------------

  /**
   * Emit a write event and await its ack.
   *
   * `sent` distinguishes the two failure modes that look identical at the ack
   * layer but must NOT be handled the same way: `sent: false` means the frame
   * never left (no live socket / `emit` threw), so an HTTP retry is the only way
   * the write lands and is safe; `sent: true, ack: null` means the frame IS in
   * flight but the server didn't ack within the timeout. Steps carry a
   * `client_step_id` so a re-POST would dedup rather than duplicate, but it would
   * still bill an edge request the WS path exists to avoid — so a best-effort
   * caller drops on `sent` instead of retrying. Idempotent writes (renew CAS,
   * presence upsert) ignore the distinction and retry on either.
   */
  private emitWrite(event: string, payload: unknown): Promise<{ sent: boolean; ack: BotWriteAck | null }> {
    const socket = this.socket
    if (!socket || !this.connected) return Promise.resolve({ sent: false, ack: null })
    return new Promise((resolve) => {
      let settled = false
      const done = (result: { sent: boolean; ack: BotWriteAck | null }) => {
        if (settled) return
        settled = true
        resolve(result)
      }
      try {
        socket.timeout(this.wsAckTimeoutMs).emit(event, payload, (err: unknown, ack: unknown) => {
          // Either way the frame was sent; only the ack is in question.
          done({ sent: true, ack: err ? null : normalizeAck(ack) })
        })
      } catch (error) {
        this.logFn(`socket emit ${event} threw: ${summarize(error)}`)
        done({ sent: false, ack: null })
      }
    })
  }

  // --- HTTP fallback --------------------------------------------------------

  /** The wsUrl hint is served by the edge workspace-router at `/api/workspaces/:id/config` (NOT /api/v1). */
  async resolveWsHint(): Promise<WsHint | undefined> {
    const res = await this.httpRequest(`/api/workspaces/${this.workspaceId}/config`, { method: "GET" })
    if (!res.ok) return undefined
    const body = (await res.json()) as { wsUrl?: string }
    return parseWsHint({ url: body.wsUrl })
  }

  private async httpRecordStepsFallback(
    invocationId: string,
    claimToken: string,
    steps: StepFrame[],
    statusText: string | undefined,
    instanceId: string
  ): Promise<void> {
    // The HTTP /steps endpoint takes one step per request, so a batched WS frame
    // unrolls into N posts here. Best-effort: swallow per-step failures.
    for (const step of steps) {
      try {
        await this.httpRequest(this.v1Path(`/bot-invocations/${invocationId}/steps`), {
          method: "POST",
          body: JSON.stringify({
            instanceId,
            claimToken,
            stepType: step.stepType,
            content: step.content,
            ...(step.clientStepId ? { clientStepId: step.clientStepId } : {}),
            ...(statusText ? { statusText } : {}),
          }),
        })
      } catch (error) {
        this.logFn(`step HTTP fallback failed: ${summarize(error)}`)
      }
    }
  }

  private async httpRecordSealedStepsFallback(
    invocationId: string,
    callbackToken: string,
    steps: SealedStepFrame[]
  ): Promise<void> {
    // The HTTP /sealed-steps endpoint takes one step per request, so a batched
    // WS frame unrolls into N posts here. Best-effort: swallow per-step failures.
    for (const step of steps) {
      try {
        await this.httpRequest(this.v1Path(`/bot-invocations/${invocationId}/sealed-steps`), {
          method: "POST",
          headers: { [THREA_CALLBACK_TOKEN_HEADER]: callbackToken },
          body: JSON.stringify(step),
        })
      } catch (error) {
        this.logFn(`sealed step HTTP fallback failed: ${summarize(error)}`)
      }
    }
  }

  private async httpRenewFallback(
    invocationId: string,
    claimToken: string,
    claimTtlSeconds: number,
    instanceId: string
  ): Promise<{ notFound: boolean }> {
    try {
      const res = await this.httpRequest(this.v1Path(`/bot-invocations/${invocationId}/renew`), {
        method: "POST",
        body: JSON.stringify({ instanceId, claimToken, claimTtlSeconds }),
      })
      if (res.status === 404) return { notFound: true }
      if (!res.ok) this.logFn(`renew HTTP fallback ${res.status}`)
      return { notFound: false }
    } catch (error) {
      this.logFn(`renew HTTP fallback failed: ${summarize(error)}`)
      return { notFound: false }
    }
  }

  private async httpPresenceFallback(body: Record<string, unknown>): Promise<void> {
    try {
      await this.httpRequest(this.v1Path("/bot-runtime/presence"), { method: "POST", body: JSON.stringify(body) })
    } catch (error) {
      this.logFn(`presence HTTP fallback failed: ${summarize(error)}`)
    }
  }

  private v1Path(suffix: string): string {
    return `/api/v1/workspaces/${this.workspaceId}${suffix}`
  }

  private async httpRequest(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs)
    try {
      return await fetch(`${this.base}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...init.headers,
        },
      })
    } finally {
      clearTimeout(timeout)
    }
  }
}

function normalizeAck(ack: unknown): BotWriteAck | null {
  if (!isObject(ack) || typeof ack.ok !== "boolean") return null
  return {
    ok: ack.ok,
    data: isObject(ack.data) ? ack.data : undefined,
    code: typeof ack.code === "string" ? ack.code : undefined,
    message: typeof ack.message === "string" ? ack.message : undefined,
  }
}

function summarize(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200)
}
