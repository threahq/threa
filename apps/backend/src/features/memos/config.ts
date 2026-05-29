/**
 * Memo AI Configuration
 *
 * Central configuration for memo classification and memorization.
 * Used by both production code and evals to ensure consistency.
 */

import { z } from "zod"
import { KNOWLEDGE_TYPES, type KnowledgeType, type StreamType } from "@threa/types"
import { formatDate } from "../../lib/temporal"

// ============================================================================
// Model Configuration
// ============================================================================

/**
 * Model for memo classification (gem detection).
 *
 * GPT-5.4 Nano is OpenAI's cheapest 5.4-generation model ($0.20/$1.25 per 1M tokens),
 * explicitly designed for classification, data extraction, and ranking.
 * Outperforms GPT-5 Mini on benchmarks despite lower cost.
 * Previously used gpt-oss-120b whose patchwork OpenRouter provider backing
 * caused 60-120s tail latency and low-quality gem decisions.
 */
export const MEMO_CLASSIFIER_MODEL_ID = "openrouter:openai/gpt-5.4-nano"

/**
 * Model for memo content generation (abstractive extraction).
 *
 * GPT-5.4 Nano provides strong structured output and extraction quality
 * at a fraction of the cost of larger models. If memo abstract quality
 * proves insufficient, upgrade to gpt-5.4-mini ($0.75/$4.50 per 1M tokens).
 */
export const MEMO_MEMORIZER_MODEL_ID = "openrouter:openai/gpt-5.4-nano"

/**
 * Temperature settings for different operations.
 */
export const MEMO_TEMPERATURES = {
  classification: 0.1, // Low temperature for consistent classification
  memorization: 0.3, // Slightly higher for creative summarization
} as const

/**
 * Minimum classifier confidence required to create a memo.
 * Conversations classified with confidence below this threshold are skipped.
 */
export const MEMO_GEM_CONFIDENCE_FLOOR = 0.7

/**
 * Minimum age (ms) for a single-message conversation before it can be memoed.
 * Gives time for replies to arrive before treating the message as standalone knowledge.
 * Deferred items are retried on the next batch cycle (5-minute cap interval).
 */
export const MEMO_SINGLE_MESSAGE_AGE_GATE_MS = 10 * 60 * 1000

/**
 * Upper bound on memos extracted from a single conversation. A conversation can
 * settle several unrelated things, but a runaway count usually means the model is
 * transcribing turns instead of extracting durable knowledge — the cap keeps the
 * memorizer honest. Most conversations yield one or two.
 */
export const MEMO_MAX_PER_CONVERSATION = 5

// ============================================================================
// Retrieval Configuration (gbrain B2 / B3 / B7)
// ============================================================================

/**
 * B2 structural boost. A multiplicative factor on the fused RRF score,
 * applied in the *outer* stage of hybrid search (after the inner
 * access-scoped scan — never before it, §3.1). The factor is structural
 * (knowledge/stream type), not editorial, and is the single source of
 * truth for the SQL `CASE` (INV-33). Temporal-intent queries bypass the
 * boost so recency still surfaces recent chatter (B4 escape hatch).
 *
 * Decisions/procedures are durable knowledge and rank above incidental
 * context; system streams are de-emphasised vs. human channels.
 */
export const MEMO_KNOWLEDGE_TYPE_BOOST: Record<KnowledgeType, number> = {
  decision: 1.3,
  procedure: 1.2,
  reference: 1.1,
  learning: 1.05,
  context: 1.0,
}

export const MEMO_STREAM_TYPE_BOOST: Record<StreamType, number> = {
  channel: 1.1,
  scratchpad: 1.05,
  dm: 1.0,
  thread: 1.0,
  system: 0.9,
}

/** Neutral factor for any type not present in the maps above. */
export const MEMO_BOOST_DEFAULT = 1.0

/**
 * B3 reranker. GPT-5.4 Nano is the model-reference primary target for
 * ranking (INV-16); rerank is a best-effort enhancer only — fixed
 * timeout, fail-open on every failure reason, never a dependency.
 */
export const MEMO_RERANKER_MODEL_ID = "openrouter:openai/gpt-5.4-nano"
export const MEMO_RERANKER_TEMPERATURE = 0
export const MEMO_RERANKER_TIMEOUT_MS = 4000
/** Top-K window handed to the reranker; the un-reranked tail is appended (recall protection). */
export const MEMO_RERANKER_CANDIDATE_LIMIT = 20

export const memoRerankSchema = z.object({
  /** Candidate indices (0-based, into the input list) in descending relevance. */
  order: z.array(z.number().int().nonnegative()),
})

export type MemoRerankResult = z.infer<typeof memoRerankSchema>

