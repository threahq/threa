/**
 * General researcher configuration.
 *
 * Co-located config (INV-43/INV-44): production and any eval/test entry points
 * import the same budgets, model, and tool policy from here.
 *
 * The general researcher is a bounded tool-calling sub-agent. Unlike the
 * workspace researcher (`WorkspaceAgent`, fixed plan→execute→evaluate over
 * workspace DB search), it drives the persona's primitive tools — web search,
 * URL reads, the workspace search primitives, and connected integrations
 * (GitHub, Linear) — in a multi-step loop, then synthesises a cited brief.
 * It is intentionally NOT a deep researcher: it answers in ~2 minutes.
 */

import { AgentToolNames, type AgentToolName } from "@threa/types"

// Prompt + budgets are the runtime-agnostic source of truth and live in the
// shared package so the enclave runs the identical loop (INV-33). Re-exported
// here so existing backend importers keep their `./config` import path.
export {
  GENERAL_RESEARCH_TEMPERATURE,
  GENERAL_RESEARCH_MAX_ITERATIONS,
  GENERAL_RESEARCH_TOTAL_BUDGET_MS,
  GENERAL_RESEARCH_MAX_BRIEF_CHARS,
  GENERAL_RESEARCH_SYSTEM_PROMPT,
} from "@threa/agent-runtime"

/**
 * Model for the general research loop. Sonnet (the companion's own model) is
 * the right tier here: the loop is orchestration-heavy (decide which surface to
 * query, read results, decide whether to dig further, synthesise) and benefits
 * from stronger tool-use and synthesis than the Haiku tier the workspace
 * researcher uses for its narrower structured planning.
 */
export const GENERAL_RESEARCH_MODEL_ID = "openrouter:anthropic/claude-sonnet-4.6"

/**
 * Fixed tool policy for the research sub-agent. Gated only by dependency
 * availability (workspace access scope, connected integrations, web key) — NOT
 * by the invoking persona's `enabledTools`. The persona's `general_research`
 * enablement is the gate; once a persona can research, it researches across
 * whatever surfaces the workspace actually has.
 *
 * Deliberately excludes:
 * - `workspace_research` — the sub-agent uses the workspace search PRIMITIVES
 *   directly rather than nesting another sub-agent (no researcher-in-researcher).
 * - `send_message` — the runtime always provides it; the final brief is the
 *   captured send_message content.
 * - attachment/vision loaders — out of scope for a text research brief.
 *
 * This is an explicit allowlist (typed `AgentToolName[]`, so a typo or removed
 * tool fails to compile). When a new research-capable PRIMITIVE tool is added to
 * the persona catalog, extend this list to expose it to the researcher — the
 * safe default is omission (the researcher simply lacks that capability), never
 * accidental inclusion of `send_message`/research tools that would recurse.
 */
export const GENERAL_RESEARCH_TOOL_POLICY: AgentToolName[] = [
  AgentToolNames.WEB_SEARCH,
  AgentToolNames.READ_URL,
  AgentToolNames.SEARCH_MESSAGES,
  AgentToolNames.SEARCH_STREAMS,
  AgentToolNames.SEARCH_USERS,
  AgentToolNames.GET_STREAM_MESSAGES,
  AgentToolNames.SEARCH_ATTACHMENTS,
  AgentToolNames.DESCRIBE_MEMO,
  AgentToolNames.GITHUB_LIST_REPOS,
  AgentToolNames.GITHUB_LIST_BRANCHES,
  AgentToolNames.GITHUB_LIST_COMMITS,
  AgentToolNames.GITHUB_GET_COMMIT,
  AgentToolNames.GITHUB_LIST_PULL_REQUESTS,
  AgentToolNames.GITHUB_GET_PULL_REQUEST,
  AgentToolNames.GITHUB_LIST_PR_FILES,
  AgentToolNames.GITHUB_GET_FILE_CONTENTS,
  AgentToolNames.GITHUB_SEARCH_CODE,
  AgentToolNames.GITHUB_LIST_WORKFLOW_RUNS,
  AgentToolNames.GITHUB_GET_WORKFLOW_RUN,
  AgentToolNames.GITHUB_LIST_RELEASES,
  AgentToolNames.GITHUB_GET_RELEASE,
  AgentToolNames.GITHUB_SEARCH_ISSUES,
  AgentToolNames.GITHUB_GET_ISSUE,
  AgentToolNames.LINEAR_LIST_ISSUES,
  AgentToolNames.LINEAR_GET_ISSUE,
  AgentToolNames.LINEAR_LIST_PROJECTS,
  AgentToolNames.LINEAR_GET_PROJECT,
]
