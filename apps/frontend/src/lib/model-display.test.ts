import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { modelDisplayName } from "./model-display"

// Vitest runs with `apps/frontend` as the working directory.
const MODELS_YAML = resolve(process.cwd(), "../../packages/agent-runtime/src/ai/models.yaml")

/**
 * Every entry a reader is ever shown a name for, as `[id, name]`: the models the
 * persona picker offers. Excluded are the two kinds nothing renders — the
 * embedding entry (emits vectors, not text) and the speech-to-text entries
 * (audio in), which are vendor-branded and would hold this derivation to names
 * no slug carries.
 */
function registryChatModels(): Array<[string, string]> {
  const yaml = readFileSync(MODELS_YAML, "utf8")
  const entries: Array<[string, string]> = []
  const blocks = yaml.matchAll(
    /^ {2}([\w-]+:[\w./-]+):\n {4}name: (.+)\n {4}inputModalities: \[([^\]]*)\]\n {4}outputModalities: \[([^\]]*)\]/gm
  )
  for (const [, id, name, inputs, outputs] of blocks) {
    if (outputs.trim() !== "text" || inputs.includes("audio")) continue
    entries.push([id, name.trim()])
  }
  return entries
}

describe("modelDisplayName", () => {
  const chatModels = registryChatModels()

  // A silently-empty scan would turn the drift guard below into a no-op.
  it("finds the registry's named models", () => {
    expect(chatModels.length).toBeGreaterThanOrEqual(10)
  })

  it.each(chatModels)("derives %s as the registry's own name", (id, name) => {
    expect(modelDisplayName(id)).toBe(name)
  })

  it("degrades an unknown id to a readable slug", () => {
    expect(modelDisplayName("openrouter:someone/新-model-9")).toBe("新 Model 9")
  })
})
