// The general_research tool definition is shared with the enclave, so it lives
// in `@threa/agent-runtime`. Re-exported here so the backend tool barrel and its
// importers keep their existing paths.
export {
  createGeneralResearchTool,
  type GeneralResearchCallbacks,
  type RunGeneralResearchOptions,
} from "@threa/agent-runtime"
