import type { AgentSessionStatus, AgentStepType } from "./constants"

// Source types for trace steps
export const TRACE_SOURCE_TYPES = ["web", "workspace", "workspace_message", "workspace_memo", "github"] as const
export type TraceSourceType = (typeof TRACE_SOURCE_TYPES)[number]

export interface TraceSource {
  type: TraceSourceType
  title: string
  url?: string
  domain?: string
  snippet?: string
  memoId?: string
  streamId?: string
  streamName?: string
  messageId?: string
  authorName?: string
  timestamp?: string
}

/**
 * The JSON content of a `turn_digest` step — the compact end-of-session record
 * of the turn's tool work (C-1), persisted as the session's final step row and
 * injected into later turns' context builds so follow-ups ("what did that
 * article say?") don't force a re-search. `findings` is model-written prose;
 * the other fields are recorded deterministically from the loop's tool events.
 * For E2E sessions the whole object is sealed as the step's ciphertext; for
 * plaintext sessions it is the step's `content` JSON string.
 */
export interface TurnDigestStepContent {
  /** Model-written summary of what the turn's tools found — compact, self-contained. */
  findings: string
  /** Tool names the turn called (first-call order, deduped). */
  toolsCalled: string[]
  /** Citation sources the turn's tools produced (deduped, bounded). */
  sources: TraceSource[]
  /**
   * Stream ids of the workspace material this digest contains — provenance for
   * the access re-filter at injection time (a stream that was readable when the
   * digest was written can become inaccessible later; injection must re-check
   * against the location's CURRENT access). Web-derived content is exempt
   * (public), so a web-only digest records an empty array. Recorded from the
   * first digest shipped: provenance cannot be retrofitted onto old digests.
   */
  sourceStreamIds: string[]
}

export type AgentSessionRerunCause = "invoking_message_edited" | "referenced_message_edited"

export interface AgentSessionRerunContext {
  cause: AgentSessionRerunCause
  editedMessageId: string
  editedMessageRevision?: number | null
  editedMessageBefore?: string | null
  editedMessageAfter?: string | null
}

// Agent session step (wire format for API responses)
export interface AgentSessionStep {
  id: string
  sessionId: string
  stepNumber: number
  stepType: AgentStepType
  content?: string
  /**
   * E2E (enclave) steps only: the step's content sealed under the stream's SSK,
   * stored as base64 ciphertext + its envelope. When present, `content` is
   * absent and the browser decrypts these to recover the renderable content
   * (the same string a plaintext step would carry in `content`). The server
   * only ever relays these bytes (INV-E7).
   */
  contentCiphertext?: string
  contentEnvelope?: unknown
  sources?: TraceSource[]
  messageId?: string
  duration?: number
  tokensUsed?: number
  startedAt: string
  completedAt?: string
}

// Agent session (wire format for API responses)
export interface AgentSession {
  id: string
  streamId: string
  personaId: string
  triggerMessageId: string
  triggerMessageRevision?: number | null
  supersedesSessionId?: string | null
  rerunContext?: AgentSessionRerunContext | null
  status: AgentSessionStatus
  currentStepType?: AgentStepType
  sentMessageIds: string[]
  createdAt: string
  completedAt?: string
}

// API response for fetching a session with steps
export interface AgentSessionWithSteps {
  session: AgentSession
  steps: AgentSessionStep[]
  persona: {
    id: string
    name: string
    avatarUrl: string | null
    avatarEmoji?: string | null
  }
  relatedSessions: AgentSession[]
}

// Real-time socket event for cross-stream activity
// Backend sends semantic stepType, frontend maps to display labels
export interface AgentActivityUpdate {
  sessionId: string
  personaName: string
  stepType: AgentStepType | null
}

// Real-time progress payload (emitted per step to stream room, not persisted)
export interface AgentSessionProgressPayload {
  workspaceId: string
  streamId: string
  sessionId: string
  triggerMessageId: string
  personaName: string
  stepCount: number
  messageCount: number
  currentStepType: AgentStepType
  /** Thread stream ID for channel mentions - allows frontend to link directly to thread */
  threadStreamId?: string
}

// Stream event payloads for agent session lifecycle
export interface AgentSessionStartedPayload {
  sessionId: string
  personaId: string
  personaName: string
  triggerMessageId: string
  rerunContext?: AgentSessionRerunContext | null
  /** Bootstrap-only snapshot for running sessions; live updates still use agent_session:progress. */
  stepCount?: number
  messageCount?: number
  currentStepType?: AgentStepType | null
  startedAt: string
}

export interface AgentSessionCompletedPayload {
  sessionId: string
  stepCount: number
  messageCount: number
  duration: number
  completedAt: string
}

export interface AgentSessionFailedPayload {
  sessionId: string
  stepCount: number
  error: string
  traceId: string
  failedAt: string
}

export interface AgentSessionDeletedPayload {
  sessionId: string
  deletedAt: string
}

// Session-room socket event payloads (for trace dialog real-time updates)
export interface StepStartedPayload {
  sessionId: string
  step: AgentSessionStep
}

export interface StepProgressPayload {
  sessionId: string
  stepId: string
  content?: string
}

export interface StepCompletedPayload {
  sessionId: string
  step: AgentSessionStep
}

export interface SessionTerminalPayload {
  sessionId: string
}

/**
 * Real-time substep payload emitted during a running step (ephemeral — not persisted).
 *
 * Used by long-running tools (e.g. workspace_research) to stream human-readable phase
 * text to the user during a single step's execution, without creating a new persisted
 * step row. On step completion the persisted `step.content` carries the full substep
 * history (baked in by the tool's `trace.formatContent`) so browser refresh gives
 * stable state for completed steps.
 *
 * Emitted to BOTH the stream room (timeline inline card) and the session room (trace
 * dialog) so both surfaces receive updates. Frontend clears ephemeral state on
 * `agent_session:step:completed` and reads from persisted `step.content` thereafter.
 */
export interface AgentSessionSubstepPayload {
  workspaceId: string
  streamId: string
  sessionId: string
  triggerMessageId: string
  /** The step type this substep belongs to (e.g. "workspace_search"). */
  stepType: AgentStepType
  /**
   * Human-readable phase text — e.g. "Planning queries…", "Evaluating results…".
   * Present for plaintext (non-E2E) sessions. For E2E sessions the text is sealed
   * (derived from encrypted content), so it ships as `ciphertext`/`envelope`
   * instead and the client decrypts it.
   */
  substep?: string
  /** E2E: sealed phase text — base64 ciphertext the client decrypts under the SSK. */
  ciphertext?: string
  /** E2E: stream envelope for `ciphertext` (HPKE/SSK metadata). */
  envelope?: unknown
  /** ISO timestamp for ordering when multiple substeps arrive rapidly. */
  updatedAt: string
}

// Emitted to channel room when agent session starts (for immediate inline indicator)
export interface AgentActivityStartedPayload {
  sessionId: string
  triggerMessageId: string
  personaName: string
  /** Thread stream ID - allows frontend to link directly to thread before stream:created arrives */
  threadStreamId: string
}

// Emitted to channel room when agent session ends (for inline indicator cleanup)
export interface AgentActivityEndedPayload {
  sessionId: string
  triggerMessageId: string
}
