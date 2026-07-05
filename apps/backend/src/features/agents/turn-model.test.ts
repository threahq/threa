import { describe, expect, it } from "bun:test"
import { resolveTurnModel } from "./turn-model"
import type { TurnPurpose } from "./turn-purpose"

const SONNET = "openrouter:anthropic/claude-sonnet-4.6"
const OPUS = "openrouter:anthropic/claude-opus-4.8"

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
    ).toEqual({ model: OPUS, escalated: true })
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
