/**
 * EvalConfigResolver - Evaluation Configuration Wrapper
 *
 * Wraps a base ConfigResolver to apply eval-specific overrides.
 * Supports two override sources:
 * 1. Programmatic overrides passed at construction
 * 2. YAML config file overrides via componentOverrides
 *
 * This allows evals to test different model/temperature/prompt
 * combinations while using the SAME production code paths.
 */

import type { ConfigResolver, ComponentConfig, AnyComponentConfig } from "../../src/lib/ai/config-resolver"
import type { ComponentConfig as YamlComponentConfig, ComponentOverrides } from "./config-types"

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface EvalConfigResolverOptions {
  /**
   * Base resolver providing production defaults.
   */
  base: ConfigResolver

  /**
   * Programmatic overrides (merged with base).
   * Keys are component paths like "boundary-extraction", "companion:agent"
   */
  overrides?: Partial<Record<string, Partial<ComponentConfig>>>
}

// -----------------------------------------------------------------------------
// YAML to Resolver Mapping
// -----------------------------------------------------------------------------

/**
 * Convert YAML componentOverrides to resolver override format.
 *
 * YAML config uses different field names:
 * - `model` → `modelId`
 * - `prompt` → `systemPrompt`
 *
 * @param componentOverrides From YAML config file
 * @returns Overrides in ConfigResolver format
 */
export function convertYamlOverrides(
  componentOverrides?: ComponentOverrides
): Partial<Record<string, Partial<ComponentConfig>>> {
  if (!componentOverrides) {
    return {}
  }

  const result: Partial<Record<string, Partial<ComponentConfig>>> = {}

  for (const [path, yamlConfig] of Object.entries(componentOverrides)) {
    if (!yamlConfig) continue

    const config: Partial<ComponentConfig> = {}

    if (yamlConfig.model !== undefined) {
      config.modelId = yamlConfig.model
    }

    if (yamlConfig.temperature !== undefined) {
      config.temperature = yamlConfig.temperature
    }

    if (yamlConfig.prompt !== undefined) {
      config.systemPrompt = yamlConfig.prompt
    }

    if (Object.keys(config).length > 0) {
      result[path] = config
    }
  }

  return result
}

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

/**
 * Create an eval config resolver that wraps a base resolver with overrides.
 *
 * @param options Base resolver and optional overrides
 * @returns ConfigResolver that applies overrides to base configs
 *
 * @example Programmatic overrides
 * const resolver = createEvalConfigResolver({
 *   base: createStaticConfigResolver(),
 *   overrides: {
 *     "boundary-extraction": {
 *       modelId: "openrouter:anthropic/claude-haiku-4.5",
 *       temperature: 0.1
 *     }
 *   }
 * })
 *
 * @example From YAML config
 * const resolver = createEvalConfigResolver({
 *   base: createStaticConfigResolver(),
 *   overrides: convertYamlOverrides(ctx.componentOverrides)
 * })
 */
export function createEvalConfigResolver(options: EvalConfigResolverOptions): ConfigResolver {
  const { base, overrides = {} } = options

  return {
    async resolve<T extends AnyComponentConfig = ComponentConfig>(path: string): Promise<T> {
      // Get base config (may throw for unknown paths)
      const baseConfig = await base.resolve<T>(path)

      // Get override for this path
      const override = overrides[path]

      if (!override) {
        return baseConfig
      }

      // Merge override into base (override wins)
      return { ...baseConfig, ...override } as T
    },
  }
}

// -----------------------------------------------------------------------------
// Convenience
// -----------------------------------------------------------------------------

/**
 * Create resolver from YAML componentOverrides.
 *
 * Shorthand for:
 * ```
 * createEvalConfigResolver({
 *   base,
 *   overrides: convertYamlOverrides(componentOverrides)
 * })
 * ```
 */
export function createEvalConfigResolverFromYaml(
  base: ConfigResolver,
  componentOverrides?: ComponentOverrides
): ConfigResolver {
  return createEvalConfigResolver({
    base,
    overrides: convertYamlOverrides(componentOverrides),
  })
}
