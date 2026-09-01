export {
  type WorkspaceToolDeps,
  type ReactionToolDeps,
  type FollowUpToolDeps,
  type ScheduleFollowUpToolDeps,
  type ListFollowUpsToolDeps,
  type CancelFollowUpToolDeps,
  type UpdateFollowUpToolDeps,
  type ScheduleFollowUpToolResult,
  type CancelFollowUpToolResult,
  type UpdateFollowUpToolResult,
  type FollowUpSummary,
  type UpdateStreamBriefToolDeps,
  type UpdateUserSettingsToolDeps,
  type UpdateStreamBriefToolResult,
  type SaveMemoToolDeps,
  type SaveMemoToolResult,
} from "./tool-deps"
// Web + send tools live in @threa/agent-runtime (shared with the enclave).
// Re-exported here so backend imports (`../tools`) keep working.
export {
  createSendMessageTool,
  type SendMessageInput,
  type SendMessageInputWithSources,
  type SendMessageResult,
  createWebSearchTool,
  type WebSearchInput,
  type WebSearchResult,
  createReadUrlTool,
  type ReadUrlInput,
  type ReadUrlResult,
} from "@threa/agent-runtime"
export {
  createSearchMessagesTool,
  createSearchStreamsTool,
  createSearchUsersTool,
  createGetStreamMessagesTool,
  type SearchMessagesInput,
  type SearchStreamsInput,
  type SearchUsersInput,
  type GetStreamMessagesInput,
  type MessageSearchResult,
  type StreamSearchResult,
  type UserSearchResult,
  type StreamMessagesResult,
} from "./search-workspace-tool"
export {
  createSearchAttachmentsTool,
  type SearchAttachmentsInput,
  type AttachmentSearchResult,
} from "./search-attachments-tool"
export { createReadAttachmentTool, type ReadAttachmentInput } from "./read-attachment-tool"
export { createDescribeMemoTool, type DescribeMemoInput } from "./describe-memo-tool"
export { createReactToMessageTool, type ReactToMessageInput } from "./react-to-message-tool"
export { createScheduleFollowUpTool, type ScheduleFollowUpInput } from "./schedule-follow-up-tool"
export { createListFollowUpsTool, type ListFollowUpsInput } from "./list-follow-ups-tool"
export { createCancelFollowUpTool, type CancelFollowUpInput } from "./cancel-follow-up-tool"
export { createUpdateFollowUpTool, type UpdateFollowUpInput } from "./update-follow-up-tool"
export { createUpdateStreamBriefTool, type UpdateStreamBriefInput } from "./update-stream-brief-tool"
export {
  createUpdateUserSettingsTool,
  canOfferUserSettings,
  type UpdateUserSettingsInput,
} from "./update-user-settings-tool"
export { createDelegateTaskTool, type DelegateTaskInput } from "./delegate-task-tool"
export {
  createDelegateToModelTool,
  canOfferSubagentDelegation,
  type DelegateToModelInput,
} from "./delegate-to-subagent-tool"
export { createReportBackTool, type ReportBackInput } from "./report-back-tool"
export { createSaveMemoTool, type SaveMemoInput } from "./save-memo-tool"
export {
  createWorkspaceResearchTool,
  WORKSPACE_RESEARCH_TOOL_NAME,
  type WorkspaceResearchInput,
  type WorkspaceResearchCallbacks,
  type RunWorkspaceAgentOptions,
} from "./workspace-research-tool"
export {
  createGeneralResearchTool,
  type GeneralResearchCallbacks,
  type RunGeneralResearchOptions,
} from "./general-research-tool"
export {
  createGithubReposTool,
  createGithubCommitsTool,
  createGithubPullsTool,
  createGithubContentTool,
  createGithubWorkflowsTool,
  createGithubReleasesTool,
  createGithubIssuesTool,
  createMemoizedGithubClient,
  type GitHubToolDeps,
} from "./github"
export {
  createLinearListIssuesTool,
  createLinearGetIssueTool,
  createLinearListProjectsTool,
  createLinearGetProjectTool,
  createMemoizedLinearClient,
  type LinearToolDeps,
} from "./linear"

/**
 * A null `enabledTools` enables all tools (backwards-compatible default).
 */
export function isToolEnabled(enabledTools: string[] | null, toolName: string): boolean {
  if (enabledTools === null) return true
  return enabledTools.includes(toolName)
}
