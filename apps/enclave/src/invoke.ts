import type { NextFunction, Request, Response } from "express"
import { timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { INTERNAL_API_KEY_HEADER, type EnclaveInvokeRequest } from "@threa/types"
import type { EnclaveKeyPair } from "./keystore"
import type { RawChatFn } from "./llm"
import { InvokeError, runEnclaveTurn } from "./agent/run-turn"

/**
 * `/invoke` — the enclave's only content-bearing endpoint.
 *
 * The backend forwards an E2E scratchpad turn here without ever decrypting it.
 * This module is the HTTP shell: auth gate, body validation, and error mapping.
 * The decrypt → run-the-agent-loop → seal work lives in `agent/run-turn.ts`.
 */

// Bounds on a forwarded turn, centralized rather than inlined in the schema
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

export const invokeRequestSchema = z.object({
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

// The zod-inferred shape is the runtime guard; the canonical contract lives in
// @threa/types so the backend forwarder builds exactly what we validate here.
export type InvokeRequest = EnclaveInvokeRequest

export interface InvokeDeps {
  keyPair: EnclaveKeyPair
  rawChat: RawChatFn
}

/** Length-safe constant-time secret comparison (avoids the throw on length mismatch). */
function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * Gate for `/invoke`: only the backend forwarder may call it — it carries the
 * shared internal-api-key. The EIK pubkey is public, so without this anyone
 * could wrap their own SSK to it and use the enclave as an LLM / decryption
 * oracle. Mounted *before* the body parser so an unauthorized caller is rejected
 * without us parsing (up to multi-MB of) their JSON.
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
 * Express adapter for `/invoke`. Assumes `requireInternalKey` already gated the
 * request. Validates the body, runs the turn, and answers with status only on
 * failure — error bodies never echo request content (which would defeat the
 * no-plaintext-egress guarantee).
 */
export function createInvokeHandler(deps: InvokeDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const parsed = invokeRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid invoke request" })
      return
    }
    try {
      // Assigning through the contract type (no `as`) makes a schema/contract
      // drift a compile error here rather than a silent mismatch.
      const request: EnclaveInvokeRequest = parsed.data
      const result = await runEnclaveTurn(deps, request)
      res.json(result)
    } catch (err) {
      if (err instanceof InvokeError) {
        res.status(400).json({ error: err.message })
        return
      }
      // Opaque 500 — a crypto/LLM failure message could carry content.
      res.status(500).json({ error: "Invoke failed" })
    }
  }
}
