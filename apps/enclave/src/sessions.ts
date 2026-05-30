import type { NextFunction, Request, Response } from "express"
import { timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { INTERNAL_API_KEY_HEADER, type EnclaveSessionAssignment } from "@threa/types"
import type { EnclaveKeyPair } from "./keystore"
import type { RawChatFn } from "./llm"
import type { BackendCallbacks } from "./agent/backend-callbacks"
import { runEnclaveSession } from "./agent/session-runner"

/**
 * `POST /sessions` — the enclave's only content-bearing endpoint.
 *
 * The backend assigns an E2E scratchpad turn here without ever decrypting it.
 * This module is the HTTP shell: auth gate, body validation, and a fast 202 ack.
 * The enclave then runs the agent loop *asynchronously* (decrypt → loop → seal)
 * and reports back over the session callbacks; see `agent/session-runner.ts`.
 */

// Bounds on an assigned turn, centralized rather than inlined in the schema
// (INV-33). The history window especially is a tuning knob the dispatch path
// owns; the rest cap a malformed/hostile body.
const MAX_HISTORY_MESSAGES = 200
const MAX_WRAP_RECIPIENTS = 64
const MAX_SYSTEM_PROMPT_CHARS = 100_000
const MAX_MODEL_ID_CHARS = 200
const MAX_COMPLETION_TOKENS = 32_000

const streamEnvelopeSchema = z.object({
  v: z.number(),
  keyGeneration: z.number().int().min(0),
  iv: z.string().min(1),
  aad: z.string().min(1),
})

const sealedMessageSchema = z.object({
  ciphertext: z.string().min(1),
  envelope: streamEnvelopeSchema,
})

export const sessionAssignmentSchema = z.object({
  sessionId: z.string().min(1),
  streamId: z.string().min(1),
  /** One SSK wrap per generation referenced by `history`/`prompt`, addressed to this EIK. */
  wraps: z
    .array(
      z.object({
        keyGeneration: z.number().int().min(0),
        wrapEnc: z.string().min(1),
        wrapCt: z.string().min(1),
      })
    )
    .min(1)
    .max(MAX_WRAP_RECIPIENTS),
  /** Prior turns, oldest→newest. Each item's role tells the model who spoke. */
  history: z
    .array(sealedMessageSchema.extend({ role: z.enum(["user", "assistant"]) }))
    .max(MAX_HISTORY_MESSAGES)
    .default([]),
  /** The user message that triggered this invocation (always the latest `user` turn). */
  prompt: sealedMessageSchema,
  /** Ariadne's system prompt — non-secret persona text the backend supplies in the clear. */
  system: z.string().min(1).max(MAX_SYSTEM_PROMPT_CHARS),
  /** OpenRouter model id, e.g. `anthropic/claude-sonnet-4.6`. */
  model: z.string().min(1).max(MAX_MODEL_ID_CHARS),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(MAX_COMPLETION_TOKENS).optional(),
  /** Where to seal replies: current generation + Ariadne's sender id. */
  reply: z.object({
    keyGeneration: z.number().int().min(0),
    senderId: z.string().min(1),
  }),
})

export interface SessionsDeps {
  keyPair: EnclaveKeyPair
  rawChat: RawChatFn
  callbacks: BackendCallbacks
  /** Session ids currently running in this process, to dedupe a redelivered assignment. */
  inFlight: Set<string>
}

/** Length-safe constant-time secret comparison (avoids the throw on length mismatch). */
function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * Gate for `/sessions`: only the backend may assign — it carries the shared
 * internal-api-key. The EIK pubkey is public, so without this anyone could wrap
 * their own SSK to it and use the enclave as an LLM / decryption oracle. Mounted
 * *before* the body parser so an unauthorized caller never costs us a JSON parse.
 */
export function requireInternalKey(internalApiKey: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const presented = req.header(INTERNAL_API_KEY_HEADER)
    if (!presented || !secretsMatch(presented, internalApiKey)) {
      res.status(401).json({ error: "Unauthorized" })
      return
    }
    next()
  }
}

/**
 * Express adapter for `POST /sessions`. Assumes `requireInternalKey` already
 * gated the request. Validates the assignment, acks 202, and runs the turn
 * asynchronously — the response never carries content (which would defeat the
 * no-plaintext-egress guarantee); replies flow back over the session callbacks.
 */
export function createSessionsHandler(deps: SessionsDeps) {
  return (req: Request, res: Response): void => {
    const parsed = sessionAssignmentSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid session assignment" })
      return
    }
    const assignment: EnclaveSessionAssignment = parsed.data

    // Redelivered assignment for a session already running here — ack without
    // starting a second loop.
    if (deps.inFlight.has(assignment.sessionId)) {
      res.status(202).end()
      return
    }

    deps.inFlight.add(assignment.sessionId)
    // Ack first; the loop runs detached and reports back over the callbacks.
    res.status(202).end()
    void runEnclaveSession(
      { keyPair: deps.keyPair, rawChat: deps.rawChat, callbacks: deps.callbacks },
      assignment
    ).finally(() => deps.inFlight.delete(assignment.sessionId))
  }
}
