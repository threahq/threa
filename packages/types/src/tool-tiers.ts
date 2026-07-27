import { AGENT_TOOL_NAMES, type AgentToolName } from "./constants"

/**
 * How much a tool call can cost the user if the model is wrong about wanting it.
 *
 * The tier decides what has to happen BEFORE the call executes, not whether the
 * caller is allowed to hold the tool at all — that stays with the per-stream
 * privacy policy (`TOOL_CATEGORIES_BY_NAME`) and with which dependencies the
 * host constructs. A tier is about intent; a category is about exposure.
 */
export const TOOL_TIERS = [1, 2, 3] as const
export type ToolTier = (typeof TOOL_TIERS)[number]

export const ToolTiers = {
  /**
   * Reads, and participation inside the stream the turn is already running in.
   * Executes with no extra check: the worst case is a wasted call whose result
   * the user can see and ignore.
   */
  UNCHECKED: 1,
  /**
   * Writes durable state OUTSIDE the stream, or acts with the user's own
   * authority. A guardian reviews the conversation for evidence the user asked
   * for this before the call runs.
   */
  GUARDED: 2,
  /**
   * Reserved for explicit human-in-the-loop confirmation. Nothing is tier 3 yet
   * and no mechanism exists — a tool placed here would be reviewed like tier 2
   * and nothing more, so do not use it as if the stronger check existed.
   */
  CONFIRMED: 3,
} as const satisfies Record<string, ToolTier>

/**
 * Every agent tool's tier.
 *
 * Exhaustive via `satisfies` over `AgentToolName`: a newly added tool fails to
 * compile here until it is tiered, exactly like `TOOL_CATEGORIES_BY_NAME`.
 *
 * What that does NOT catch is a tool tiered WRONG — the build passes and every
 * table-driven test passes, because the table is also what the tests believe.
 * The rule that decides it, checkable by reading one line of a diff: **if the
 * call writes something the user would still see after closing this stream, or
 * acts with their authority somewhere else, it is not tier 1.** Reading, and
 * writing into the conversation the agent is already part of, are tier 1.
 */
export const TOOL_TIERS_BY_NAME = {
  // Participation in the running stream: the user sees every one of these land
  // in the conversation they are already looking at, and can undo it there.
  send_message: 1,
  react_to_message: 1,
  schedule_follow_up: 1,
  list_follow_ups: 1,
  cancel_follow_up: 1,
  update_follow_up: 1,
  update_stream_brief: 1,

  // Reads — no durable effect at all.
  web_search: 1,
  read_url: 1,
  general_research: 1,
  search_messages: 1,
  search_streams: 1,
  search_users: 1,
  get_stream_messages: 1,
  search_attachments: 1,
  read_attachment: 1,
  describe_memo: 1,
  github_repos: 1,
  github_commits: 1,
  github_pulls: 1,
  github_content: 1,
  github_workflows: 1,
  github_releases: 1,
  github_issues: 1,
  linear_list_issues: 1,
  linear_get_issue: 1,
  linear_list_projects: 1,
  linear_get_project: 1,

  // A memo outlives the stream, but it is inert: knowledge the user can read
  // and delete, with no authority attached and nothing acting on it.
  save_memo: 1,

  // Hands a compiled brief to the user's own local agent, which then executes
  // with the user's credentials on the user's machine. The highest-authority
  // action in the product — more than any setting — so it is guarded despite
  // predating the tier system.
  delegate_task: 2,
} as const satisfies Record<AgentToolName, ToolTier>

export function isAgentToolName(name: string): name is AgentToolName {
  return name in TOOL_TIERS_BY_NAME
}

/**
 * The tier of a tool by name. Registered names come from the table; anything
 * else is a host-local tool (the enclave's in-process readers), which is
 * conversation-local by construction and therefore tier 1.
 */
export function tierOfTool(name: string): ToolTier {
  return isAgentToolName(name) ? TOOL_TIERS_BY_NAME[name] : ToolTiers.UNCHECKED
}

/** Tools a guardian must review before they execute. */
export const GUARDED_TOOL_NAMES: readonly AgentToolName[] = AGENT_TOOL_NAMES.filter(
  (name) => TOOL_TIERS_BY_NAME[name] >= ToolTiers.GUARDED
)

export function requiresGuardianReview(tier: ToolTier): boolean {
  return tier >= ToolTiers.GUARDED
}
