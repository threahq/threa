import { describe, expect, it } from "bun:test"
import { resolveTurnModel } from "./turn-model"
import type { TurnPurpose } from "./turn-purpose"

const SONNET = "openrouter:anthropic/claude-sonnet-4.6"
const OPUS = "openrouter:anthropic/claude-opus-4.8"
const TERRA = "openrouter:openai/gpt-5.6-terra"

const persona = { model: SONNET, escalationModel: OPUS }
const supersede: TurnPurpose = { kind: "supersede_rerun", supersedesSessionId: "agsess_prev" }

describe("resolveTurnModel", () => {
  const nonEscalatingPurposes: TurnPurpose[] = [
    { kind: "catch_up" },
    { kind: "mention" },
    { kind: "follow_up", followUpId: "agfu_01" },
  ]

  for (const purpose of nonEscalatingPurposes) {
    it(`${purpose.kind} always runs persona.model`, () => {
      expect(resolveTurnModel(persona, { purpose, supersededSession: null })).toEqual({
        model: SONNET,
        escalated: false,
      })
    })
  }

  it("supersede rerun without a validation failure runs persona.model", () => {
    expect(
      resolveTurnModel(persona, { purpose: supersede, supersededSession: { responseValidationFailed: false } })
    ).toEqual({ model: SONNET, escalated: false })
  })

  it("supersede rerun whose previous attempt failed validation escalates", () => {
    expect(
      resolveTurnModel(persona, { purpose: supersede, supersededSession: { responseValidationFailed: true } })
    ).toEqual({ model: OPUS, escalated: true, cause: "previous_attempt_failed_validation" })
  })

  it("a turn inside a live subagent thread runs the run's delegated model", () => {
    expect(
      resolveTurnModel(persona, {
        purpose: { kind: "subagent_kickoff", subagentRunId: "subagent_01" },
        supersededSession: null,
        activeSubagentModel: TERRA,
      })
    ).toEqual({ model: TERRA, escalated: true, cause: "subagent" })
  })

  it("a later reply turn in the same thread resolves the same delegated model", () => {
    expect(
      resolveTurnModel(persona, {
        purpose: { kind: "catch_up" },
        supersededSession: null,
        activeSubagentModel: TERRA,
      })
    ).toEqual({ model: TERRA, escalated: true, cause: "subagent" })
  })

  it("the subagent binding wins over the supersede escalation", () => {
    expect(
      resolveTurnModel(persona, {
        purpose: supersede,
        supersededSession: { responseValidationFailed: true },
        activeSubagentModel: TERRA,
      })
    ).toEqual({ model: TERRA, escalated: true, cause: "subagent" })
  })

  it("a delegated model equal to persona.model is not a no-op escalation", () => {
    expect(
      resolveTurnModel(persona, {
        purpose: { kind: "subagent_kickoff", subagentRunId: "subagent_01" },
        supersededSession: null,
        activeSubagentModel: SONNET,
      })
    ).toEqual({ model: SONNET, escalated: false })
  })

  it("a settled run (no active model) falls back to persona.model", () => {
    expect(
      resolveTurnModel(persona, {
        purpose: { kind: "catch_up" },
        supersededSession: null,
        activeSubagentModel: null,
      })
    ).toEqual({ model: SONNET, escalated: false })
  })

  it("does not escalate without an escalationModel", () => {
    expect(
      resolveTurnModel(
        { model: SONNET, escalationModel: null },
        { purpose: supersede, supersededSession: { responseValidationFailed: true } }
      )
    ).toEqual({ model: SONNET, escalated: false })
  })

  it("does not report a no-op escalation when escalationModel equals model", () => {
    expect(
      resolveTurnModel(
        { model: SONNET, escalationModel: SONNET },
        { purpose: supersede, supersededSession: { responseValidationFailed: true } }
      )
    ).toEqual({ model: SONNET, escalated: false })
  })

  it("supersede rerun with no loaded superseded session runs persona.model", () => {
    expect(resolveTurnModel(persona, { purpose: supersede, supersededSession: null })).toEqual({
      model: SONNET,
      escalated: false,
    })
  })
})
