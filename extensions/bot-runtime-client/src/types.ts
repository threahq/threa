/**
 * The ack the `/bot` write events return. `ok: true` means the server persisted
 * the write; `ok: false` carries a `code` (`NOT_FOUND`, `FORBIDDEN`,
 * `INVALID_PAYLOAD`, `INTERNAL_ERROR`, …) the client uses to tell a terminal
 * failure from one worth an HTTP retry.
 */
export interface BotWriteAck {
  ok: boolean
  data?: Record<string, unknown>
  code?: string
  message?: string
}

/** One trace step. A single `recordSteps` call may carry several. */
export interface StepFrame {
  stepType: string
  content: string
  /**
   * Idempotency key. The transport mints one per frame if absent and sends the
   * same value over WS and the HTTP fallback, so a step can never be persisted
   * twice under the same key (the server dedups on it).
   */
  clientStepId?: string
}

/** The `bot:hello` registration payload — mirrors the server's `helloSchema`. */
export interface BotRuntimeHello {
  instanceId: string
  runtimeKind: string
  runtimeSessionId?: string
  displayName?: string | null
  status?: "available" | "busy" | "offline" | "error"
  acceptingInvocations?: boolean
  supportedCapabilities: string[]
  capabilities?: Record<string, unknown>
  manifest?: { output: { reply?: boolean; trace?: boolean; sources?: boolean } }
  /** ISO cursor echoed from the previous hello ack so the bootstrap only replays unseen events. */
  sinceCursor?: string
  /**
   * Base64 X25519 public half of this install's BIK (see `BikKeystore`). Must
   * ride every hello AND presence write together with `publicKeyId` — the
   * server's instance upsert overwrites the stored key by default, so omitting
   * it on a heartbeat clears the registration and breaks sealed-claim coverage.
   */
  publicKey?: string
  publicKeyId?: string
}

/** The bootstrap snapshot the server returns in the `bot:hello` ack. */
export interface BotHelloBootstrap {
  serverGeneratedAt?: string
  availableInvocations: unknown[]
  ownedClaims: unknown[]
}

/** Wakeup/hint callbacks the transport fires from server→client socket events. */
/** Slim nudge emitted to the workspace runtime room when a delegation is created (roadmap 5.4). */
export interface DelegationAvailableNudge {
  workspaceId: string
  streamId: string
  delegationId?: string
  title?: string
}

export interface BotRuntimeTransportCallbacks {
  /** New work is claimable — the runtime should drain its claim loop. */
  onInvocationAvailable?: () => void
  /** A delegation was created somewhere in the workspace — a delegation runner should drain. */
  onDelegationAvailable?: (payload: DelegationAvailableNudge) => void
  /** Another instance claimed an invocation (stop racing). */
  onInvocationClaimed?: (payload: unknown) => void
  /** The active scratchpad actor changed for some stream. */
  onActiveActorChanged?: (payload: unknown) => void
  /** The server asked the runtime to re-announce itself; the transport re-sends hello automatically and also fires this. */
  onResync?: () => void
  /** The scratchpad this runtime session is linked to was archived; the link is ended server-side. Wind down. */
  onSessionArchived?: (payload: unknown) => void
  /** The archived scratchpad was unarchived; the link is active again server-side. Cancel the wind-down and reattach. */
  onSessionRestored?: (payload: unknown) => void
  /** The `bot:hello` ack landed; carries the bootstrap snapshot. */
  onBootstrap?: (bootstrap: BotHelloBootstrap) => void
  /** A hello-ready socket became unavailable; wake any HTTP delivery backstop parked on the healthy-socket cadence. */
  onDisconnected?: () => void
}

export interface BotRuntimeTransportOptions {
  baseUrl: string
  workspaceId: string
  apiKey: string
  hello: BotRuntimeHello
  beforeHello?: (hello: BotRuntimeHello) => void
  callbacks?: BotRuntimeTransportCallbacks
  /** How long to wait for a write-event ack before falling back to HTTP. Default 5s. */
  wsAckTimeoutMs?: number
  /** Socket.IO reconnection backoff ceiling. Default 30s. */
  reconnectionDelayMaxMs?: number
  /** HTTP fallback request timeout. Default 30s. */
  fetchTimeoutMs?: number
  /**
   * How long a socket may sit disconnected before `connect()` tears it down and
   * redials from a fresh ws hint. Default 3 min. Socket.IO's own retry loop
   * handles brief drops; this backstop catches the wedged states it can't — a
   * stale ws hint after the backend moved, or a client stuck post-kick.
   */
  staleSocketRedialMs?: number
  log?: (message: string) => void
}
