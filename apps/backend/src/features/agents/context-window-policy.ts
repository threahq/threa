import type { Querier } from "../../db"
import { StreamTypes } from "@threa/types"
import type { Stream } from "../streams"
import { MessageRepository } from "../messaging"
import { AgentSessionRepository } from "./session-repository"

/**
 * Default budgeted-window size: the newest-N messages a context build hydrates.
 * C-2a keeps the message-count budget; C-2b swaps the count for a token budget
 * (the `truncateMessages` newest-first fill) without changing this seam.
 */
export const DEFAULT_CONTEXT_WINDOW_MESSAGES = 20

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
  /** Newest-first message budget for the window. */
  maxMessages: number
  /** Whether prior `turn_digest` steps inject as "Prior Tool Work" this turn. */
  carryDigests: boolean
}

export interface ResolveContextWindowPolicyParams {
  stream: Stream
  /** Override the default window budget (tests pin a small budget). */
  maxMessages?: number
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
 * inside the window about to be built. A gap larger than the window starts a
 * fresh episode with no digest carry-over. Anchoring on the sequence (rather
 * than on conversation identity) is deliberate: it can never revive a
 * weeks-old session, and it errs toward continuing — the costlier mistake is a
 * false fresh that drops context the user expected the agent to hold (Q8 error
 * asymmetry).
 */
export async function resolveContextWindowPolicy(
  db: Querier,
  params: ResolveContextWindowPolicyParams
): Promise<ContextWindowPolicy> {
  const maxMessages = params.maxMessages ?? DEFAULT_CONTEXT_WINDOW_MESSAGES

  if (params.stream.type !== StreamTypes.DM) {
    return { episode: { kind: "stream" }, maxMessages, carryDigests: true }
  }

  const priorSession = await AgentSessionRepository.findLatestCompletedByStream(db, params.stream.id)

  // No prior completed session → there are no digests to carry; start fresh.
  if (!priorSession || priorSession.lastSeenSequence === null) {
    return { episode: { kind: "dm-recency", continues: false }, maxMessages, carryDigests: false }
  }

  const windowFloor = await MessageRepository.findWindowFloorSequence(db, params.stream.id, maxMessages)
  // `null` floor → the stream has fewer than `maxMessages` messages, so the
  // window covers everything and any prior cursor is inside it (continue).
  const continues = windowFloor === null || priorSession.lastSeenSequence >= windowFloor

  return { episode: { kind: "dm-recency", continues }, maxMessages, carryDigests: continues }
}
