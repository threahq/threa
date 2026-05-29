/**
 * ConfigResolver - Unified AI Component Configuration
 *
 * Provides a consistent interface for resolving AI component configurations.
 * Production code uses StaticConfigResolver; evals can swap in EvalConfigResolver
 * for programmatic overrides.
 *
 * Design:
 * - Async to support future DB/Langfuse/remote config sources
 * - Generic resolve<T> allows type-safe component-specific configs
 * - Paths use convention: "component" or "component:subcomponent"
 */

// -----------------------------------------------------------------------------
// Component Config Types
// -----------------------------------------------------------------------------

/**
 * Base config shape shared by all AI components.
 * Components extend this with additional fields as needed.
 *
 * The index signature allows components to add custom properties
 * while maintaining type safety for the core fields.
 */
export interface ComponentConfig {
  /** Model ID in provider:modelPath format */
  modelId: string
  /** Temperature for generation (0.0 to 2.0) */
  temperature?: number
  /** System prompt (optional, some components build dynamically) */
  systemPrompt?: string
  /** Allow additional component-specific properties */
  [key: string]: unknown
}

// -----------------------------------------------------------------------------
// Component-Specific Configs
// -----------------------------------------------------------------------------

/** Config for boundary extraction */
export interface BoundaryExtractionConfig extends ComponentConfig {
  systemPrompt: string
}

/** Config for stream naming */
export interface StreamNamingConfig extends ComponentConfig {
  temperature: number
}

/** Config for memo classifier */
export interface MemoClassifierConfig extends ComponentConfig {
  temperature: number
}

/** Config for memo memorizer */
export interface MemoMemorizerConfig extends ComponentConfig {
  temperature: number
}

/** Config for researcher agent */
export interface ResearcherConfig extends ComponentConfig {
  maxIterations?: number
  maxResultsPerSearch?: number
}

/** Config for the general (multi-surface) researcher agent */
export interface GeneralResearcherConfig extends ComponentConfig {
  maxIterations?: number
}

/** Config for companion agent */
export interface CompanionAgentConfig extends ComponentConfig {
  temperature: number
}

// -----------------------------------------------------------------------------
// Component Paths
// -----------------------------------------------------------------------------

/**
 * Known component paths.
 * Convention: "component" or "component:subcomponent"
 */
export const COMPONENT_PATHS = {
  BOUNDARY_EXTRACTION: "boundary-extraction",
  STREAM_NAMING: "stream-naming",
  MEMO_CLASSIFIER: "memo:classifier",
  MEMO_MEMORIZER: "memo:memorizer",
  COMPANION_AGENT: "companion:agent",
  COMPANION_RESEARCHER: "companion:researcher",
  GENERAL_RESEARCHER: "general:researcher",
  EMBEDDING: "embedding",
} as const

export type ComponentPath = (typeof COMPONENT_PATHS)[keyof typeof COMPONENT_PATHS]

// -----------------------------------------------------------------------------
// Path to Config Type Mapping
// -----------------------------------------------------------------------------

/**
 * Maps component paths to their config types.
 * Used for type inference with resolve<T>().
 */
export interface PathConfigMap {
  "boundary-extraction": BoundaryExtractionConfig
  "stream-naming": StreamNamingConfig
  "memo:classifier": MemoClassifierConfig
  "memo:memorizer": MemoMemorizerConfig
  "companion:agent": CompanionAgentConfig
  "companion:researcher": ResearcherConfig
  "general:researcher": GeneralResearcherConfig
  embedding: ComponentConfig
}

// -----------------------------------------------------------------------------
// ConfigResolver Interface
// -----------------------------------------------------------------------------

/**
 * Async config resolver interface.
 *
 * Implementations:
 * - StaticConfigResolver: Production defaults with optional overrides
 * - EvalConfigResolver: Wraps base resolver with eval-specific overrides
 *
 * Future extensions:
 * - DB-backed resolver for persona configs
 * - Langfuse prompt resolver
 * - A/B testing resolver
 */
export interface ConfigResolver {
  /**
   * Resolve config for a component path.
   *
   * @param path Component path like "companion:agent", "stream-naming"
   * @returns Promise resolving to the component's config
   * @throws Error if path is unknown (fail loudly, no silent defaults)
   *
   * @example
   * const config = await resolver.resolve("boundary-extraction")
   * // config.modelId, config.temperature, config.systemPrompt
   *
   * @example Type-safe with known paths
   * const config = await resolver.resolve<BoundaryExtractionConfig>("boundary-extraction")
   */
  resolve<T extends ComponentConfig = ComponentConfig>(path: string): Promise<T>
}
