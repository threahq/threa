import type { AgentToolName } from "./constants"

/**
 * Coarse privacy categories an agent's tools fall into, used to express a
 * per-stream (and, later, per-workspace) tool-privacy policy that is honest
 * about what a scratchpad gives up: "no tools at all", "web but nothing else",
 * "workspace reads but no web egress", and so on.
 *
 * The owner picks categories, not a 30-tool checkbox. `messaging` (the agent's
 * own reply tool) is never gated — an agent must always be able to answer — so
 * it is a category for completeness but is always allowed regardless of policy.
 */
export const TOOL_PRIVACY_CATEGORIES = ["messaging", "web", "workspace", "github", "linear"] as const
export type ToolPrivacyCategory = (typeof TOOL_PRIVACY_CATEGORIES)[number]

export const ToolPrivacyCategories = {
  /** The agent's own reply tool (`send_message`). Always allowed. */
  MESSAGING: "messaging",
  /** External web egress: web_search (Tavily), read_url (fetch), general_research. */
  WEB: "web",
  /** Threa workspace reads: message/stream/user search, attachments, memos. */
  WORKSPACE: "workspace",
  /** GitHub integration reads. */
  GITHUB: "github",
  /** Linear integration reads. */
  LINEAR: "linear",
} as const satisfies Record<string, ToolPrivacyCategory>

/**
 * Every agent tool's privacy category. Exhaustive via `satisfies` over
 * `AgentToolName`: a newly added tool fails to compile here until it is
 * categorized, so the privacy gate can never silently miss a tool.
 */
export const TOOL_CATEGORY_BY_NAME = {
  send_message: "messaging",

  web_search: "web",
  read_url: "web",
  general_research: "web",

  search_messages: "workspace",
  search_streams: "workspace",
  search_users: "workspace",
  get_stream_messages: "workspace",
  search_attachments: "workspace",
  get_attachment: "workspace",
  load_attachment: "workspace",
  load_pdf_section: "workspace",
  load_file_section: "workspace",
  load_excel_section: "workspace",
  describe_memo: "workspace",

  github_list_repos: "github",
  github_list_branches: "github",
  github_list_commits: "github",
  github_get_commit: "github",
  github_list_pull_requests: "github",
  github_get_pull_request: "github",
  github_list_pr_files: "github",
  github_get_file_contents: "github",
  github_search_code: "github",
  github_list_workflow_runs: "github",
  github_get_workflow_run: "github",
  github_list_releases: "github",
  github_get_release: "github",
  github_search_issues: "github",
  github_get_issue: "github",

  linear_list_issues: "linear",
  linear_get_issue: "linear",
  linear_list_projects: "linear",
  linear_get_project: "linear",
} as const satisfies Record<AgentToolName, ToolPrivacyCategory>

/**
 * A tool-privacy policy is the set of allowed categories. `null`/`undefined`
 * means "no restriction" (the default, matching today's behavior); an array
 * restricts the agent to exactly those categories. `messaging` is always
 * allowed regardless — replies are not a privacy decision.
 */
export type ToolPrivacyPolicy = ToolPrivacyCategory[] | null

export function isToolCategoryAllowed(
  allowed: ToolPrivacyCategory[] | null | undefined,
  category: ToolPrivacyCategory
): boolean {
  if (category === "messaging") return true
  if (allowed === null || allowed === undefined) return true
  return allowed.includes(category)
}

export function isToolAllowedByPolicy(
  allowed: ToolPrivacyCategory[] | null | undefined,
  toolName: AgentToolName
): boolean {
  return isToolCategoryAllowed(allowed, TOOL_CATEGORY_BY_NAME[toolName])
}
