import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { modelDisplayName } from "./model-display"

// Vitest runs with `apps/frontend` as the working directory.
const MODELS_YAML = resolve(process.cwd(), "../../packages/agent-runtime/src/ai/models.yaml")

/**
 * Every chat entry in the registry as `[id, name]`. Chat models are the ones
 * that take images and emit text; the embedding and speech-to-text entries are
 * never rendered to a reader, so the derivation makes no claim about them.
 */
function registryChatModels(): Array<[string, string]> {
  const yaml = readFileSync(MODELS_YAML, "utf8")
  const entries: Array<[string, string]> = []
  const blocks = yaml.matchAll(
    /^ {2}([\w-]+:[\w./-]+):\n {4}name: (.+)\n {4}inputModalities: \[([^\]]*)\]\n {4}outputModalities: \[([^\]]*)\]/gm
  )
  for (const [, id, name, inputs, outputs] of blocks) {
    if (!inputs.includes("image") || outputs.trim() !== "text") continue
    entries.push([id, name.trim()])
  }
  return entries
}

describe("modelDisplayName", () => {
  const chatModels = registryChatModels()

  // A silently-empty scan would turn the drift guard below into a no-op.
  it("finds the registry's chat models", () => {
    expect(chatModels.length).toBeGreaterThanOrEqual(10)
  })

  it.each(chatModels)("derives %s as the registry's own name", (id, name) => {
    expect(modelDisplayName(id)).toBe(name)
  })

  it("degrades an unknown id to a readable slug", () => {
    expect(modelDisplayName("openrouter:someone/新-model-9")).toBe("新 Model 9")
  })
})
