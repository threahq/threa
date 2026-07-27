/**
 * Production config resolver: default configs for all AI components, sourced
 * from their co-located config.ts files (INV-43). Optional construction-time
 * overrides for testing or per-environment configuration.
 */

import type { ConfigResolver, ComponentConfig } from "./config-resolver"
import { COMPONENT_PATHS } from "./config-resolver"

import {
  BOUNDARY_EXTRACTION_MODEL_ID,
  BOUNDARY_EXTRACTION_TEMPERATURE,
  BOUNDARY_EXTRACTION_SYSTEM_PROMPT,
} from "../../features/conversations"
import { STREAM_NAMING_MODEL_ID, STREAM_NAMING_TEMPERATURE } from "../../features/streams"
import { MEMO_CLASSIFIER_MODEL_ID, MEMO_MEMORIZER_MODEL_ID, MEMO_TEMPERATURES } from "../../features/memos"
import {
  SUGGESTION_EXTRACTOR_MODEL_ID,
  SUGGESTION_EXTRACTOR_TEMPERATURE,
} from "../../features/saved-suggestions/config"
import {
  WORKSPACE_AGENT_MODEL_ID,
  WORKSPACE_AGENT_TEMPERATURE,
  WORKSPACE_AGENT_MAX_ITERATIONS,
  WORKSPACE_AGENT_MAX_RESULTS_PER_SEARCH,
  GENERAL_RESEARCH_MODEL_ID,
  GENERAL_RESEARCH_TEMPERATURE,
  GENERAL_RESEARCH_MAX_ITERATIONS,
  COMPANION_MODEL_ID,
  COMPANION_TEMPERATURE,
  TOOL_GUARDIAN_MODEL_ID,
  TOOL_GUARDIAN_TEMPERATURE,
  TOOL_GUARDIAN_SYSTEM_PROMPT,
} from "../../features/agents"
import { EMBEDDING_MODEL_ID } from "../../features/memos"

function buildDefaultConfigs(): Map<string, ComponentConfig> {
  const configs = new Map<string, ComponentConfig>()

  configs.set(COMPONENT_PATHS.BOUNDARY_EXTRACTION, {
    modelId: BOUNDARY_EXTRACTION_MODEL_ID,
    temperature: BOUNDARY_EXTRACTION_TEMPERATURE,
    systemPrompt: BOUNDARY_EXTRACTION_SYSTEM_PROMPT,
  })

  configs.set(COMPONENT_PATHS.STREAM_NAMING, {
    modelId: STREAM_NAMING_MODEL_ID,
    temperature: STREAM_NAMING_TEMPERATURE,
  })

  configs.set(COMPONENT_PATHS.MEMO_CLASSIFIER, {
    modelId: MEMO_CLASSIFIER_MODEL_ID,
    temperature: MEMO_TEMPERATURES.classification,
  })

  configs.set(COMPONENT_PATHS.MEMO_MEMORIZER, {
    modelId: MEMO_MEMORIZER_MODEL_ID,
    temperature: MEMO_TEMPERATURES.memorization,
  })

  configs.set(COMPONENT_PATHS.SUGGESTION_EXTRACTOR, {
    modelId: SUGGESTION_EXTRACTOR_MODEL_ID,
    temperature: SUGGESTION_EXTRACTOR_TEMPERATURE,
  })

  configs.set(COMPONENT_PATHS.COMPANION_AGENT, {
    modelId: COMPANION_MODEL_ID,
    temperature: COMPANION_TEMPERATURE,
  })

  configs.set(COMPONENT_PATHS.COMPANION_RESEARCHER, {
    modelId: WORKSPACE_AGENT_MODEL_ID,
    temperature: WORKSPACE_AGENT_TEMPERATURE,
    maxIterations: WORKSPACE_AGENT_MAX_ITERATIONS,
    maxResultsPerSearch: WORKSPACE_AGENT_MAX_RESULTS_PER_SEARCH,
  })

  configs.set(COMPONENT_PATHS.GENERAL_RESEARCHER, {
    modelId: GENERAL_RESEARCH_MODEL_ID,
    temperature: GENERAL_RESEARCH_TEMPERATURE,
    maxIterations: GENERAL_RESEARCH_MAX_ITERATIONS,
  })

  configs.set(COMPONENT_PATHS.TOOL_GUARDIAN, {
    modelId: TOOL_GUARDIAN_MODEL_ID,
    temperature: TOOL_GUARDIAN_TEMPERATURE,
    systemPrompt: TOOL_GUARDIAN_SYSTEM_PROMPT,
  })

  configs.set(COMPONENT_PATHS.EMBEDDING, {
    modelId: EMBEDDING_MODEL_ID,
  })

  return configs
}

const DEFAULT_CONFIGS = buildDefaultConfigs()

export interface StaticConfigResolverOptions {
  /** Overrides per component path, merged onto defaults (overrides win). */
  overrides?: Partial<Record<string, Partial<ComponentConfig>>>
}

export function createStaticConfigResolver(options: StaticConfigResolverOptions = {}): ConfigResolver {
  const { overrides = {} } = options

  return {
    async resolve<T extends ComponentConfig = ComponentConfig>(path: string): Promise<T> {
      const defaultConfig = DEFAULT_CONFIGS.get(path)

      if (!defaultConfig) {
        const knownPaths = Array.from(DEFAULT_CONFIGS.keys()).join(", ")
        throw new Error(`Unknown config path: "${path}". Known paths: ${knownPaths}`)
      }

      const override = overrides[path]

      if (!override) {
        return defaultConfig as T
      }

      return { ...defaultConfig, ...override } as T
    },
  }
}

export const defaultConfigResolver = createStaticConfigResolver()
