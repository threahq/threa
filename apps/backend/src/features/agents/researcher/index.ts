export {
  WorkspaceAgent,
  type WorkspaceAgentResult,
  type WorkspaceAgentInput,
  type WorkspaceAgentDeps,
  type WorkspaceSourceItem,
} from "./researcher"
export { PeopleResolver } from "./people-resolver"
export {
  computeAgentAccessSpec,
  resolveMemoViewer,
  memoAudienceForSpec,
  type AgentAccessSpec,
  type ComputeAccessSpecParams,
} from "./access-spec"
export {
  formatRetrievedContext,
  enrichMessageSearchResults,
  type EnrichedMemoResult,
  type EnrichedMessageResult,
  type RawMessageSearchResult,
} from "./context-formatter"
