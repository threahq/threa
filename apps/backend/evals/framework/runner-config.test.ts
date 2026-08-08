import { describe, expect, test } from "bun:test"
import { getPrimaryComponentOverride } from "./runner"

describe("config runner primary override", () => {
  test("selects the suite component independent of YAML key order", () => {
    const components = {
      researcher: { model: "openrouter:openai/gpt-5.4-mini" },
      companion: { model: "openrouter:anthropic/claude-sonnet-4.6" },
    }
    expect(getPrimaryComponentOverride("companion", components)?.model).toBe("openrouter:anthropic/claude-sonnet-4.6")
  })

  test("uses explicit companion fallback only for companion-backed suites", () => {
    const components = { companion: { model: "openrouter:openai/gpt-5.4-mini" } }
    expect(getPrimaryComponentOverride("persona-style", components)?.model).toBe("openrouter:openai/gpt-5.4-mini")
    expect(getPrimaryComponentOverride("brief-correction", components)?.model).toBe("openrouter:openai/gpt-5.4-mini")
    expect(getPrimaryComponentOverride("multimodal-vision", components)?.model).toBe("openrouter:openai/gpt-5.4-mini")
    expect(getPrimaryComponentOverride("stream-naming", components)).toBeUndefined()
  })
})
