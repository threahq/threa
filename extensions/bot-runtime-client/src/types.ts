import type { StreamEnvelope } from "./crypto"
import type { InvocationControlScheduler } from "./invocation-control"

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
  /**
   * `started` opens a tool row before the tool finishes (tool_call/tool_error
   * only). A started frame must carry its own clientStepId; the finishing frame
   * reuses it.
   */
  phase?: "started"
  /** Wall-clock tool runtime on the finishing frame; requires clientStepId. */
  durationMs?: number
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
  manifest?: {
    output: { reply?: boolean; trace?: boolean; sources?: boolean }
    input?: { updates: "live" | "restart" }
  }
  /** ISO cursor echoed from the previous hello ack so the bootstrap only replays unseen events. */
  sinceCursor?: string
  /**
   * This install's end-to-end keyring (see `E2eKeyring`). The server stores the
   * advertised set as the instance's complete keyring, so it must ride every
   * hello AND presence write: omitting it on a heartbeat leaves the stored set
   * alone, and sending `[]` unregisters every key.
   */
  e2eKeys?: { keyId: string; publicKey: string; streamId?: string }[]
  /**
   * The keyring's default key, for a server from before the registry. Both name
   * the same key, so a mixed-version rollout addresses one key either way.
   */
  publicKey?: string
  publicKeyId?: string
}

/** `bot:e2e_grant`: this bot became an actor on a sealed scratchpad root. */
export interface BotE2eGrantPayload {
  workspaceId: string
  botId: string
  streamId: string
}

/** The bootstrap snapshot the server returns in the `bot:hello` ack. */
export interface BotHelloBootstrap {
  serverGeneratedAt?: string
  /**
   * This bot's own id, as the server authenticated it. A sealed decision card's
   * AAD names its requester, so a runtime cannot seal one until it knows which
   * bot it is. Absent against a server from before that field shipped.
   */
  botId?: string
  availableInvocations: unknown[]
  ownedClaims: unknown[]
  /** Sealed scratchpads this bot is an actor on — the catch-up for `bot:e2e_grant`. */
  e2eGrantedStreamIds: string[]
}

/** Wakeup/hint callbacks the transport fires from server→client socket events. */
/** Slim nudge emitted to the workspace runtime room when a delegation is created (roadmap 5.4). */
export interface DelegationAvailableNudge {
  workspaceId: string
  streamId: string
  delegationId?: string
  title?: string
}

/**
 * The decision outcome pushed to the requesting runtime's session room
 * (`decision:resolved` / `decision:cancelled`). Mirrors the server's
 * `botDecisionPayloadSchema`; `extensions/*` do not depend on `@threahq/types`.
 */
export interface BotDecisionPayload {
  workspaceId: string
  botId: string
  streamId: string
  runtimeSessionId: string
  decisionId: string
  status: DecisionRequestStatus
  optionId: string | null
  note: string | null
  /** The sealed half of the answer's note, on an encrypted stream; `note` is null there. */
  noteCiphertext: string | null
  noteEnvelope: StreamEnvelope | null
  version: number
}

export type DecisionRequestStatus = "open" | "resolved" | "cancelled" | "expired"

export interface DecisionOption {
  id: string
  /** Omitted on a sealed card: the labels travel inside the ciphertext. */
  label?: string
  tone?: "primary" | "neutral" | "destructive"
}

export interface DecisionResolution {
  optionId: string
  note?: string
  /** The sealed note, on an encrypted stream. */
  noteCiphertext?: string
  noteEnvelope?: StreamEnvelope
  /** Absent when the resolution was reconstructed from a socket push, which carries only the answer. */
  decidedBy?: string
  decidedAt?: string
}

/** Body of `POST /streams/:streamId/decisions`. */
export interface CreateDecisionRequestBody {
  /** Omitted on a sealed card: the title travels inside the ciphertext. */
  title?: string
  bodyMarkdown?: string
  options: DecisionOption[]
  /**
   * The card's id, minted by the requester. Required with `sealed` — the AAD
   * binds the ciphertext to the id, so the id has to exist before the seal.
   */
  decisionId?: string
  /** The sealed question, on an encrypted stream. Ids and tones stay in the clear. */
  sealed?: { ciphertext: string; envelope: StreamEnvelope }
  allowNote?: boolean
  externalRef?: string
  expiresInMs?: number
  runtimeSessionId: string
  invocationId?: string
}

/** Minimal mirror of the server's `DecisionRequest` wire shape — what the SDK reads. */
export interface DecisionRequest {
  id: string
  workspaceId: string
  streamId: string
  requesterBotId?: string
  requesterRuntimeSessionId?: string
  requesterInvocationId?: string
  status: DecisionRequestStatus
  title: string
  options: DecisionOption[]
  /** Present on a sealed card; `title` and every option `label` are placeholders then. */
  ciphertext?: string
  envelope?: StreamEnvelope
  allowNote: boolean
  externalRef?: string
  resolution?: DecisionResolution
  expiresAt?: string
  version: number
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
  /** This bot was invited into a sealed scratchpad; a per-stream keyring mints its key here. */
  onE2eGrant?: (payload: BotE2eGrantPayload) => void
  /** The server asked the runtime to re-announce itself; the transport re-sends hello automatically and also fires this. */
  onResync?: () => void
  /** The scratchpad this runtime session is linked to was archived; the link is ended server-side. Wind down. */
  onSessionArchived?: (payload: unknown) => void
  /** The archived scratchpad was unarchived; the link is active again server-side. Cancel the wind-down and reattach. */
  onSessionRestored?: (payload: unknown) => void
  /** The `bot:hello` ack landed; carries the bootstrap snapshot. */
  onBootstrap?: (bootstrap: BotHelloBootstrap) => void
  /** A decision this runtime opened was answered; the requester unblocks on it. */
  onDecisionResolved?: (payload: BotDecisionPayload) => void
  /** A decision this runtime opened was cancelled (or expired) without an answer. */
  onDecisionCancelled?: (payload: BotDecisionPayload) => void
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
  /** Observed-claim retry/poll cadence. Default 5s. */
  controlRetryDelayMs?: number
  /** Earliest observed-claim renewal delay. Default 1s. */
  controlMinRenewDelayMs?: number
  /** Optional observed-claim timer scheduler for deterministic hosts/tests. */
  controlScheduler?: InvocationControlScheduler
  /**
   * How long a socket may sit disconnected before `connect()` tears it down and
   * redials from a fresh ws hint. Default 3 min. Socket.IO's own retry loop
   * handles brief drops; this backstop catches the wedged states it can't — a
   * stale ws hint after the backend moved, or a client stuck post-kick.
   */
  staleSocketRedialMs?: number
  log?: (message: string) => void
}
