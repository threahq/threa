import type {
  AgentStepType,
  BotRuntimeKind,
  BotRuntimeManifest,
  BotRuntimeStatus,
  InvocationControlState,
} from "@threahq/types"
import type { BotRuntimeInstance } from "./repository"

/**
 * Transport-agnostic bot-runtime background writes — the persistence core of
 * the HTTP `presence` / `renew` / `steps` handlers, lifted out so the `/bot`
 * WebSocket namespace and the REST routes drive the *same* path. The interface
 * lives here (the domain feature) so `socket-handler.ts` depends only on the
 * contract; the implementation (`createBotRuntimeWriteOps`) lives in
 * `public-api`, where the trace projector, bot lookup, and stream-access check
 * already are, and is injected at boot (see `server.ts`). This keeps the
 * dependency arrow public-api → bot-runtimes one-way.
 *
 * Methods throw `HttpError` on failure (claim-not-found, manifest-rejected,
 * stream-inaccessible). The REST handler lets the error middleware format it;
 * the socket handler maps it to an `{ ok: false, code, message }` ack. A client
 * treats any ack — ok or not — as "the server handled it"; only a missing ack
 * or a dead socket triggers the HTTP fallback.
 */
export interface BotRuntimeWriteOps {
  /** Full presence upsert + broadcast. The REST `presence` handler returns the row. */
  applyPresence(params: ApplyPresenceParams): Promise<BotRuntimeInstance>
  /**
   * Best-effort presence touch used by claim/steps as a piggybacked heartbeat.
   * Swallows its own errors (presence is liveness, not correctness) so it never
   * fails the operation it rides along with.
   */
  touchPresence(params: TouchPresenceParams): Promise<void>
  /** Renew a claim lease + bump the agent-session heartbeat. Throws 404 if the claim is gone. */
  renewClaim(params: RenewClaimParams): Promise<RenewClaimResult>
  /** Append one or more trace steps through the shared projector. Throws on auth/manifest failure. */
  recordSteps(params: RecordStepsParams): Promise<RecordStepsResult>
  /**
   * Finalize one or more SEALED trace steps for an E2E turn (ciphertext +
   * envelope; the server never reads the content, INV-E7). Auth is the
   * per-claim callback token (model A), not `instanceId`/`claimToken` — the
   * sealed sibling of `recordSteps`, shared by the sealed `/sealed-steps` REST
   * route and the `bot:invocation:sealed-steps` WS frame.
   */
  recordSealedSteps(params: RecordSealedStepsParams): Promise<RecordSealedStepsResult>
}

export interface ApplyPresenceParams {
  workspaceId: string
  botId: string
  runtimeKind: BotRuntimeKind
  instanceId: string
  runtimeSessionId?: string
  displayName?: string | null
  status: BotRuntimeStatus
  acceptingInvocations: boolean
  capabilities?: Record<string, unknown>
  manifest?: BotRuntimeManifest | null
  statusText?: string | null
  publicKey?: string | null
  publicKeyId?: string | null
}

export interface TouchPresenceParams {
  workspaceId: string
  botId: string
  runtimeKind: BotRuntimeKind
  instanceId: string
  runtimeSessionId?: string
  status: BotRuntimeStatus
  acceptingInvocations: boolean
  statusText?: string | null
}

export interface RenewClaimParams {
  workspaceId: string
  botId: string
  invocationId: string
  instanceId: string
  claimToken: string
  claimTtlSeconds: number
  knownSourceRevision?: number
  restartRequiredRevision?: number
}

export type RenewClaimResult = InvocationControlState & { invocationId: string }

export interface RecordStepFrame {
  stepType: AgentStepType
  content: string
  /** Client idempotency key — a re-send under the same key dedups to the first row. */
  clientStepId?: string
}

export interface RecordStepsParams {
  workspaceId: string
  botId: string
  invocationId: string
  instanceId: string
  claimToken: string
  steps: RecordStepFrame[]
  /** Most-recent status line for the piggybacked busy-presence touch. */
  statusText?: string | null
}

export interface RecordStepResult {
  stepId: string
  stepNumber: number
}

export interface RecordStepsResult {
  invocationId: string
  sessionId: string
  steps: RecordStepResult[]
}

/** One sealed step to finalize: `stepType` + ids + timing are clear, content is ciphertext (INV-E7). */
export interface RecordSealedStepFrame {
  /** Client-minted `step_…` id — keys the row, binds the seal AAD, and doubles as the idempotency key. */
  stepId: string
  stepType: AgentStepType
  messageId?: string
  /** Base64 AES-GCM ciphertext of the step content. */
  ciphertext: string
  envelope: { v: number; keyGeneration: number; iv: string; aad: string }
  durationMs?: number
}

export interface RecordSealedStepsParams {
  workspaceId: string
  botId: string
  invocationId: string
  /** The per-claim callback token delivered inside the winning sealed claim (model A). */
  callbackToken: string
  steps: RecordSealedStepFrame[]
}

export interface RecordSealedStepsResult {
  invocationId: string
  sessionId: string
  steps: RecordStepResult[]
}
