// The general_research tool definition is shared with the enclave, so it lives
// in `@threa/agent-runtime`. Re-exported here so the backend tool barrel and its
// importers keep their existing paths. `GeneralResearchToolInput` is surfaced
// under the backend's historical `GeneralResearchInput` name.
export {
  createGeneralResearchTool,
  type GeneralResearchCallbacks,
  type RunGeneralResearchOptions,
  type GeneralResearchToolInput as GeneralResearchInput,
} from "@threa/agent-runtime"
