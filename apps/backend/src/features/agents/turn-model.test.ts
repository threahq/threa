import { describe, expect, it } from "bun:test"
import { createModelRegistry } from "@threahq/agent-runtime"
import { fallbackModelFor, resolveTurnModel, type TurnModelContext } from "./turn-model"
import type { TurnPurpose } from "./turn-purpose"

const SONNET = "openrouter:anthropic/claude-sonnet-4.6"
const OPUS = "openrouter:anthropic/claude-opus-4.8"
const TERRA = "openrouter:openai/gpt-5.6-terra"

const SAVANT = "subq:subq-savant-1.4"
const HAIKU = "openrouter:anthropic/claude-haiku-5.5"
const LUNA = "openrouter:openai/gpt-6-luna"

const persona = { model: SONNET, escalationModel: OPUS }
const unpinned = {
  residencyPinned: false,
  isSingleRegion: () => false,
  canRunModel: () => true,
  providerFailedModel: null,
}
const supersede: TurnPurpose = { kind: "supersede_rerun", supersedesSessionId: "agsess_prev" }

describe("resolveTurnModel", () => {
  const nonEscalatingPurposes: TurnPurpose[] = [
    { kind: "catch_up" },
    { kind: "mention" },
    { kind: "follow_up", followUpId: "agfu_01" },
  ]

  for (const purpose of nonEscalatingPurposes) {
    it(`${purpose.kind} always runs persona.model`, () => {
      expect(resolveTurnModel(persona, { purpose, supersededSession: null, ...unpinned })).toEqual({
        model: SONNET,
        escalated: false,
      })
    })
  }

  it("supersede rerun without a validation failure runs persona.model", () => {
    expect(
      resolveTurnModel(persona, {
        purpose: supersede,
        supersededSession: { responseValidationFailed: false },
        ...unpinned,
      })
    ).toEqual({ model: SONNET, escalated: false })
  })

  it("supersede rerun whose previous attempt failed validation escalates", () => {
    expect(
      resolveTurnModel(persona, {
        purpose: supersede,
        supersededSession: { responseValidationFailed: true },
        ...unpinned,
      })
    ).toEqual({ model: OPUS, escalated: true, fromModel: SONNET, cause: "previous_attempt_failed_validation" })
  })

  it("a turn inside a live subagent thread runs the run's delegated model", () => {
    expect(
      resolveTurnModel(persona, {
        purpose: { kind: "subagent_kickoff", subagentRunId: "subagent_01" },
        supersededSession: null,
        activeSubagentModel: TERRA,
        ...unpinned,
      })
    ).toEqual({ model: TERRA, escalated: true, fromModel: SONNET, cause: "subagent" })
  })

  it("a later reply turn in the same thread resolves the same delegated model", () => {
    expect(
      resolveTurnModel(persona, {
        purpose: { kind: "catch_up" },
        supersededSession: null,
        activeSubagentModel: TERRA,
        ...unpinned,
      })
    ).toEqual({ model: TERRA, escalated: true, fromModel: SONNET, cause: "subagent" })
  })

  it("the subagent binding wins over the supersede escalation", () => {
    expect(
      resolveTurnModel(persona, {
        purpose: supersede,
        supersededSession: { responseValidationFailed: true },
        activeSubagentModel: TERRA,
        ...unpinned,
      })
    ).toEqual({ model: TERRA, escalated: true, fromModel: SONNET, cause: "subagent" })
  })

  it("a delegated model equal to persona.model is not a no-op escalation", () => {
    expect(
      resolveTurnModel(persona, {
        purpose: { kind: "subagent_kickoff", subagentRunId: "subagent_01" },
        supersededSession: null,
        activeSubagentModel: SONNET,
        ...unpinned,
      })
    ).toEqual({ model: SONNET, escalated: false })
  })

  it("a settled run (no active model) falls back to persona.model", () => {
    expect(
      resolveTurnModel(persona, {
        purpose: { kind: "catch_up" },
        supersededSession: null,
        activeSubagentModel: null,
        ...unpinned,
      })
    ).toEqual({ model: SONNET, escalated: false })
  })

  it("does not escalate without an escalationModel", () => {
    expect(
      resolveTurnModel(
        { model: SONNET, escalationModel: null },
        { purpose: supersede, supersededSession: { responseValidationFailed: true }, ...unpinned }
      )
    ).toEqual({ model: SONNET, escalated: false })
  })

  it("does not report a no-op escalation when escalationModel equals model", () => {
    expect(
      resolveTurnModel(
        { model: SONNET, escalationModel: SONNET },
        { purpose: supersede, supersededSession: { responseValidationFailed: true }, ...unpinned }
      )
    ).toEqual({ model: SONNET, escalated: false })
  })

  it("supersede rerun with no loaded superseded session runs persona.model", () => {
    expect(resolveTurnModel(persona, { purpose: supersede, supersededSession: null, ...unpinned })).toEqual({
      model: SONNET,
      escalated: false,
    })
  })
})

