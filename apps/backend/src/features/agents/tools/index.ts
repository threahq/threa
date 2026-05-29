export { type WorkspaceToolDeps } from "./tool-deps"
// Web + send tools moved to @threa/agent-runtime (shared with the enclave).
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
export { createGetAttachmentTool, type GetAttachmentInput, type AttachmentDetails } from "./get-attachment-tool"
export { createDescribeMemoTool, type DescribeMemoInput } from "./describe-memo-tool"
export { createLoadAttachmentTool, type LoadAttachmentInput, type LoadAttachmentResult } from "./load-attachment-tool"
export { createLoadPdfSectionTool, type LoadPdfSectionInput, type LoadPdfSectionResult } from "./load-pdf-section-tool"
export {
  createLoadFileSectionTool,
  type LoadFileSectionInput,
  type LoadFileSectionResult,
} from "./load-file-section-tool"
export {
  createLoadExcelSectionTool,
  type LoadExcelSectionInput,
  type LoadExcelSectionResult,
} from "./load-excel-section-tool"
export {
  createWorkspaceResearchTool,
  type WorkspaceResearchInput,
  type WorkspaceResearchCallbacks,
  type RunWorkspaceAgentOptions,
} from "./workspace-research-tool"
export {
  createGeneralResearchTool,
  type GeneralResearchInput,
  type GeneralResearchCallbacks,
  type RunGeneralResearchOptions,
} from "./general-research-tool"
export {
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
 * Check if a tool is enabled for a persona.
 * If enabledTools is null, all tools are enabled (backwards compatible default).
 */
export function isToolEnabled(enabledTools: string[] | null, toolName: string): boolean {
  if (enabledTools === null) return true
  return enabledTools.includes(toolName)
}
