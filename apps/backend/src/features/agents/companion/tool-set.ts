import { AgentToolNames } from "@threa/types"
import { createWebSearchTool, createReadUrlTool, type AgentTool } from "@threa/agent-runtime"
import type { WorkspaceAgentResult } from "../researcher"
import type { GeneralResearchResult } from "../general-researcher"
import type { GitHubToolDeps, LinearToolDeps, RunGeneralResearchOptions, RunWorkspaceAgentOptions } from "../tools"
import type { ReactionToolDeps, WorkspaceToolDeps } from "../tools/tool-deps"
import { logger } from "../../../lib/logger"
import {
  createGeneralResearchTool,
  createSearchMessagesTool,
  createSearchStreamsTool,
  createSearchUsersTool,
  createGetStreamMessagesTool,
  createSearchAttachmentsTool,
  createGetAttachmentTool,
  createDescribeMemoTool,
  createReactToMessageTool,
  createLoadAttachmentTool,
  createLoadPdfSectionTool,
  createLoadFileSectionTool,
  createLoadExcelSectionTool,
  createWorkspaceResearchTool,
  createGithubListReposTool,
  createGithubListBranchesTool,
  createGithubListCommitsTool,
  createGithubGetCommitTool,
  createGithubListPullRequestsTool,
  createGithubGetPullRequestTool,
  createGithubListPrFilesTool,
  createGithubGetFileContentsTool,
  createGithubSearchCodeTool,
  createGithubListWorkflowRunsTool,
  createGithubGetWorkflowRunTool,
  createGithubListReleasesTool,
  createGithubGetReleaseTool,
  createGithubSearchIssuesTool,
  createGithubGetIssueTool,
  createLinearListIssuesTool,
  createLinearGetIssueTool,
  createLinearListProjectsTool,
  createLinearGetProjectTool,
  isToolEnabled,
} from "../tools"

export interface ToolSetConfig {
  enabledTools: string[] | null
  tavilyApiKey?: string
  /** Invocation time used to ground current/latest/recent web searches. */
  currentTime?: string
  timezone?: string
  runWorkspaceAgent?: (query: string, opts: RunWorkspaceAgentOptions) => Promise<WorkspaceAgentResult>
  runGeneralResearch?: (query: string, opts: RunGeneralResearchOptions) => Promise<GeneralResearchResult>
  workspace?: WorkspaceToolDeps
  /**
   * Reaction callbacks bound to the running persona. Present only on the live
   * companion turn (not the general-researcher sub-agent), gating the
   * `react_to_message` tool — the researcher reads/searches, it never reacts.
   */
  reactions?: ReactionToolDeps
  github?: GitHubToolDeps
  linear?: LinearToolDeps
  supportsVision?: boolean
}

/**
 * Build the complete tool set for a companion agent session.
 * Each tool receives its dependencies at construction time.
 * Returns AgentTool[] — send_message is NOT included (the runtime handles it).
 */
