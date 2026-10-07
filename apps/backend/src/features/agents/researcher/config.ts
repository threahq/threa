/**
 * Workspace agent configuration.
 *
 * Co-located config following INV-43 - both production code and evals
 * import from here to ensure consistency.
 */

/**
 * Model for workspace agent retrieval planning.
 *
 * Chosen for fast, predictable tail latency (single reliable provider path) and
 * solid structured-output compliance. Was `claude-haiku-4.5`, on the reasoning
 * that it was "the cost-effective Anthropic tier" — haiku bills $1.00/$5.00, not
 * the $0.25/$1.25 `docs/model-reference.md` claimed, which made it the dearest
 * small model in the stack. Mini is cheaper on both axes and shares the single
 * reliable provider path that motivated the original choice; it already carries
 * the highest-volume component we run (boundary extraction, ~1k calls/month) at
 * ~2s per call.
 */
export const WORKSPACE_AGENT_MODEL_ID = "openrouter:openai/gpt-6-luna"
/** Lower temperature to reduce decision variance in retrieval planning */
export const WORKSPACE_AGENT_TEMPERATURE = 0.1

/** Upper bound on the planner's queries, so one broad pass stays a bounded fan-out */
export const WORKSPACE_AGENT_MAX_PLANNED_QUERIES = 6

/** Maximum number of memos/messages to retrieve per search */
export const WORKSPACE_AGENT_MAX_RESULTS_PER_SEARCH = 5

/** Hits per search taken from the room the question was asked in, on top of the workspace-wide ones */
export const WORKSPACE_AGENT_MAX_ROOM_RESULTS_PER_SEARCH = 3

/**
 * Hard wall-clock budget for a single workspace_research tool call in milliseconds.
 *
 * When exceeded the researcher returns whatever partial results it has accumulated
 * (`partial: true, partialReason: "timeout"`). The agent loop uses those partial
 * results to continue and produce a response — the session is NOT killed.
 */
export const WORKSPACE_AGENT_TOTAL_BUDGET_MS = 45_000

/** Per-call timeout for the planner LLM. Fails over to baseline queries on timeout. */
export const WORKSPACE_AGENT_PLANNER_TIMEOUT_MS = 20_000

/** Per-call timeout for embedding generation. */
export const WORKSPACE_AGENT_EMBED_TIMEOUT_MS = 10_000

/** Workspace agent system prompt */
export const WORKSPACE_AGENT_SYSTEM_PROMPT = `You are a workspace retrieval agent. Given a query, plan one broad set of search queries across memos, messages, and attachments. There is no second round: whatever these queries miss stays missing.

Plan up to ${WORKSPACE_AGENT_MAX_PLANNED_QUERIES} queries, each going in a different direction. Directions worth covering when the query touches them:
- the same question in other words, as people in the workspace would have phrased it
- the people, roles, or teams involved
- the specific names, identifiers, or terms at the center of it
- the wider decision, project, or topic it belongs to
- later changes to it: updates, reversals, replacements
- files or documents about it

Skip a direction that does not apply. Never send near-duplicates of the same query; a query that would return the same results as another one wastes a slot.

Guidelines:
- target "memos": summarized knowledge (decisions, context, discussions).
- target "messages": specific quotes, recent activity, exact terms.
- target "attachments": files, images, documents.
- type "semantic": concepts, topics, intent.
- type "exact": error messages, IDs, quoted phrases.

The caller has already decided that workspace retrieval is warranted. Do not second-guess the invocation — produce queries.`
