import { describe, test, expect } from "bun:test"
import {
  createEvalConfigResolver,
  createEvalConfigResolverFromYaml,
  convertYamlOverrides,
} from "./eval-config-resolver"
import { createStaticConfigResolver } from "../../src/lib/ai/static-config-resolver"
import { COMPONENT_PATHS } from "../../src/lib/ai/config-resolver"

describe("EvalConfigResolver", () => {
  test("should pass through base resolver when no overrides", async () => {
    const base = createStaticConfigResolver()
    const resolver = createEvalConfigResolver({ base })

    const config = await resolver.resolve(COMPONENT_PATHS.BOUNDARY_EXTRACTION)
    expect(config.modelId).toBe("openrouter:openai/gpt-5.4-mini")
    expect(config.temperature).toBe(0.2)
  })

  test("should apply overrides on top of base", async () => {
    const base = createStaticConfigResolver()
    const resolver = createEvalConfigResolver({
      base,
      overrides: {
        "boundary-extraction": {
          modelId: "openrouter:anthropic/claude-haiku-4.5",
          temperature: 0.1,
        },
      },
    })

    const config = await resolver.resolve(COMPONENT_PATHS.BOUNDARY_EXTRACTION)
    expect(config.modelId).toBe("openrouter:anthropic/claude-haiku-4.5")
    expect(config.temperature).toBe(0.1)
    // systemPrompt should still come from base
    expect(config.systemPrompt).toBeDefined()
  })

  test("should throw for unknown paths", async () => {
    const base = createStaticConfigResolver()
    const resolver = createEvalConfigResolver({ base })

    await expect(resolver.resolve("unknown")).rejects.toThrow('Unknown config path: "unknown"')
  })
})

describe("convertYamlOverrides", () => {
  test("should convert YAML field names to ConfigResolver format", () => {
    const yamlOverrides = {
      companion: {
        model: "openrouter:anthropic/claude-sonnet-4.5",
        temperature: 0.8,
        prompt: "You are a helpful assistant",
      },
    }

    const converted = convertYamlOverrides(yamlOverrides)

    expect(converted.companion).toEqual({
      modelId: "openrouter:anthropic/claude-sonnet-4.5",
      temperature: 0.8,
      systemPrompt: "You are a helpful assistant",
    })
  })

  test("should handle partial overrides", () => {
    const yamlOverrides = {
      researcher: {
        model: "openrouter:openai/gpt-5.4-nano",
      },
    }

    const converted = convertYamlOverrides(yamlOverrides)

    expect(converted.researcher).toEqual({
      modelId: "openrouter:openai/gpt-5.4-nano",
    })
  })

  test("should return empty object for undefined input", () => {
    const converted = convertYamlOverrides(undefined)
    expect(converted).toEqual({})
  })

  test("should skip empty configs", () => {
    const yamlOverrides = {
      companion: {},
    }

    const converted = convertYamlOverrides(yamlOverrides)
    expect(converted.companion).toBeUndefined()
  })
})

describe("createEvalConfigResolverFromYaml", () => {
  test("should work with YAML componentOverrides", async () => {
    const base = createStaticConfigResolver()
    const yamlOverrides = {
      "companion:agent": {
        model: "openrouter:anthropic/claude-haiku-4.5",
        temperature: 0.5,
      },
    }

    const resolver = createEvalConfigResolverFromYaml(base, yamlOverrides)

    const config = await resolver.resolve(COMPONENT_PATHS.COMPANION_AGENT)
    expect(config.modelId).toBe("openrouter:anthropic/claude-haiku-4.5")
    expect(config.temperature).toBe(0.5)
  })
})