/**
 * B7 search-mode bundles: correlated retrieval knobs behind one key.
 *
 * NOTE: gbrain ties these to a billing plan (free/pro/max) and adds a
 * scope-keyed shared query cache. Threa has neither a billing-plan model
 * nor a cache layer today, so this ships the prerequisite-free part — the
 * knob bundle with a single default mode — structured so a plan→mode map
 * and a §3.5 scope-keyed cache can be layered on without reshaping callers.
 */
export interface MemoSearchModeConfig {
  /** Final result count returned to the caller. */
  limit: number
  /** Candidate pool size pulled from hybrid search before rerank/trim. */
  candidatePoolSize: number
  /** Whether the fail-open reranker runs for this mode. */
  rerank: boolean
}

export const MEMO_SEARCH_MODES = {
  fast: { limit: 30, candidatePoolSize: 30, rerank: false },
  balanced: { limit: 30, candidatePoolSize: 50, rerank: true },
  thorough: { limit: 50, candidatePoolSize: 80, rerank: true },
} as const satisfies Record<string, MemoSearchModeConfig>

export type MemoSearchMode = keyof typeof MEMO_SEARCH_MODES

export const DEFAULT_MEMO_SEARCH_MODE: MemoSearchMode = "balanced"

export function resolveMemoSearchMode(mode: MemoSearchMode = DEFAULT_MEMO_SEARCH_MODE): MemoSearchModeConfig {
  return MEMO_SEARCH_MODES[mode]
}

// ============================================================================
// Schemas
// ============================================================================

/**
 * Schema for conversation classification output.
 */
export const conversationClassificationSchema = z.object({
  isKnowledgeWorthy: z.boolean().describe("Whether this conversation contains knowledge worth preserving"),
  knowledgeType: z
    .enum(KNOWLEDGE_TYPES)
    .nullable()
    .describe(`Primary type of knowledge if worthy: ${KNOWLEDGE_TYPES.map((t) => `"${t}"`).join(" | ")}`),
  shouldReviseExisting: z.boolean().nullable().describe("If a memo exists, whether it should be revised"),
  revisionReason: z
    .string()
    .nullable()
    .describe("Why the existing memo should be revised (if shouldReviseExisting is true)"),
  confidence: z.number().min(0).max(1).nullable().describe("Confidence in this classification (0.0 to 1.0)"),
})

export type ConversationClassificationOutput = z.infer<typeof conversationClassificationSchema>

/**
 * Schema for a single single-topic memo. One conversation can yield several of
 * these; each captures exactly one thing worth remembering and carries its own
 * knowledge type (a decision and a procedure from the same chat are distinct memos).
 */
export const memoItemSchema = z.object({
  title: z.string().max(100).describe("Specific title naming this one topic (max 100 characters)"),
  abstract: z
    .string()
    .describe(
      "Terse, self-contained statement of the knowledge — a few sentences at most, no turn-by-turn narration of the discussion"
    ),
  knowledgeType: z
    .enum(KNOWLEDGE_TYPES)
    .describe(`Type of knowledge this memo captures: ${KNOWLEDGE_TYPES.map((t) => `"${t}"`).join(" | ")}`),
  keyPoints: z
    .array(z.string())
    .max(3)
    .describe("Up to 3 supporting facts; leave empty when the abstract already stands alone"),
  tags: z.array(z.string()).max(5).describe("Up to 5 relevant tags for categorization"),
  sourceMessageIds: z.array(z.string()).describe("IDs of the messages this specific memo draws from"),
})

export type MemoItemOutput = z.infer<typeof memoItemSchema>

/**
 * Schema for memo content generation. The memorizer returns a set of single-topic
 * memos rather than one blended summary, so a multi-topic conversation produces
 * several small memos. An empty set is valid: the conversation settled nothing
 * worth keeping beyond what already exists.
 */
export const memoSetSchema = z.object({
  memos: z
    .array(memoItemSchema)
    .max(MEMO_MAX_PER_CONVERSATION)
    .describe("One memo per distinct topic worth remembering. Most conversations yield one or two."),
})

export type MemoSetOutput = z.infer<typeof memoSetSchema>

// ============================================================================
// Classifier Prompts
// ============================================================================

export const CLASSIFIER_CONVERSATION_SYSTEM_PROMPT = `You are a knowledge classifier for a team chat application. You identify conversations that contain valuable knowledge worth preserving in organizational memory.

Knowledge-worthy conversations:
- Document decisions with context and rationale
- Capture procedures or processes that were worked out
- Record learnings from debugging, incidents, or experiments
- Establish context about why things are the way they are
- Contain reference information that will be useful later

NOT knowledge-worthy:
- Pure social chat or banter
- Brief status exchanges
- Conversations where important information is in external links only
- Incomplete discussions that trail off without resolution

When comparing to an existing memo, recommend revision if:
- Significant new information was added
- The conclusion or decision changed
- New participants brought important perspectives
- The topic evolved substantially

Output ONLY valid JSON matching the schema. Keep reasoning to ONE brief sentence.`

