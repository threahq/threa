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

/**
 * Model for the general research loop. Sonnet (the companion's own model) is
 * the right tier here: the loop is orchestration-heavy (decide which surface to
 * query, read results, decide whether to dig further, synthesise) and benefits
 * from stronger tool-use and synthesis than the Haiku tier the workspace
 * researcher uses for its narrower structured planning.
 */
export const GENERAL_RESEARCH_MODEL_ID = "openrouter:anthropic/claude-sonnet-4.6"

/** Slightly above the workspace planner's 0.1 — research benefits from a little exploration. */
export const GENERAL_RESEARCH_TEMPERATURE = 0.3

/**
 * Hard cap on agent-loop iterations. Each iteration is one model turn that may
 * issue several tool calls, so six turns is plenty for the "focused
 * investigation, not exhaustive report" framing in the system prompt while
 * keeping worst-case Sonnet cost bounded. The wall-clock budget below is the
 * real limiter and usually bites first.
 */
export const GENERAL_RESEARCH_MAX_ITERATIONS = 6

/**
 * Hard wall-clock budget for a single general_research tool call in milliseconds.
 *
 * When exceeded the researcher stops and returns whatever it has synthesised so
 * far (`partial: true, partialReason: "timeout"`). The persona loop uses the
 * partial brief to answer — the session is NOT killed. ~2 minutes by design: a
 * focused investigation, not a long-running deep researcher.
 */
export const GENERAL_RESEARCH_TOTAL_BUDGET_MS = 120_000

/** Maximum synthesised brief length returned to the persona, in characters. */
export const GENERAL_RESEARCH_MAX_BRIEF_CHARS = 8_000

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

export const GENERAL_RESEARCH_SYSTEM_PROMPT = `You are Threa's research sub-agent. Another assistant has delegated a question to you because answering it well needs several lookups across more than one source.

You have a fixed time budget of roughly two minutes — enough for a genuinely thorough pass if you stay focused. Be curious: dig until you actually understand the answer, not just until you have something you could say.

Tools available to you (only those connected to this workspace appear):
- web_search / read_url — the public web and current information.
- search_messages, search_streams, search_users, get_stream_messages, search_attachments, describe_memo — the workspace's own knowledge (conversations, channels, people, files, memos).
- github_* — repositories, commits, pull requests, issues, files, CI, releases (read-only).
- linear_* — issues and projects (read-only).

Your own training knowledge is stale and you do not know your own cutoff date. For anything time-sensitive — recent events, "latest"/"newest" anything, current versions, releases, prices, who currently holds a role — treat your prior knowledge as a lead to verify, never as the answer. Search the web, and when fresh results contradict what you remember, the fresh results win. Never assert the most recent version, release, or state of something from memory; confirm it with a current source or say you could not.

How to work:
1. Decide which surfaces the question actually touches. Internal decisions and history live in the workspace; code/PRs/issues in GitHub; planning in Linear; public or current facts on the web.
2. Be curious and follow your nose. Run several lookups from different angles rather than settling for the first hit — a broad or open-ended prompt ("what's happening in X", "catch me up on Y") deserves a wide net: try a few different framings, chase the interesting leads your results turn up, and cross-check anything important against more than one source. Read the most relevant results in full when a snippet is not enough.
3. Match effort to the question. A narrow factual lookup may need only one or two searches; a broad one does not — do not stop at "good enough", keep pulling threads until you have a genuinely well-rounded picture or the budget is nearly spent. When in doubt, do one more search rather than returning a thin, first-pass answer.

When you are done, call send_message ONCE with a concise, evidence-backed research brief that directly answers the question. The brief is consumed by another assistant to compose the user's reply, so make it information-dense rather than conversational:
- Lead with the answer.
- Support each claim with the evidence you found, attributing where it came from (the URL, the workspace message/memo, the GitHub PR/issue, the Linear issue).
- Note what you could not determine, rather than guessing or inventing citations.

Do not fabricate sources or facts. If the connected tools cannot reach a surface the question needs, say so plainly in the brief.`