export function buildToolSet(config: ToolSetConfig): AgentTool[] {
  const {
    enabledTools,
    tavilyApiKey,
    currentTime,
    timezone,
    runWorkspaceAgent,
    runGeneralResearch,
    workspace,
    reactions,
    github,
    linear,
    supportsVision,
  } = config

  if (!github && enabledTools !== null) {
    const requestedGithubTools = enabledTools.filter((t) => t.startsWith("github_"))
    if (requestedGithubTools.length > 0) {
      logger.warn(
        { requestedGithubTools },
        "persona has GitHub tools enabled but no GitHub deps were provided; the tools will be silently unavailable"
      )
    }
  }

  if (!linear && enabledTools !== null) {
    const requestedLinearTools = enabledTools.filter((t) => t.startsWith("linear_"))
    if (requestedLinearTools.length > 0) {
      logger.warn(
        { requestedLinearTools },
        "persona has Linear tools enabled but no Linear deps were provided; the tools will be silently unavailable"
      )
    }
  }

  const tools: Array<AgentTool | null> = [
    // Workspace research (available when agent has trigger context)
    runWorkspaceAgent ? createWorkspaceResearchTool({ runWorkspaceAgent }) : null,

    // General research — bounded multi-surface research (workspace + web +
    // integrations). Like workspace_research it needs the trigger context that
    // populates `runGeneralResearch`; additionally gated by persona enablement.
    runGeneralResearch && isToolEnabled(enabledTools, AgentToolNames.GENERAL_RESEARCH)
      ? createGeneralResearchTool({ runGeneralResearch, scope: "workspace-web-integrations" })
      : null,

    // Web tools
    tavilyApiKey && isToolEnabled(enabledTools, AgentToolNames.WEB_SEARCH)
      ? createWebSearchTool({ tavilyApiKey, currentTime, timezone })
      : null,
    isToolEnabled(enabledTools, AgentToolNames.READ_URL) ? createReadUrlTool() : null,

    // Workspace search tools
    workspace && isToolEnabled(enabledTools, AgentToolNames.SEARCH_MESSAGES)
      ? createSearchMessagesTool(workspace)
      : null,
    workspace && isToolEnabled(enabledTools, AgentToolNames.SEARCH_STREAMS) ? createSearchStreamsTool(workspace) : null,
    workspace && isToolEnabled(enabledTools, AgentToolNames.SEARCH_USERS) ? createSearchUsersTool(workspace) : null,
    workspace && isToolEnabled(enabledTools, AgentToolNames.GET_STREAM_MESSAGES)
      ? createGetStreamMessagesTool(workspace)
      : null,

    // Attachment tools
    workspace && isToolEnabled(enabledTools, AgentToolNames.SEARCH_ATTACHMENTS)
      ? createSearchAttachmentsTool(workspace)
      : null,
    workspace && isToolEnabled(enabledTools, AgentToolNames.GET_ATTACHMENT) ? createGetAttachmentTool(workspace) : null,
    workspace && isToolEnabled(enabledTools, AgentToolNames.DESCRIBE_MEMO) ? createDescribeMemoTool(workspace) : null,
    workspace && reactions && isToolEnabled(enabledTools, AgentToolNames.REACT_TO_MESSAGE)
      ? createReactToMessageTool(workspace, reactions)
      : null,
    workspace && supportsVision && isToolEnabled(enabledTools, AgentToolNames.LOAD_ATTACHMENT)
      ? createLoadAttachmentTool(workspace)
      : null,
    workspace && isToolEnabled(enabledTools, AgentToolNames.LOAD_PDF_SECTION)
      ? createLoadPdfSectionTool(workspace)
      : null,
    workspace && isToolEnabled(enabledTools, AgentToolNames.LOAD_FILE_SECTION)
      ? createLoadFileSectionTool(workspace)
      : null,
    workspace && isToolEnabled(enabledTools, AgentToolNames.LOAD_EXCEL_SECTION)
      ? createLoadExcelSectionTool(workspace)
      : null,

    // GitHub tools (workspace-scoped via installed GitHub App; read-only)
    github && isToolEnabled(enabledTools, AgentToolNames.GITHUB_LIST_REPOS) ? createGithubListReposTool(github) : null,
    github && isToolEnabled(enabledTools, AgentToolNames.GITHUB_LIST_BRANCHES)
      ? createGithubListBranchesTool(github)
      : null,
    github && isToolEnabled(enabledTools, AgentToolNames.GITHUB_LIST_COMMITS)
      ? createGithubListCommitsTool(github)
      : null,
    github && isToolEnabled(enabledTools, AgentToolNames.GITHUB_GET_COMMIT) ? createGithubGetCommitTool(github) : null,
    github && isToolEnabled(enabledTools, AgentToolNames.GITHUB_LIST_PULL_REQUESTS)
      ? createGithubListPullRequestsTool(github)
      : null,
    github && isToolEnabled(enabledTools, AgentToolNames.GITHUB_GET_PULL_REQUEST)
      ? createGithubGetPullRequestTool(github)
      : null,
    github && isToolEnabled(enabledTools, AgentToolNames.GITHUB_LIST_PR_FILES)
      ? createGithubListPrFilesTool(github)
      : null,
    github && isToolEnabled(enabledTools, AgentToolNames.GITHUB_GET_FILE_CONTENTS)
      ? createGithubGetFileContentsTool(github)
      : null,
    github && isToolEnabled(enabledTools, AgentToolNames.GITHUB_SEARCH_CODE)
      ? createGithubSearchCodeTool(github)
      : null,
    github && isToolEnabled(enabledTools, AgentToolNames.GITHUB_LIST_WORKFLOW_RUNS)
      ? createGithubListWorkflowRunsTool(github)
      : null,
    github && isToolEnabled(enabledTools, AgentToolNames.GITHUB_GET_WORKFLOW_RUN)
      ? createGithubGetWorkflowRunTool(github)
      : null,
    github && isToolEnabled(enabledTools, AgentToolNames.GITHUB_LIST_RELEASES)
      ? createGithubListReleasesTool(github)
      : null,
    github && isToolEnabled(enabledTools, AgentToolNames.GITHUB_GET_RELEASE)
      ? createGithubGetReleaseTool(github)
      : null,
    github && isToolEnabled(enabledTools, AgentToolNames.GITHUB_SEARCH_ISSUES)
      ? createGithubSearchIssuesTool(github)
      : null,
    github && isToolEnabled(enabledTools, AgentToolNames.GITHUB_GET_ISSUE) ? createGithubGetIssueTool(github) : null,

    // Linear tools (workspace-scoped via installed Linear OAuth app; read-only)
    linear && isToolEnabled(enabledTools, AgentToolNames.LINEAR_LIST_ISSUES)
      ? createLinearListIssuesTool(linear)
      : null,
    linear && isToolEnabled(enabledTools, AgentToolNames.LINEAR_GET_ISSUE) ? createLinearGetIssueTool(linear) : null,
    linear && isToolEnabled(enabledTools, AgentToolNames.LINEAR_LIST_PROJECTS)
      ? createLinearListProjectsTool(linear)
      : null,
    linear && isToolEnabled(enabledTools, AgentToolNames.LINEAR_GET_PROJECT)
      ? createLinearGetProjectTool(linear)
      : null,
  ]

  return tools.filter((t): t is AgentTool => t !== null)
}