export const CLASSIFIER_CONVERSATION_PROMPT = `Classify this conversation. Is it worth preserving in organizational memory?

## Conversation
Topic: {{TOPIC}}
Participants: {{PARTICIPANTS}}
Message count: {{MESSAGE_COUNT}}

## Messages
{{MESSAGES}}

{{EXISTING_MEMO_SECTION}}`

export const CLASSIFIER_EXISTING_MEMO_TEMPLATE = `## Existing Memos for this conversation
{{MEMOS}}

Should this conversation's memos be regenerated based on the conversation above — e.g. new information was added, a conclusion changed, or a new topic emerged?`

// ============================================================================
// Memorizer Prompts
// ============================================================================

const MEMORIZER_SYSTEM_PROMPT_TEMPLATE = `You are a knowledge curator for a team chat application. From a conversation, you pull out only the things genuinely worth remembering later and write each as its own short, self-contained memo.

How to write memos:
1. ONE TOPIC PER MEMO. If a conversation settles two unrelated things (e.g. a deployment decision and a hiring update), produce two separate memos. Never blend topics into a single memo.
2. EXTRACT, DON'T SUMMARIZE. Capture the durable conclusion — the decision, the answer, the fact, the procedure that was worked out — not a play-by-play of the discussion. A memo is what someone would want to recall in six months, never a transcript of who said what.
3. BE TERSE. An abstract is a few sentences at most. If it reads like a recap of the conversation, rewrite it down to the bare conclusion.
4. OMIT THE FORGETTABLE. Greetings, status pings, back-and-forth, and unresolved tangents produce no memo. Returning very few memos — or only the one thing that actually mattered — is correct and expected.
5. WRITE IN THE CONVERSATION'S LANGUAGE. Use the same language the participants used. Do NOT translate (e.g. a Swedish conversation produces Swedish memos).
6. BE FACTUAL. State the knowledge directly. No meta-commentary like "this memo captures..." or "the team discussed...".
7. Use consistent vocabulary with prior memos when the same concept reappears.
8. RESOLVE PRONOUNS when possible - If you can determine who "he/she/they" refers to from the conversation, use their actual name. If unclear (e.g., conversation continues from offline), leave the pronoun. When in doubt, preserve the original wording.
9. ANCHOR DATES when possible - Convert relative dates ("yesterday", "next week") to actual dates using today's date: {{CURRENT_DATE}}. If ambiguous, leave as-is.

Output ONLY valid JSON matching the schema.`

/**
 * Get the memorizer system prompt with date anchoring.
 */
export function getMemorizerSystemPrompt(timezone?: string): string {
  const now = new Date()
  const tz = timezone ?? "UTC"
  const today = formatDate(now, tz, "YYYY-MM-DD")
  return MEMORIZER_SYSTEM_PROMPT_TEMPLATE.replace("{{CURRENT_DATE}}", today)
}

export const MEMORIZER_CONVERSATION_PROMPT = `Extract the memos worth remembering from this conversation.

## Memory Context (prior memos for vocabulary consistency)
{{MEMORY_CONTEXT}}

## Conversation Messages
{{MESSAGES}}

{{EXISTING_TAGS_SECTION}}

Return one memo per distinct topic worth remembering, each terse and self-contained. Most conversations yield one or two; return fewer rather than padding, and return none if nothing here is worth keeping. For each memo, set sourceMessageIds to only the messages that topic draws from.`

export const MEMORIZER_REVISION_PROMPT = `This conversation already has memos but has gained new content. Regenerate the complete set of memos for it from scratch, using the existing memos only to keep titles and vocabulary stable.

## Memory Context (prior memos for vocabulary consistency)
{{MEMORY_CONTEXT}}

## Existing Memos for this conversation
{{EXISTING_MEMOS}}

## Updated Conversation
{{MESSAGES}}

{{EXISTING_TAGS_SECTION}}

Produce the memos that should now represent this conversation: one per distinct topic worth remembering, each terse and self-contained. Carry forward still-valid knowledge, fold in what changed, and drop anything no longer worth keeping. For each memo, set sourceMessageIds to only the messages that topic draws from.`

export const MEMORIZER_EXISTING_TAGS_TEMPLATE = `## Existing Tags in Workspace
Prefer these tags when applicable, but create new ones if needed:
{{TAGS}}`
