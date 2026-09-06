/**
 * The three layers that decide what a subagent may run on, and the catalog the
 * pickers offer. The layering rule is the product decision worth pinning: a
 * user narrows, never widens.
 */

import { describe, expect, test } from "bun:test"
import { createModelRegistry } from "@threahq/agent-runtime"
import { DEFAULT_SUBAGENT_MODELS, SUBAGENT_MODEL_CATALOG } from "@threahq/types"
import { resolveSubagentModels } from "./models"

const registry = createModelRegistry()

const TERRA = "openrouter:openai/gpt-5.6-terra"
const SONNET = "openrouter:anthropic/claude-sonnet-5"
const OPUS = "openrouter:anthropic/claude-opus-5"
const UNKNOWN = "openrouter:nobody/never-shipped"

function resolve(workspace: string[], user?: string[]) {
  return resolveSubagentModels({
    workspaceSettings: { subagentModels: workspace },
    userPreferences: user ? { subagentModels: user } : null,
    modelRegistry: registry,
  })
}

describe("resolveSubagentModels", () => {
  test("no user preference resolves to the workspace set, in the admin's order", () => {
    expect(resolve([SONNET, TERRA])).toEqual([SONNET, TERRA])
  })

  test("an empty user list is 'no narrowing', not 'nothing allowed'", () => {
    expect(resolve([SONNET, TERRA], [])).toEqual([SONNET, TERRA])
  })

  test("a user list narrows the workspace set and keeps the workspace's order", () => {
    expect(resolve([SONNET, TERRA], [TERRA])).toEqual([TERRA])
  })

  test("a user cannot buy a model the workspace withheld", () => {
    expect(resolve([TERRA], [OPUS, TERRA])).toEqual([TERRA])
    expect(resolve([TERRA], [OPUS])).toEqual([])
  })

  test("a model the registry does not serve drops out before either policy layer sees it", () => {
    expect(resolve([UNKNOWN, TERRA], [UNKNOWN, TERRA])).toEqual([TERRA])
  })
})

describe("SUBAGENT_MODEL_CATALOG", () => {
  test("every offered model is a chat model the registry actually serves", () => {
    const notServed = SUBAGENT_MODEL_CATALOG.filter((entry) => !registry.isChatModel(entry.id))
    expect(notServed).toEqual([])
  })

  test("the shipped default set is exactly the catalog's default-enabled entries", () => {
    expect(DEFAULT_SUBAGENT_MODELS).toEqual([TERRA, SONNET])
  })

  test("premium tiers are opt-in — none of them is on by default", () => {
    expect(SUBAGENT_MODEL_CATALOG.filter((entry) => entry.tier === "premium" && entry.defaultEnabled)).toEqual([])
  })
})