describe("resolveTurnModel residency", () => {
  const isSingleRegion = (model: string) => model === SAVANT
  const rules: {
    name: string
    persona: { model: string; escalationModel: string | null }
    context: Omit<TurnModelContext, "residencyPinned" | "isSingleRegion" | "canRunModel" | "providerFailedModel">
    chosen: string
    pinnedRuns: string
  }[] = [
    {
      name: "persona model",
      persona: { model: SAVANT, escalationModel: OPUS },
      context: { purpose: { kind: "mention" }, supersededSession: null },
      chosen: SAVANT,
      pinnedRuns: HAIKU,
    },
    {
      name: "escalation model",
      persona: { model: SONNET, escalationModel: SAVANT },
      context: { purpose: supersede, supersededSession: { responseValidationFailed: true } },
      chosen: SAVANT,
      pinnedRuns: SONNET,
    },
    {
      name: "subagent model",
      persona,
      context: { purpose: { kind: "catch_up" }, supersededSession: null, activeSubagentModel: SAVANT },
      chosen: SAVANT,
      pinnedRuns: persona.model,
    },
  ]

  for (const rule of rules) {
    it(`pinned: a single-region ${rule.name} gives way to the persona's model, or the fallback when that is it`, () => {
      expect(
        resolveTurnModel(rule.persona, {
          ...rule.context,
          residencyPinned: true,
          isSingleRegion,
          canRunModel: () => true,
          providerFailedModel: null,
        })
      ).toEqual({
        model: rule.pinnedRuns,
        escalated: true,
        fromModel: rule.chosen,
        cause: "residency_pinned",
      })
    })

    it(`unpinned: a single-region ${rule.name} runs as chosen`, () => {
      expect(
        resolveTurnModel(rule.persona, {
          ...rule.context,
          residencyPinned: false,
          isSingleRegion,
          canRunModel: () => true,
          providerFailedModel: null,
        }).model
      ).toBe(rule.chosen)
    })
  }

  it("pinned: a single-region escalation model on a single-region persona model runs the fallback", () => {
    expect(
      resolveTurnModel(
        { model: OPUS, escalationModel: SAVANT },
        {
          purpose: supersede,
          supersededSession: { responseValidationFailed: true },
          residencyPinned: true,
          isSingleRegion: (model) => model === SAVANT || model === OPUS,
          canRunModel: () => true,
          providerFailedModel: null,
        }
      )
    ).toEqual({ model: HAIKU, escalated: true, fromModel: SAVANT, cause: "residency_pinned" })
  })

  it("pinned: a regionally-runnable model is untouched", () => {
    expect(
      resolveTurnModel(persona, {
        purpose: { kind: "mention" },
        supersededSession: null,
        residencyPinned: true,
        isSingleRegion,
        canRunModel: () => true,
        providerFailedModel: null,
      })
    ).toEqual({ model: SONNET, escalated: false })
  })

  it("replacing the primary fallback picks the secondary", () => {
    expect(
      resolveTurnModel(
        { model: HAIKU, escalationModel: null },
        {
          purpose: { kind: "mention" },
          supersededSession: null,
          residencyPinned: true,
          isSingleRegion: () => true,
          canRunModel: () => true,
          providerFailedModel: null,
        }
      )
    ).toEqual({ model: LUNA, escalated: true, fromModel: HAIKU, cause: "residency_pinned" })
  })
})

