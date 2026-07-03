import { describe, expect, it } from "bun:test"
import { AgentTriggers, type AgentSessionRerunContext } from "@threa/types"
import { resolveTurnPurpose, deriveTurnFlags, type TurnPurpose } from "./turn-purpose"

describe("resolveTurnPurpose", () => {
  it("maps a bare companion payload to catch_up", () => {
    expect(resolveTurnPurpose({})).toEqual({ kind: "catch_up" })
  })

  it("maps a mention payload to mention", () => {
    expect(resolveTurnPurpose({ trigger: AgentTriggers.MENTION })).toEqual({ kind: "mention" })
  })

  it("maps a fired-follow-up payload to follow_up carrying the id", () => {
    expect(resolveTurnPurpose({ followUpId: "agfu_01" })).toEqual({ kind: "follow_up", followUpId: "agfu_01" })
  })

  it("maps a supersede payload to supersede_rerun carrying its rerun context", () => {
    const rerunContext: AgentSessionRerunContext = {
      cause: "invoking_message_edited",
      editedMessageId: "msg_edited",
    }
    expect(resolveTurnPurpose({ supersedesSessionId: "agsess_prev", rerunContext })).toEqual({
      kind: "supersede_rerun",
      supersedesSessionId: "agsess_prev",
      rerunContext,
    })
  })
})

describe("deriveTurnFlags", () => {
  const cases: Array<{ purpose: TurnPurpose; allow: boolean }> = [
    { purpose: { kind: "catch_up" }, allow: false },
    { purpose: { kind: "mention" }, allow: false },
    { purpose: { kind: "follow_up", followUpId: "agfu_01" }, allow: true },
    { purpose: { kind: "supersede_rerun", supersedesSessionId: "agsess_prev" }, allow: true },
  ]

  for (const { purpose, allow } of cases) {
    it(`${purpose.kind} → allowNoMessageOutput=${allow}`, () => {
      expect(deriveTurnFlags(purpose)).toEqual({ allowNoMessageOutput: allow })
    })
  }
})
