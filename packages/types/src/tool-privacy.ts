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
 * Every agent tool's privacy categories. A tool is *one of some* categories, not
 * exactly one: a policy allowing ANY of a tool's categories permits the tool
 * (see `isToolAllowedByPolicy`).
 *
 * This is what lets `web` subsume GitHub *reads*: a public GitHub read is a
 * better-structured `read_url` against data already reachable over the open web,
 * so the GitHub read tools carry both `github` and `web`. Granting `web` then
 * implicitly grants the richer GitHub context, while granting only `github` does
 * NOT grant raw web — the asymmetry is deliberate. Linear has no public,
 * unauthenticated surface, so its tools stay `linear`-only.
 *
 * Exhaustive via `satisfies` over `AgentToolName`: a newly added tool fails to
 * compile here until it is categorized, so the privacy gate can never silently
 * miss a tool.
 */
export const TOOL_CATEGORIES_BY_NAME = {
  send_message: ["messaging"],
  // Reacting is in-product participation (like sending a reply), not data
  // egress, so it rides the always-allowed `messaging` class rather than a
  // privacy grant.
  react_to_message: ["messaging"],

  web_search: ["web"],
  read_url: ["web"],
  general_research: ["web"],

  search_messages: ["workspace"],
  search_streams: ["workspace"],
  search_users: ["workspace"],
  get_stream_messages: ["workspace"],
  search_attachments: ["workspace"],
  get_attachment: ["workspace"],
  load_attachment: ["workspace"],
  load_pdf_section: ["workspace"],
  load_file_section: ["workspace"],
  load_excel_section: ["workspace"],
  describe_memo: ["workspace"],

  // GitHub reads are public-web-class egress (a structured read_url), so they
  // ride the `web` grant as well as `github`.
  github_list_repos: ["github", "web"],
  github_list_branches: ["github", "web"],
  github_list_commits: ["github", "web"],
  github_get_commit: ["github", "web"],
  github_list_pull_requests: ["github", "web"],
  github_get_pull_request: ["github", "web"],
  github_list_pr_files: ["github", "web"],
  github_get_file_contents: ["github", "web"],
  github_search_code: ["github", "web"],
  github_list_workflow_runs: ["github", "web"],
  github_get_workflow_run: ["github", "web"],
  github_list_releases: ["github", "web"],
  github_get_release: ["github", "web"],
  github_search_issues: ["github", "web"],
  github_get_issue: ["github", "web"],

  // Linear has no unauthenticated public surface — it never rides `web`.
  linear_list_issues: ["linear"],
  linear_get_issue: ["linear"],
  linear_list_projects: ["linear"],
  linear_get_project: ["linear"],
} as const satisfies Record<AgentToolName, readonly ToolPrivacyCategory[]>

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

/**
 * A tool is permitted when the policy allows ANY of its categories — so a
 * `web`-only policy still reaches the GitHub read tools (tagged `github` + `web`)
 * without granting raw `github`/`linear` access. `messaging` is always allowed;
 * a `null`/`undefined` policy allows everything.
 *
 * An EMPTY category set is also always allowed: it marks a conversation-local
 * tool that reads nothing beyond what the model already sees (e.g. the
 * enclave's in-process `load_attachment`, whose files ride the messages
 * themselves) — there is no egress or workspace read for a policy to gate.
 * Registered `AgentToolName`s never carry an empty set (the table below is
 * non-empty by test), so this case only arises for per-definition categories
 * on `AgentToolConfig`.
 */
export function areToolCategoriesAllowed(
  allowed: ToolPrivacyCategory[] | null | undefined,
  categories: readonly ToolPrivacyCategory[]
): boolean {
  if (categories.length === 0) return true
  if (categories.includes("messaging")) return true
  if (allowed === null || allowed === undefined) return true
  return categories.some((category) => allowed.includes(category))
}

export function isToolAllowedByPolicy(
  allowed: ToolPrivacyCategory[] | null | undefined,
  toolName: AgentToolName
): boolean {
  return areToolCategoriesAllowed(allowed, TOOL_CATEGORIES_BY_NAME[toolName])
}
