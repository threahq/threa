import { AgentToolNames, type AgentToolName } from "@threa/types"

/**
 * Persona agent supersede rerun response validation config (INV-44).
 * Shared between production code and any future evals.
 */
export const SUPERSEDE_RESPONSE_VALIDATOR_MODEL_ID = "openrouter:openai/gpt-5.4-mini"
export const SUPERSEDE_RESPONSE_VALIDATOR_MAX_TOKENS = 180
export const SUPERSEDE_RESPONSE_VALIDATOR_TEMPERATURE = 0

/**
 * Turn digest (C-1) findings model for companion turns (INV-44). One cheap
 * post-turn call condensing the loop's tool work; generation bounds live with
 * the shared component (`@threa/agent-runtime` turn-digest). The enclave uses
 * its own pinned turn model instead — it has exactly one egress-approved model.
 */
export const TURN_DIGEST_MODEL_ID = "openrouter:openai/gpt-5.4-mini"

/**
 * Follow-up scheduling bounds (`schedule_follow_up` tool, roadmap 1.1).
 *
 * `DEFAULT_MAX_PENDING_FOLLOW_UPS` is the code default pending-per-stream cap,
 * re-exported from `@threa/types` where `DEFAULT_WORKSPACE_SETTINGS.maxPendingFollowUps`
 * seeds from the same number (INV-33). The workspace override is merged onto that
 * default inside `WorkspaceSettingsService.getSettings`; the follow-up service reads
 * the already-merged value (roadmap 1.4) and so does not import this constant — it
 * stays here as the named code default for the agents layer.
 *
 * `MAX_FOLLOW_UP_HORIZON_DAYS` bounds how far out a follow-up may be scheduled —
 * these are minutes-to-days "check back later" nudges, not long-horizon jobs
 * (the anti-goal behind proposed INV-64).
 */
export { DEFAULT_MAX_PENDING_FOLLOW_UPS } from "@threa/types"
export const MAX_FOLLOW_UP_HORIZON_DAYS = 30

/**
 * Prompt budgets for the persona `## Knowledge` block (persona context
 * attachments, decision 6). SERVER-ONLY — these bound how much extracted text a
 * persona's standing files inject into the system prompt and never cross the
 * wire, so they live in the agents feature config next to the prompt code
 * (INV-33/44), not in `@threa/types`.
 *
 * `PERSONA_ATTACHMENT_INLINE_FULLTEXT_MAX_CHARS`: a single file's full extracted
 * text is inlined verbatim only up to this length; a larger file degrades to its
 * (short) extraction summary so one big upload can't dominate the prompt.
 *
 * `PERSONA_ATTACHMENT_BLOCK_MAX_CHARS`: the whole block's budget across all
 * files. The file that crosses it is truncated with an explicit `…[truncated]`
 * marker and later files degrade to summary-only — a file is never silently
 * dropped (the persona should know what it can't fully see).
 */
export const PERSONA_ATTACHMENT_INLINE_FULLTEXT_MAX_CHARS = 8_000
export const PERSONA_ATTACHMENT_BLOCK_MAX_CHARS = 24_000

/**
 * Tools stripped from a `draft_test` turn (persona editor test-drive, roadmap
 * 7.1). A test chat runs the candidate persona verbatim so the admin judges its
 * real behavior — but its scratchpad is ephemeral (archived on discard, memory
 * off), so a tool that writes durable state OUTSIDE that scratchpad would
 * outlive the test and leak into the workspace. Those are excluded; everything
 * else the persona has stays.
 *
 * Checked against the full `AGENT_TOOL_NAMES` catalog (packages/types constants):
 * - Excluded — durable writes beyond the test chat:
 *   `schedule_follow_up` / `cancel_follow_up` / `update_follow_up` mutate
 *   `agent_follow_ups` + the queue (a scheduled wake-up would fire after the test
 *   is over); `update_stream_brief` persists a brief; `delegate_task` creates a
 *   `delegated_tasks` row and hands work to the user's real local agent;
 *   `save_memo` writes a GAM memo (memory_mode off stops auto-capture, this stops
 *   the explicit tool write).
 * - Kept — read-only or in-stream-only, so effects die with the scratchpad:
 *   `send_message` / `react_to_message` (the point of the test chat);
 *   `list_follow_ups` / `describe_memo` (reads); all web/search/attachment tools
 *   (`web_search`, `read_url`, `general_research`, `search_messages`,
 *   `search_streams`, `search_users`, `get_stream_messages`, `search_attachments`,
 *   `read_attachment`); all GitHub + Linear tools (read-only queries).
 */
export const DRAFT_TEST_EXCLUDED_TOOLS: ReadonlySet<AgentToolName> = new Set<AgentToolName>([
  AgentToolNames.SCHEDULE_FOLLOW_UP,
  AgentToolNames.CANCEL_FOLLOW_UP,
  AgentToolNames.UPDATE_FOLLOW_UP,
  AgentToolNames.UPDATE_STREAM_BRIEF,
  AgentToolNames.DELEGATE_TASK,
  AgentToolNames.SAVE_MEMO,
  // Writes the tester's REAL preferences, which outlive the ephemeral test
  // stream — the same reason every other entry is here. Every tier-2 tool
  // belongs in this set by definition (tier 2 means durable state outside the
  // stream); `config.test.ts` asserts that so the next one cannot be forgotten.
  AgentToolNames.UPDATE_USER_SETTINGS,
])

/**
 * Strip {@link DRAFT_TEST_EXCLUDED_TOOLS} from a resolved persona's
 * `enabledTools` for a draft-test turn. `null` (no explicit tool set) passes
 * through unchanged.
 */
export function stripDraftTestExcludedTools(enabledTools: string[] | null): string[] | null {
  if (enabledTools === null) return null
  return enabledTools.filter((tool) => !DRAFT_TEST_EXCLUDED_TOOLS.has(tool as AgentToolName))
}
