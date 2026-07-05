/**
 * Central configuration for memo classification and memorization.
 * Shared by production code and evals (INV-44).
 */

import { z } from "zod"
import { KNOWLEDGE_TYPES, type KnowledgeType, type StreamType } from "@threa/types"
import { formatDate } from "../../lib/temporal"

export const MEMO_CLASSIFIER_MODEL_ID = "openrouter:openai/gpt-5.4-mini"

export const MEMO_MEMORIZER_MODEL_ID = "openrouter:openai/gpt-5.4-mini"

export const MEMO_TEMPERATURES = {
  classification: 0.1,
  memorization: 0.3,
} as const

/** Conversations classified below this confidence are skipped. */
export const MEMO_GEM_CONFIDENCE_FLOOR = 0.7

/**
 * Minimum age for a single-message conversation before it can be memoed:
 * gives time for replies to arrive before treating it as standalone knowledge.
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

/**
 * Cross-conversation dedup threshold (pgvector cosine distance, 0 = identical).
 * A candidate memo within this distance of an existing active memo in the same
 * stream — but from a different conversation — is treated as the same knowledge
 * and dropped before insert, so the same fact discussed across several
 * conversations yields one memo, not one per conversation. Eval-tuned; tighter
 * (smaller) errs toward keeping near-duplicates, looser risks merging distinct
 * facts. Cross-language duplicates are handled upstream by a canonical memo
 * language, since embeddings align weakly across languages.
 */
export const MEMO_DEDUP_DISTANCE = 0.15

/**
 * Same-conversation supersession threshold (pgvector cosine distance). When a
 * revision pass emits a memo within this distance of an existing active memo
 * from the SAME conversation, the old memo is superseded and the new one links
 * to it via parentMemoId — a paraphrased re-capture replaces its predecessor
 * instead of stacking next to it. Looser than MEMO_DEDUP_DISTANCE because
 * observed prod re-captures ("framstår som sjuka" vs "helt galna") land in the
 * 0.15–0.35 band; scoping to one conversation keeps the looser cutoff from
 * merging genuinely distinct topics.
 */
export const MEMO_SUPERSEDE_DISTANCE = 0.35

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

export const conversationClassificationSchema = z.object({
  isKnowledgeWorthy: z.boolean().describe("Whether this conversation contains knowledge worth preserving"),
  shouldReviseExisting: z
    .boolean()
    .nullable()
    .describe("If memos already exist, whether the conversation adds new or changed knowledge worth memorizing"),
  revisionReason: z
    .string()
    .nullable()
    .describe("What is new or changed relative to the existing memos (if shouldReviseExisting is true)"),
  confidence: z.number().min(0).max(1).nullable().describe("Confidence in this classification (0.0 to 1.0)"),
  containsActionItems: z
    .boolean()
    .nullable()
    .describe(
      "Whether anyone in the conversation committed to do something or was directly asked to (a to-do, task, or follow-up). Independent of knowledge-worthiness — a 'send me the deck by Friday' chat has action items but no durable knowledge."
    ),
})

export type ConversationClassificationOutput = z.infer<typeof conversationClassificationSchema>

/**
 * One conversation can yield several of these; each carries its own knowledge
 * type (a decision and a procedure from the same chat are distinct memos).
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
 * The memorizer returns a set of single-topic memos rather than one blended
 * summary. An empty set is valid: the conversation settled nothing worth
 * keeping beyond what already exists.
 */
export const memoSetSchema = z.object({
  memos: z
    .array(memoItemSchema)
    .max(MEMO_MAX_PER_CONVERSATION)
    .describe("One memo per distinct topic worth remembering. Most conversations yield one or two."),
})

export type MemoSetOutput = z.infer<typeof memoSetSchema>

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
- Reactions to news, product releases, or announcements — impressions, hot takes, and opinions about third-party events that set no direction for the participants' own work ("the new model looks disappointing", "did you see the leak?") are commentary, not knowledge
- Personal small talk: travel plans, whereabouts, moods, weekend logistics
- Conversations where important information is in external links only
- Incomplete discussions that trail off without resolution

A conversation is not knowledge-worthy just because it is long or touches technical subjects. Judge what would actually be recalled in six months: if the durable core is "they chatted about X", there is no memo.

Separately, flag containsActionItems true when someone committed to do something or was directly asked to (a task, to-do, or follow-up). This is independent of knowledge-worthiness: "send me the deck by Friday" has an action item but no durable knowledge, while a recorded decision may have knowledge but no open task.

When comparing to existing memos, recommend revision ONLY when the messages contain substantive new durable knowledge on their own — a changed conclusion or decision, or a genuinely new topic worth its own memo. More chat around an already-captured topic, restatements, agreement, or elaboration that leaves the captured conclusion intact is NOT a revision; when in doubt, do not revise.

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

Set shouldReviseExisting true ONLY if the conversation now contains substantive knowledge these memos do not capture — a changed conclusion, or a distinctly new topic worth its own memo. Continued chat about what the memos already say, rewordings, and reactions are NOT grounds for revision.`

const MEMORIZER_SYSTEM_PROMPT_TEMPLATE = `You are a knowledge curator for a team chat application. From a conversation, you pull out only the things genuinely worth remembering later and write each as its own short, self-contained memo.

