export { runGeneralResearch } from "./general-researcher"
export type {
  RunGeneralResearchDeps,
  GeneralResearchRunInput,
  GeneralResearchResult,
  GeneralResearchSubstep,
} from "./general-researcher"
export { createGeneralResearchTool } from "./general-research-tool"
export type {
  GeneralResearchToolInput,
  GeneralResearchCallbacks,
  RunGeneralResearchOptions,
} from "./general-research-tool"
export { ResearchProgressObserver } from "./progress-observer"
export { composeAbortSignal, normalizeSourceType, readStringField, type ComposedAbortSignal } from "./research-support"
export {
  GENERAL_RESEARCH_MODEL_ID,
  GENERAL_RESEARCH_TEMPERATURE,
  GENERAL_RESEARCH_MAX_ITERATIONS,
  GENERAL_RESEARCH_TOTAL_BUDGET_MS,
  GENERAL_RESEARCH_MAX_BRIEF_CHARS,
  GENERAL_RESEARCH_SYSTEM_PROMPT,
} from "./config"
