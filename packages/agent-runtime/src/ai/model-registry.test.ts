import { describe, test, expect } from "bun:test"
import { createModelRegistry } from "./model-registry"

describe("ModelRegistry", () => {
  const registry = createModelRegistry()

  describe("getCapabilities", () => {
    test("returns capabilities for registered vision model", () => {
      const caps = registry.getCapabilities("openrouter:anthropic/claude-sonnet-4.5")

      expect(caps).toMatchObject({
        name: "Claude Sonnet 4.5",
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
      })
    })

    test("returns capabilities for text-only model", () => {
      const caps = registry.getCapabilities("openrouter:openai/gpt-oss-120b")

      expect(caps).toMatchObject({
        name: "GPT-OSS 120B",
        inputModalities: ["text"],
        outputModalities: ["text"],
      })
    })

    test("returns capabilities for embedding model", () => {
      const caps = registry.getCapabilities("openrouter:openai/text-embedding-3-small")

      expect(caps).toMatchObject({
        name: "Text Embedding 3 Small",
        inputModalities: ["text"],
        outputModalities: ["embedding"],
      })
    })

    test("returns undefined for unknown model", () => {
      const caps = registry.getCapabilities("openrouter:unknown/model")

      expect(caps).toBeUndefined()
    })
  })

  describe("supportsVision", () => {
    test("returns true for models with image input modality", () => {
      expect(registry.supportsVision("openrouter:anthropic/claude-sonnet-4.5")).toBe(true)
      expect(registry.supportsVision("openrouter:anthropic/claude-haiku-4.5")).toBe(true)
      expect(registry.supportsVision("openrouter:google/gemini-2.5-flash")).toBe(true)
      expect(registry.supportsVision("openrouter:openai/gpt-5")).toBe(true)
      expect(registry.supportsVision("openrouter:openai/gpt-5-mini")).toBe(true)
    })

    test("returns false for text-only models", () => {
      expect(registry.supportsVision("openrouter:openai/gpt-oss-120b")).toBe(false)
      expect(registry.supportsVision("openrouter:openai/gpt-5-nano")).toBe(false)
      expect(registry.supportsVision("openrouter:openai/text-embedding-3-small")).toBe(false)
    })

    test("returns false for unknown models", () => {
      expect(registry.supportsVision("openrouter:unknown/model")).toBe(false)
    })
  })

  describe("supportsInputModality", () => {
    test("returns true when model supports the modality", () => {
      expect(registry.supportsInputModality("openrouter:anthropic/claude-sonnet-4.5", "text")).toBe(true)
      expect(registry.supportsInputModality("openrouter:anthropic/claude-sonnet-4.5", "image")).toBe(true)
    })

    test("returns false when model does not support the modality", () => {
      expect(registry.supportsInputModality("openrouter:openai/gpt-oss-120b", "image")).toBe(false)
    })

    test("returns false for unknown models", () => {
      expect(registry.supportsInputModality("openrouter:unknown/model", "text")).toBe(false)
    })
  })

  describe("supportsOutputModality", () => {
    test("returns true for text output on language models", () => {
      expect(registry.supportsOutputModality("openrouter:anthropic/claude-sonnet-4.5", "text")).toBe(true)
    })

    test("returns true for embedding output on embedding models", () => {
      expect(registry.supportsOutputModality("openrouter:openai/text-embedding-3-small", "embedding")).toBe(true)
    })

    test("returns false for embedding output on language models", () => {
      expect(registry.supportsOutputModality("openrouter:anthropic/claude-sonnet-4.5", "embedding")).toBe(false)
    })

    test("returns false for text output on embedding models", () => {
      expect(registry.supportsOutputModality("openrouter:openai/text-embedding-3-small", "text")).toBe(false)
    })

    test("returns false for unknown models", () => {
      expect(registry.supportsOutputModality("openrouter:unknown/model", "text")).toBe(false)
    })
  })

  describe("getModelIds", () => {
    test("returns all registered model IDs", () => {
      const modelIds = registry.getModelIds()

      expect(modelIds).toContain("openrouter:anthropic/claude-sonnet-4.5")
      expect(modelIds).toContain("openrouter:anthropic/claude-haiku-4.5")
      expect(modelIds).toContain("openrouter:openai/gpt-oss-120b")
      expect(modelIds).toContain("openrouter:openai/text-embedding-3-small")
      expect(modelIds.length).toBeGreaterThan(5)
    })
  })
})
