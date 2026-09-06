import type { Querier } from "../../db"
import { StreamTypes } from "@threahq/types"
import type { Stream } from "../streams"
import { MessageRepository } from "../messaging"
import { AgentSessionRepository } from "./session-repository"

/**
 * Builder fallback window size: the newest-N messages a context build hydrates
 * for callers that build context OUTSIDE a turn and pass no policy — evals and
 * the regional enclave-prompt assembly (`enclave-system-prompt.ts`). Turn-driven
 * companion builds resolve a `ContextWindowPolicy` instead, whose deeper
 * candidate ceiling + char budget (below) govern the window. This stays at the
 * pre-C-2b value so widening the companion window can't silently deepen those
 * out-of-turn callers' fetches.
 */
export const DEFAULT_CONTEXT_WINDOW_MESSAGES = 20

/**
 * Candidate fetch ceiling for a turn's budgeted window (C-2b). The char budget
 * below is the intended limiter; this caps how many messages are ever fetched
 * before the newest-first char trim, bounding fetch volume on a long stream. It
 * is also the DM episode boundary's recency horizon: a turn continues the prior
 * episode iff that session's cursor still falls inside this window (agent-runtimes
 * §2.8 Q8 — "only a gap that clears the whole window starts fresh"; the boundary
 * tracks the window's deepest extent, biasing toward continue).
 */
export const CONTEXT_WINDOW_CANDIDATE_CEILING = 200

/**
 * Char budget for a turn's verbatim conversation window (C-2b). Replaces the
 * message-count cliff with a newest-first fill under this budget; older turns
 * that fall out fold into the rolling conversation summary (which keys off the
 * oldest kept message, so the fold composes automatically). Expressed in chars
 * to reuse the project's ~4-chars-per-token heuristic with no model-specific
 * tokenizer — the same unit `MAX_MESSAGE_CHARS` (the 400k AgentRuntime safety
 * clamp) uses. This is the intended window limiter and sits well under that
 * clamp, leaving room for the system prompt, tools, digests, and the summary.
 * The budget is measured on raw message markdown at the fetch layer, before
 * quote / shared-message / attachment enrichment inflates it; the 400k clamp is
 * the backstop for that enrichment.
 */
export const DEFAULT_CONTEXT_WINDOW_CHARS = 80_000

/**
 * Which conversation episode a turn belongs to. Bounded surfaces (scratchpads,
 * threads, channel-spawned threads) are one continuous episode; a DM is an
 * unbounded surface whose episode boundary is recency.
 */
export type ContextEpisode = { kind: "stream" } | { kind: "dm-recency"; continues: boolean }

/**
 * The hydration policy for a single turn, resolved once at the dispatch
 * (`Hydrate`) seam and handed to the context build — never chosen inside it
 * (agent-runtimes §2.5 / §2.8 Q7). It fixes the window budget and whether the
 * prior turn digests (C-1) carry into this turn.
 */
export interface ContextWindowPolicy {
  episode: ContextEpisode
  /**
   * Candidate fetch ceiling for the window: the most messages a build fetches
   * before the newest-first char trim. Also the DM episode boundary's recency
   * horizon (see `CONTEXT_WINDOW_CANDIDATE_CEILING`).
   */
  maxMessages: number
  /** Char budget the verbatim window is filled up to, newest-first (C-2b). */
  maxChars: number
  /** Whether prior `turn_digest` steps inject as "Prior Tool Work" this turn. */
  carryDigests: boolean
}

export interface ResolveContextWindowPolicyParams {
  stream: Stream
  /** Override the candidate fetch ceiling (tests pin a small budget). */
  maxMessages?: number
  /** Override the char budget (tests pin a small budget). */
  maxChars?: number
}

/**
 * Resolve the per-turn context window policy.
 *
 * Bounded surfaces are a single continuous episode: digests always carry (Q7).
 *
 * A DM is unbounded, so its episode boundary is recency anchored on the
 * SEQUENTIAL window — not the async `conversations` segmenter (agent-runtimes
 * §2.8 Q8). The window is always the reliable, non-blocking base; the prior
 * completed session's `lastSeenSequence` decides continuity: continue the
 * episode — carrying its digest chain — only while that cursor still falls
 * inside the window about to be built. The boundary uses the candidate ceiling
 * (`maxMessages`), the window's deepest extent, not the narrower char-budgeted
 * fill — "only a gap that clears the whole window starts fresh" (Q8), so the
 * boundary tracks the widest the window could reach. A gap larger than that
 * starts a fresh episode with no digest carry-over. Anchoring on the sequence
 * (rather than on conversation identity) is deliberate: it can never revive a
 * weeks-old session, and it errs toward continuing — the costlier mistake is a
 * false fresh that drops context the user expected the agent to hold (Q8 error
 * asymmetry).
 */
export async function resolveContextWindowPolicy(
  db: Querier,
  params: ResolveContextWindowPolicyParams
): Promise<ContextWindowPolicy> {
  // A window always holds at least the triggering message; clamp so a
  // degenerate budget can't make `findWindowFloorSequence` return null
  // (→ "whole stream fits in window" → continue) for what is really an empty
  // window.
  const maxMessages = Math.max(1, params.maxMessages ?? CONTEXT_WINDOW_CANDIDATE_CEILING)
  const maxChars = Math.max(1, params.maxChars ?? DEFAULT_CONTEXT_WINDOW_CHARS)

  if (params.stream.type !== StreamTypes.DM) {
    return { episode: { kind: "stream" }, maxMessages, maxChars, carryDigests: true }
  }

  const priorSession = await AgentSessionRepository.findLatestCompletedByStream(db, params.stream.id)

  // No prior completed session → there are no digests to carry; start fresh.
  if (!priorSession || priorSession.lastSeenSequence === null) {
    return { episode: { kind: "dm-recency", continues: false }, maxMessages, maxChars, carryDigests: false }
  }

  const windowFloor = await MessageRepository.findWindowFloorSequence(db, params.stream.id, maxMessages)
  // `null` floor → the stream has fewer than `maxMessages` messages, so the
  // window covers everything and any prior cursor is inside it (continue).
  const continues = windowFloor === null || priorSession.lastSeenSequence >= windowFloor

  return { episode: { kind: "dm-recency", continues }, maxMessages, maxChars, carryDigests: continues }
}
