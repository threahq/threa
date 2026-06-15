import { z } from "zod"
import { AUTHOR_TYPES, TOOL_PRIVACY_CATEGORIES } from "@threa/types"

/**
 * Schema for a claimed session assignment — the body of a winning claim
 * response (`POST <backend>/internal/enclave-runtimes/claims` → 200
 * `{ assignment }`). The enclave validates what it pulled before decrypting
 * anything: the backend is the only party that can answer the claim (the
 * internal-key channel), but a malformed or truncated payload must fail
 * loudly here rather than surface later as an opaque decrypt error mid-turn.
 */

// Bounds on a claimed turn, centralized rather than inlined in the schema
// (INV-33). The history window especially is a tuning knob the backend's
// claim service owns; the rest cap a malformed body.
const MAX_HISTORY_MESSAGES = 200
const MAX_WRAP_RECIPIENTS = 64
const MAX_SYSTEM_PROMPT_CHARS = 100_000
const MAX_MODEL_ID_CHARS = 200
const MAX_COMPLETION_TOKENS = 32_000
/**
 * Upper bound on inline-shipped files per assignment (trigger + recent
 * history). Matches the claim service's own count cap — the byte budget
 * usually binds first, but a flood of tiny files must not reject the whole
 * assignment.
 */
const MAX_INLINE_ATTACHMENTS = 64
/**
 * Upper bound on prior-turn digests per assignment. The claim service ships
 * `TURN_DIGEST_INJECT_COUNT` (5); this caps a malformed body.
 */
const MAX_RECENT_DIGESTS = 16
/**
 * Upper bound on the verbatim-window char budget. Generous over the companion's
 * 80k default — it only rejects an absurd/malformed value, the real limiter is
 * the budget the claim service ships.
 */
const MAX_WINDOW_CHARS = 1_000_000

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
  /**
   * Claim-minted callback-binding secret (Phase 2.4b, E2EE-21), echoed on
   * every session callback. Required: the backend rejects tokenless
   * callbacks outright, so an assignment without it could never report a
   * single result — better to fail the parse loudly here than run a turn
   * whose every callback 403s.
   */
  callbackToken: z.string().min(1),
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
  /**
   * Prior turns, oldest→newest. Each item's role tells the model who spoke;
   * `sequence` (base-10) is the message's clear stream sequence, which the
   * enclave uses to advance the rolling summary cursor over folded messages
   * (C-2). MUST be declared — Zod strips unknown keys, and a missing sequence
   * would silently break the cursor.
   */
  history: z
    .array(sealedMessageSchema.extend({ role: z.enum(["user", "assistant"]), sequence: z.string().regex(/^\d+$/) }))
    .max(MAX_HISTORY_MESSAGES),
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
  /**
   * Per-stream tool-privacy policy. MUST be in the schema: Zod strips unknown
   * keys, so omitting it here silently drops the policy and the enclave runs its
   * full web surface regardless of the stream's setting. Optional → unrestricted.
   */
  allowedToolCategories: z.array(z.enum(TOOL_PRIVACY_CATEGORIES)).optional(),
  /**
   * Non-secret trigger metadata for the "Triggered by" CONTEXT trace step. Same
   * reason it must be declared: an unschema'd field never reaches `run-turn`, so
   * the context step would silently never render. The body is the decrypted
   * prompt, sealed enclave-side.
   */
  trigger: z
    .object({
      messageId: z.string().min(1),
      authorName: z.string(),
      authorType: z.enum(AUTHOR_TYPES),
      createdAt: z.string().min(1),
    })
    .optional(),
  /**
   * Inline ciphertext for the conversation's attachments (base64; the
   * trigger's plus recent history's), keyed by attachment id — the enclave
   * can't reach S3 (egress is backend + OpenRouter only), so the backend
   * relays the opaque bytes and the per-file keys arrive sealed inside the
   * messages. MUST be declared here: Zod strips unknown keys, and omitting
   * this is exactly how the first attachment slice shipped broken — the
   * backend sent the bytes and this parse silently deleted them, so every
   * file showed up as "unavailable".
   */
  attachmentCiphertexts: z
    .array(z.object({ attachmentId: z.string().min(1), ciphertext: z.string().min(1) }))
    .max(MAX_INLINE_ATTACHMENTS)
    .optional(),
  // Whether to auto-title this scratchpad (declared so Zod doesn't strip it —
  // the same failure mode the attachment slice hit).
  autoTitle: z.boolean().optional(),
  /**
   * Prior turns' sealed turn_digest steps (C-1), oldest→newest. MUST be
   * declared — Zod strips unknown keys, and silently dropping these would
   * just quietly bring the tool-work amnesia back. `completedAt` is clear
   * timing metadata; the digest body opens only here.
   */
  recentDigests: z
    .array(sealedMessageSchema.extend({ completedAt: z.string().min(1) }))
    .max(MAX_RECENT_DIGESTS)
    .optional(),
  /**
   * Char budget for the verbatim window (C-2). The enclave fills history
   * newest-first up to this and folds the overflow into the rolling summary.
   * MUST be declared — Zod strips unknown keys, and dropping it would silently
   * disable the budget so the enclave kept the whole window verbatim.
   */
  maxChars: z.number().int().min(1).max(MAX_WINDOW_CHARS).optional(),
  /**
   * The stream's prior sealed rolling summary (C-2): opaque ciphertext the
   * enclave opens with its SSK wrap, folds the overflow into, and re-seals.
   * Declared for the same Zod-strips-unknown reason.
   */
  priorSummary: sealedMessageSchema.optional(),
  /**
   * The prior summary's `last_summarized_sequence` (base-10) — the highest
   * sequence already folded, so the enclave only summarizes newer history.
   */
  summaryCursor: z.string().regex(/^\d+$/).optional(),
})
