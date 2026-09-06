import { AgentToolNames } from "@threahq/types"
import { createWebSearchTool, createReadUrlTool, type AgentTool } from "@threahq/agent-runtime"
import type { WorkspaceAgentResult } from "../researcher"
import type { GeneralResearchResult } from "../general-researcher"
import type { GitHubToolDeps, LinearToolDeps, RunGeneralResearchOptions, RunWorkspaceAgentOptions } from "../tools"
import type {
  DelegateTaskToolDeps,
  StartSubagentToolDeps,
  ReportBackToolDeps,
  FollowUpToolDeps,
  ReactionToolDeps,
  SaveMemoToolDeps,
  UpdateStreamBriefToolDeps,
  UpdateUserSettingsToolDeps,
  WorkspaceToolDeps,
} from "../tools/tool-deps"
import { logger } from "../../../lib/logger"
import {
  createGeneralResearchTool,
  createSearchMessagesTool,
  createSearchStreamsTool,
  createSearchUsersTool,
  createGetStreamMessagesTool,
  createSearchAttachmentsTool,
  createReadAttachmentTool,
  createDescribeMemoTool,
  createReactToMessageTool,
  createScheduleFollowUpTool,
  createListFollowUpsTool,
  createCancelFollowUpTool,
  createUpdateFollowUpTool,
  createUpdateStreamBriefTool,
  createUpdateUserSettingsTool,
  createDelegateTaskTool,
  createStartSubagentTool,
  createReportBackTool,
  createSaveMemoTool,
  createWorkspaceResearchTool,
  createGithubReposTool,
  createGithubCommitsTool,
  createGithubPullsTool,
  createGithubContentTool,
  createGithubWorkflowsTool,
  createGithubReleasesTool,
  createGithubIssuesTool,
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
  /**
   * Follow-up scheduling callback bound to the running persona/session/stream.
   * Present only on the live companion turn (not the researcher sub-agent),
   * gating the `schedule_follow_up` tool — the researcher reads/searches, it
   * never schedules durable work.
   */
  followUps?: FollowUpToolDeps
  /**
   * Brief-maintenance callback bound to the running persona/stream, gating the
   * `update_stream_brief` tool. Present only on the live companion turn (not the
   * researcher sub-agent — it reads/searches, it never curates durable state).
   */
  brief?: UpdateStreamBriefToolDeps
  /**
   * The brief's version as read at context time — seeds the tool's optimistic
   * write so a concurrent human edit surfaces as a conflict rather than a silent
   * clobber. Defaults to 0 (no brief yet → create).
   */
  briefVersion?: number
  /**
   * Delegation callback bound to the running persona/session/stream and the
   * invoking user, gating the `delegate_task` tool. Present only on the live
   * companion turn — and only when the stream is not sealed and a human
   * triggered the turn (the brief resolves against that user's access).
   */
  delegation?: DelegateTaskToolDeps
  /**
   * Subagent delegation callback bound to the running persona/session/stream and
   * the invoking user, gating the `start_subagent` tool. Absent — so the tool
   * is never built — on sealed streams, on turns without a human trigger, and
   * inside a subagent thread (that absence IS the no-nesting rule).
   */
  subagentDelegation?: StartSubagentToolDeps
  /**
   * Run-closing callback bound to the subagent run this turn is executing,
   * gating the `report_back` tool. Present ONLY inside a subagent thread.
   */
  reportBack?: ReportBackToolDeps
  /**
   * Memo-save callback bound to the running persona/stream/session, gating the
   * `save_memo` tool. Present only on the live companion turn (not the researcher
   * sub-agent — it reads/searches, it never writes durable memory).
   */
  saveMemo?: SaveMemoToolDeps
  /**
   * Settings-change callback bound to the INVOKING USER, gating the
   * `update_user_settings` tool. Present only when the turn is a human-triggered
   * one in that user's own scratchpad (or a thread rooted in one) and the stream
   * is not sealed — settings are personal, so a channel or DM never offers this,
   * and a turn with no human trigger has no user whose settings to change.
   */
  settings?: UpdateUserSettingsToolDeps
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
    followUps,
    brief,
    briefVersion,
    delegation,
    subagentDelegation,
    reportBack,
    saveMemo,
    settings,
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
    runWorkspaceAgent
      ? createWorkspaceResearchTool({ runWorkspaceAgent, searchFlag: workspace?.searchFlag ?? "off" })
      : null,

    // General research — bounded multi-surface research (workspace + web +
    // integrations). Like workspace_research it needs the trigger context that
    // populates `runGeneralResearch`; additionally gated by persona enablement.
    runGeneralResearch && isToolEnabled(enabledTools, AgentToolNames.GENERAL_RESEARCH)
      ? createGeneralResearchTool({ runGeneralResearch, scope: "workspace-web-integrations" })
      : null,

    tavilyApiKey && isToolEnabled(enabledTools, AgentToolNames.WEB_SEARCH)
      ? createWebSearchTool({ tavilyApiKey, currentTime, timezone })
      : null,
    isToolEnabled(enabledTools, AgentToolNames.READ_URL) ? createReadUrlTool({ supportsVision }) : null,

    workspace && isToolEnabled(enabledTools, AgentToolNames.SEARCH_MESSAGES)
      ? createSearchMessagesTool(workspace)
      : null,
    workspace && isToolEnabled(enabledTools, AgentToolNames.SEARCH_STREAMS) ? createSearchStreamsTool(workspace) : null,
    workspace && isToolEnabled(enabledTools, AgentToolNames.SEARCH_USERS) ? createSearchUsersTool(workspace) : null,
    workspace && isToolEnabled(enabledTools, AgentToolNames.GET_STREAM_MESSAGES)
      ? createGetStreamMessagesTool(workspace)
      : null,

    workspace && isToolEnabled(enabledTools, AgentToolNames.SEARCH_ATTACHMENTS)
      ? createSearchAttachmentsTool(workspace)
      : null,
    // One reader for every file type. Image bytes ride along only on a
    // vision-capable model; text/PDF/Excel reads (and large-file paging) work
    // regardless, so this is gated on workspace access, not vision.
    workspace && isToolEnabled(enabledTools, AgentToolNames.READ_ATTACHMENT)
      ? createReadAttachmentTool(workspace, { supportsVision: Boolean(supportsVision) })
      : null,
    workspace && isToolEnabled(enabledTools, AgentToolNames.DESCRIBE_MEMO) ? createDescribeMemoTool(workspace) : null,
    workspace && reactions && isToolEnabled(enabledTools, AgentToolNames.REACT_TO_MESSAGE)
      ? createReactToMessageTool(workspace, reactions)
      : null,
    followUps && isToolEnabled(enabledTools, AgentToolNames.SCHEDULE_FOLLOW_UP)
      ? createScheduleFollowUpTool(followUps, { timezone, currentTime })
      : null,
    followUps && isToolEnabled(enabledTools, AgentToolNames.LIST_FOLLOW_UPS)
      ? createListFollowUpsTool(followUps, { timezone })
      : null,
    followUps && isToolEnabled(enabledTools, AgentToolNames.CANCEL_FOLLOW_UP)
      ? createCancelFollowUpTool(followUps)
      : null,
    followUps && isToolEnabled(enabledTools, AgentToolNames.UPDATE_FOLLOW_UP)
      ? createUpdateFollowUpTool(followUps, { timezone, currentTime })
      : null,
    brief && isToolEnabled(enabledTools, AgentToolNames.UPDATE_STREAM_BRIEF)
      ? createUpdateStreamBriefTool(brief, { currentVersion: briefVersion ?? 0 })
      : null,
    delegation && isToolEnabled(enabledTools, AgentToolNames.DELEGATE_TASK) ? createDelegateTaskTool(delegation) : null,
    subagentDelegation && isToolEnabled(enabledTools, AgentToolNames.START_SUBAGENT)
      ? createStartSubagentTool(subagentDelegation)
      : null,
    // Not gated on persona enablement: the run exists because the persona was
    // delegated to, and a subagent with no way to close its own run would leave
    // the card waiting forever.
    reportBack ? createReportBackTool(reportBack) : null,
    saveMemo && isToolEnabled(enabledTools, AgentToolNames.SAVE_MEMO) ? createSaveMemoTool(saveMemo) : null,
    settings && isToolEnabled(enabledTools, AgentToolNames.UPDATE_USER_SETTINGS)
      ? createUpdateUserSettingsTool(settings)
      : null,

    // GitHub tools (workspace-scoped via installed GitHub App; read-only)
    github && isToolEnabled(enabledTools, AgentToolNames.GITHUB_REPOS) ? createGithubReposTool(github) : null,
    github && isToolEnabled(enabledTools, AgentToolNames.GITHUB_COMMITS) ? createGithubCommitsTool(github) : null,
    github && isToolEnabled(enabledTools, AgentToolNames.GITHUB_PULLS) ? createGithubPullsTool(github) : null,
    github && isToolEnabled(enabledTools, AgentToolNames.GITHUB_CONTENT) ? createGithubContentTool(github) : null,
    github && isToolEnabled(enabledTools, AgentToolNames.GITHUB_WORKFLOWS) ? createGithubWorkflowsTool(github) : null,
    github && isToolEnabled(enabledTools, AgentToolNames.GITHUB_RELEASES) ? createGithubReleasesTool(github) : null,
    github && isToolEnabled(enabledTools, AgentToolNames.GITHUB_ISSUES) ? createGithubIssuesTool(github) : null,

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
