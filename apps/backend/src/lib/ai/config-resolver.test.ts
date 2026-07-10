import { describe, test, expect } from "bun:test"
import { createStaticConfigResolver } from "./static-config-resolver"
import { COMPONENT_PATHS } from "./config-resolver"

describe("StaticConfigResolver", () => {
  test("should resolve known component configs", async () => {
    const resolver = createStaticConfigResolver()

    const boundaryConfig = await resolver.resolve(COMPONENT_PATHS.BOUNDARY_EXTRACTION)
    expect(boundaryConfig.modelId).toBe("openrouter:openai/gpt-5.4-mini")
    expect(boundaryConfig.temperature).toBe(0.2)
    expect(boundaryConfig.systemPrompt).toBeDefined()

    const streamNamingConfig = await resolver.resolve(COMPONENT_PATHS.STREAM_NAMING)
    expect(streamNamingConfig.modelId).toBe("openrouter:openai/gpt-5.4-nano")
    expect(streamNamingConfig.temperature).toBe(0.3)

    const memoClassifierConfig = await resolver.resolve(COMPONENT_PATHS.MEMO_CLASSIFIER)
    expect(memoClassifierConfig.modelId).toBe("openrouter:openai/gpt-5.4-mini")
    expect(memoClassifierConfig.temperature).toBe(0.1)

    const memoMemorizerConfig = await resolver.resolve(COMPONENT_PATHS.MEMO_MEMORIZER)
    expect(memoMemorizerConfig.modelId).toBe("openrouter:openai/gpt-5.6-luna")
    expect(memoMemorizerConfig.temperature).toBe(0.3)

    const companionConfig = await resolver.resolve(COMPONENT_PATHS.COMPANION_AGENT)
    expect(companionConfig.modelId).toBe("openrouter:anthropic/claude-sonnet-4.6")
    expect(companionConfig.temperature).toBe(0.7)

    const researcherConfig = await resolver.resolve(COMPONENT_PATHS.COMPANION_RESEARCHER)
    expect(researcherConfig.modelId).toBe("openrouter:anthropic/claude-haiku-4.5")
    expect(researcherConfig.temperature).toBe(0.1)

    const embeddingConfig = await resolver.resolve(COMPONENT_PATHS.EMBEDDING)
    expect(embeddingConfig.modelId).toBe("openrouter:openai/text-embedding-3-small")
  })

  test("should throw for unknown paths", async () => {
    const resolver = createStaticConfigResolver()

    await expect(resolver.resolve("unknown-component")).rejects.toThrow('Unknown config path: "unknown-component"')
  })

  test("should apply overrides", async () => {
    const resolver = createStaticConfigResolver({
      overrides: {
        "boundary-extraction": {
          modelId: "openrouter:anthropic/claude-haiku-4.5",
          temperature: 0.5,
        },
      },
    })

    const config = await resolver.resolve(COMPONENT_PATHS.BOUNDARY_EXTRACTION)
    expect(config.modelId).toBe("openrouter:anthropic/claude-haiku-4.5")
    expect(config.temperature).toBe(0.5)
    // systemPrompt should still be from defaults
    expect(config.systemPrompt).toBeDefined()
  })

  test("should not affect other paths when overriding one path", async () => {
    const resolver = createStaticConfigResolver({
      overrides: {
        "boundary-extraction": { modelId: "custom-model" },
      },
    })

    // Overridden path
    const boundaryConfig = await resolver.resolve(COMPONENT_PATHS.BOUNDARY_EXTRACTION)
    expect(boundaryConfig.modelId).toBe("custom-model")

    // Non-overridden path should have default
    const streamNamingConfig = await resolver.resolve(COMPONENT_PATHS.STREAM_NAMING)
    expect(streamNamingConfig.modelId).toBe("openrouter:openai/gpt-5.4-nano")
  })
})