describe("resolveTurnModel provider failure", () => {
  const isSingleRegion = (model: string) => model === SAVANT
  const mention = { purpose: { kind: "mention" } as TurnPurpose, supersededSession: null }
  const cases: {
    name: string
    persona: { model: string; escalationModel: string | null }
    residencyPinned: boolean
    providerFailedModel: string | null
    expected: ReturnType<typeof resolveTurnModel>
  }[] = [
    {
      name: "should run the chosen model when no attempt failed on a provider",
      persona,
      residencyPinned: false,
      providerFailedModel: null,
      expected: { model: SONNET, escalated: false },
    },
    {
      name: "should run the fallback when the chosen model's provider failed",
      persona,
      residencyPinned: false,
      providerFailedModel: SONNET,
      expected: { model: HAIKU, escalated: true, fromModel: SONNET, cause: "provider_failed" },
    },
    {
      name: "should run the chosen model again when the fallback's provider failed",
      persona,
      residencyPinned: false,
      providerFailedModel: HAIKU,
      expected: { model: SONNET, escalated: false },
    },
    {
      name: "should run the secondary fallback when the chosen model is the primary fallback and failed",
      persona: { model: HAIKU, escalationModel: null },
      residencyPinned: false,
      providerFailedModel: HAIKU,
      expected: { model: LUNA, escalated: true, fromModel: HAIKU, cause: "provider_failed" },
    },
    {
      name: "should run the single-region model's fallback when it failed in an unpinned workspace",
      persona: { model: SAVANT, escalationModel: null },
      residencyPinned: false,
      providerFailedModel: SAVANT,
      expected: { model: HAIKU, escalated: true, fromModel: SAVANT, cause: "provider_failed" },
    },
    {
      name: "should run the residency fallback's fallback when the residency fallback failed",
      persona: { model: SAVANT, escalationModel: null },
      residencyPinned: true,
      providerFailedModel: HAIKU,
      expected: { model: LUNA, escalated: true, fromModel: HAIKU, cause: "provider_failed" },
    },
    {
      name: "should return to the residency fallback when its fallback failed",
      persona: { model: SAVANT, escalationModel: null },
      residencyPinned: true,
      providerFailedModel: LUNA,
      expected: { model: HAIKU, escalated: true, fromModel: SAVANT, cause: "residency_pinned" },
    },
    {
      name: "should keep the residency fallback when the single-region model is the one recorded as failed",
      persona: { model: SAVANT, escalationModel: null },
      residencyPinned: true,
      providerFailedModel: SAVANT,
      expected: { model: HAIKU, escalated: true, fromModel: SAVANT, cause: "residency_pinned" },
    },
  ]

  for (const c of cases) {
    it(c.name, () => {
      expect(
        resolveTurnModel(c.persona, {
          ...mention,
          residencyPinned: c.residencyPinned,
          isSingleRegion,
          canRunModel: () => true,
          providerFailedModel: c.providerFailedModel,
        })
      ).toEqual(c.expected)
    })
  }

  it("should fall back from the delegated model when a subagent turn's provider failed", () => {
    expect(
      resolveTurnModel(persona, {
        ...unpinned,
        purpose: { kind: "catch_up" },
        supersededSession: null,
        activeSubagentModel: TERRA,
        providerFailedModel: TERRA,
      })
    ).toEqual({ model: HAIKU, escalated: true, fromModel: TERRA, cause: "provider_failed" })
  })

  it("should never run a single-region model in a pinned workspace whatever failed", () => {
    const models = [SAVANT, SONNET, OPUS, HAIKU, LUNA]
    const chosen = models.flatMap((model) =>
      [null, ...models].flatMap((providerFailedModel) =>
        [null, SAVANT].map(
          (activeSubagentModel) =>
            resolveTurnModel(
              { model, escalationModel: SAVANT },
              {
                purpose: supersede,
                supersededSession: { responseValidationFailed: true },
                activeSubagentModel,
                residencyPinned: true,
                isSingleRegion,
                canRunModel: () => true,
                providerFailedModel,
              }
            ).model
        )
      )
    )
    expect(chosen.filter(isSingleRegion)).toEqual([])
  })
})

describe("resolveTurnModel on a deployment without the model's provider", () => {
  const canRunModel = (model: string) => model !== SAVANT
  const context = { purpose: { kind: "mention" } as TurnPurpose, supersededSession: null, isSingleRegion: () => false }

  it("should run the fallback for a model the deployment cannot run", () => {
    expect(
      resolveTurnModel(
        { model: SAVANT, escalationModel: null },
        { ...context, residencyPinned: false, canRunModel, providerFailedModel: null }
      )
    ).toEqual({ model: HAIKU, escalated: true, fromModel: SAVANT, cause: "model_unavailable" })
  })

  it("should leave a model the deployment can run untouched", () => {
    expect(
      resolveTurnModel(persona, { ...context, residencyPinned: false, canRunModel, providerFailedModel: null })
    ).toEqual({ model: SONNET, escalated: false })
  })
})

describe("fallbackModelFor", () => {
  it("should only fall back to registered models that run regionally", () => {
    const registry = createModelRegistry()
    const fallbacks = [fallbackModelFor(SAVANT), fallbackModelFor(HAIKU)]
    expect(
      fallbacks.map((model) => ({
        model,
        known: registry.getCapabilities(model) !== undefined,
        singleRegion: registry.isSingleRegion(model),
      }))
    ).toEqual([
      { model: HAIKU, known: true, singleRegion: false },
      { model: LUNA, known: true, singleRegion: false },
    ])
  })
})