How to write memos:
1. ONE TOPIC PER MEMO. If a conversation settles two unrelated things (e.g. a deployment decision and a hiring update), produce two separate memos. Never blend topics into a single memo.
2. EXTRACT, DON'T SUMMARIZE. Capture the durable conclusion — the decision, the answer, the fact, the procedure that was worked out — not a play-by-play of the discussion. A memo is what someone would want to recall in six months, never a transcript of who said what.
3. BE TERSE. An abstract is a few sentences at most. If it reads like a recap of the conversation, rewrite it down to the bare conclusion.
4. OMIT THE FORGETTABLE. Greetings, status pings, back-and-forth, and unresolved tangents produce no memo. Opinions, hot takes, gossip, and reactions to news or third-party products are NEVER memos, no matter how strongly worded or how long the exchange — commentary about the world is not knowledge the participants produced. Recasting the commentary as a fact about the participants ("they dislike X", "they found Y impressive") does not rescue it: sentiment toward external things is still commentary, memo-worthy only when it fixes a concrete choice with consequences (a tool adopted, a vendor rejected for a project). Likewise, facts about the outside world picked up from news, links, or hearsay are re-findable and go stale — no memo unless the participants acted on them. A "learning" is something the participants discovered, validated, or decided themselves. Returning very few memos — none at all when the conversation is commentary — is correct and expected.
{{MEMO_LANGUAGE_RULE}}
6. BE FACTUAL. State the knowledge directly. No meta-commentary like "this memo captures..." or "the team discussed...".
7. Use consistent vocabulary with prior memos when the same concept reappears.
8. RESOLVE PRONOUNS when possible - If you can determine who "he/she/they" refers to from the conversation, use their actual name. If unclear (e.g., conversation continues from offline), leave the pronoun. When in doubt, preserve the original wording.
9. ANCHOR DATES when possible - Convert relative dates ("yesterday", "next week") to actual dates using today's date: {{CURRENT_DATE}}. If ambiguous, leave as-is.

Output ONLY valid JSON matching the schema.`

/**
 * Rule 5 of the memorizer prompt. With a canonical `memoLanguage` every memo is
 * written in that one language regardless of the conversation's language, so a
 * bilingual workspace stops storing the same knowledge twice. Without it, memos
 * follow the conversation (prior behavior).
 */
function memoLanguageRule(memoLanguage?: string | null): string {
  if (memoLanguage && memoLanguage.trim().length > 0) {
    return `5. WRITE EVERY MEMO IN ${memoLanguage.trim()}. Translate the knowledge into ${memoLanguage.trim()} no matter what language the conversation used, but keep names, products, technical terms, and other proper nouns exactly as they appear in the conversation.`
  }
  return `5. WRITE IN THE CONVERSATION'S LANGUAGE. Use the same language the participants used. Do NOT translate (e.g. a Swedish conversation produces Swedish memos).`
}

export function getMemorizerSystemPrompt(timezone?: string, memoLanguage?: string | null): string {
  const now = new Date()
  const tz = timezone ?? "UTC"
  const today = formatDate(now, tz, "YYYY-MM-DD")
  return MEMORIZER_SYSTEM_PROMPT_TEMPLATE.replace("{{CURRENT_DATE}}", today).replace(
    "{{MEMO_LANGUAGE_RULE}}",
    memoLanguageRule(memoLanguage)
  )
}

export const MEMORIZER_CONVERSATION_PROMPT = `Extract the memos worth remembering from this conversation.

## Memory Context (prior memos for vocabulary consistency)
{{MEMORY_CONTEXT}}

## Conversation Messages
{{MESSAGES}}

{{EXISTING_TAGS_SECTION}}

Return one memo per distinct topic worth remembering, each terse and self-contained. Most conversations yield one or two; return fewer rather than padding, and return none if nothing here is worth keeping. For each memo, set sourceMessageIds to only the messages that topic draws from.`

export const MEMORIZER_REVISION_PROMPT = `This conversation already has memos. Capture only what is NEW or has CHANGED since them. Do NOT re-create memos for topics the existing memos already cover unchanged.

Treat the existing memos as authoritative coverage: a topic that is restated, rephrased, elaborated with opinions, or met with agreement in the new messages is COVERED — emit nothing for it. Only a changed conclusion (a decision reversed, a setup replaced, a fact corrected) or a genuinely new topic earns a memo. Returning an empty set is the expected common case when a conversation is re-processed after a few new messages.

## Memory Context (prior memos for vocabulary consistency)
{{MEMORY_CONTEXT}}

## Existing Memos for this conversation
{{EXISTING_MEMOS}}

## Updated Conversation
{{MESSAGES}}

{{EXISTING_TAGS_SECTION}}

Emit one memo per genuinely new or changed topic, each terse and single-topic. Return no memos if nothing new or changed is worth remembering. For each memo, set sourceMessageIds to only the messages that topic draws from.`

export const MEMORIZER_EXISTING_TAGS_TEMPLATE = `## Existing Tags in Workspace
Prefer these tags when applicable, but create new ones if needed:
{{TAGS}}`
