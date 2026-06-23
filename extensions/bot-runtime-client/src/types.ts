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
  supportedCapabilities: string[]
  capabilities?: Record<string, unknown>
  manifest?: { output: { reply?: boolean; trace?: boolean; sources?: boolean } }
  /** ISO cursor echoed from the previous hello ack so the bootstrap only replays unseen events. */
  sinceCursor?: string
}

/** The bootstrap snapshot the server returns in the `bot:hello` ack. */
export interface BotHelloBootstrap {
  serverGeneratedAt?: string
  availableInvocations: unknown[]
  ownedClaims: unknown[]
}

/** Wakeup/hint callbacks the transport fires from server→client socket events. */
export interface BotRuntimeTransportCallbacks {
  /** New work is claimable — the runtime should drain its claim loop. */
  onInvocationAvailable?: () => void
  /** Another instance claimed an invocation (stop racing). */
  onInvocationClaimed?: (payload: unknown) => void
  /** The active scratchpad actor changed for some stream. */
  onActiveActorChanged?: (payload: unknown) => void
  /** The server asked the runtime to re-announce itself; the transport re-sends hello automatically and also fires this. */
  onResync?: () => void
  /** The `bot:hello` ack landed; carries the bootstrap snapshot. */
  onBootstrap?: (bootstrap: BotHelloBootstrap) => void
}

export interface BotRuntimeTransportOptions {
  baseUrl: string
  workspaceId: string
  apiKey: string
  hello: BotRuntimeHello
  callbacks?: BotRuntimeTransportCallbacks
  /** How long to wait for a write-event ack before falling back to HTTP. Default 5s. */
  wsAckTimeoutMs?: number
  /** Socket.IO reconnection backoff ceiling. Default 30s. */
  reconnectionDelayMaxMs?: number
  /** HTTP fallback request timeout. Default 30s. */
  fetchTimeoutMs?: number
  log?: (message: string) => void
}
