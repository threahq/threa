/**
 * Unified AI component configuration. Production uses StaticConfigResolver;
 * evals swap in EvalConfigResolver for programmatic overrides. Async to
 * support future DB/remote config sources.
 */

/**
 * Base config shape shared by all AI components. The index signature allows
 * components to add custom properties while keeping core fields type-safe.
 */
export interface ComponentConfig {
  /** Model ID in provider:modelPath format */
  modelId: string
  /** Temperature for generation (0.0 to 2.0) */
  temperature?: number
  /** System prompt (optional, some components build dynamically) */
  systemPrompt?: string
  [key: string]: unknown
}

export interface BoundaryExtractionConfig extends ComponentConfig {
  systemPrompt: string
}

export interface StreamNamingConfig extends ComponentConfig {
  temperature: number
}

export interface MemoClassifierConfig extends ComponentConfig {
  temperature: number
}

export interface MemoMemorizerConfig extends ComponentConfig {
  temperature: number
}

export interface SuggestionExtractorConfig extends ComponentConfig {
  temperature: number
}

export interface ResearcherConfig extends ComponentConfig {
  maxIterations?: number
  maxResultsPerSearch?: number
}

/**
 * The one config whose `modelId` is optional: the general researcher takes the
 * calling turn's model unless something deliberately pins one. Production
 * therefore registers no default model for it, so a present `modelId` here
 * always means an explicit override (an eval's `componentOverrides`, a `-m`
 * permutation) and outranks the caller's turn model.
 */
export interface GeneralResearcherConfig {
  modelId?: string
  temperature?: number
  systemPrompt?: string
  maxIterations?: number
  [key: string]: unknown
}

export interface CompanionAgentConfig extends ComponentConfig {
  temperature: number
}

/** Convention: "component" or "component:subcomponent" */
export const COMPONENT_PATHS = {
  BOUNDARY_EXTRACTION: "boundary-extraction",
  STREAM_NAMING: "stream-naming",
  MEMO_CLASSIFIER: "memo:classifier",
  MEMO_MEMORIZER: "memo:memorizer",
  SUGGESTION_EXTRACTOR: "saved-suggestions:extractor",
  COMPANION_AGENT: "companion:agent",
  COMPANION_RESEARCHER: "companion:researcher",
  GENERAL_RESEARCHER: "general:researcher",
  TOOL_GUARDIAN: "agents:tool-guardian",
  EMBEDDING: "embedding",
} as const

export type ComponentPath = (typeof COMPONENT_PATHS)[keyof typeof COMPONENT_PATHS]

/** Maps component paths to their config types for resolve<T>() inference. */
export interface PathConfigMap {
  "boundary-extraction": BoundaryExtractionConfig
  "stream-naming": StreamNamingConfig
  "memo:classifier": MemoClassifierConfig
  "memo:memorizer": MemoMemorizerConfig
  "saved-suggestions:extractor": SuggestionExtractorConfig
  "companion:agent": CompanionAgentConfig
  "companion:researcher": ResearcherConfig
  "general:researcher": GeneralResearcherConfig
  "agents:tool-guardian": ComponentConfig
  embedding: ComponentConfig
}

/** Every shape `resolve` can return: model-pinned components plus the researcher. */
export type AnyComponentConfig = ComponentConfig | GeneralResearcherConfig

export interface ConfigResolver {
  /**
   * Resolve config for a component path.
   * @throws Error if path is unknown (fail loudly, no silent defaults; INV-11)
   */
  resolve<T extends AnyComponentConfig = ComponentConfig>(path: string): Promise<T>
}
