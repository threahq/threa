import { describe, expect, it } from "bun:test"
import { AgentTriggers, type AgentSessionRerunContext } from "@threahq/types"
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

  it("maps a persona-draft payload to draft_test carrying the draft id", () => {
    expect(resolveTurnPurpose({ personaDraftId: "pcd_1" })).toEqual({ kind: "draft_test", draftId: "pcd_1" })
  })

  it("orders draft_test above mention but below follow_up and supersede", () => {
    // A follow-up firing in a test stream is still a follow-up.
    expect(resolveTurnPurpose({ personaDraftId: "pcd_1", followUpId: "agfu_01" })).toEqual({
      kind: "follow_up",
      followUpId: "agfu_01",
    })
    // A supersede rerun in a test stream is still a supersede rerun.
    expect(resolveTurnPurpose({ personaDraftId: "pcd_1", supersedesSessionId: "agsess_prev" })).toEqual({
      kind: "supersede_rerun",
      supersedesSessionId: "agsess_prev",
      rerunContext: undefined,
    })
    // A plain companion message in a test stream runs the draft, over mention.
    expect(resolveTurnPurpose({ personaDraftId: "pcd_1", trigger: AgentTriggers.MENTION })).toEqual({
      kind: "draft_test",
      draftId: "pcd_1",
    })
  })
})

describe("deriveTurnFlags", () => {
  const cases: Array<{ purpose: TurnPurpose; allow: boolean }> = [
    { purpose: { kind: "catch_up" }, allow: false },
    { purpose: { kind: "mention" }, allow: false },
    { purpose: { kind: "follow_up", followUpId: "agfu_01" }, allow: true },
    { purpose: { kind: "supersede_rerun", supersedesSessionId: "agsess_prev" }, allow: true },
    // Draft-test behaves like catch_up: it replies normally, no silent-end flag.
    { purpose: { kind: "draft_test", draftId: "pcd_1" }, allow: false },
  ]

  for (const { purpose, allow } of cases) {
    it(`${purpose.kind} → allowNoMessageOutput=${allow}`, () => {
      expect(deriveTurnFlags(purpose)).toEqual({ allowNoMessageOutput: allow })
    })
  }
})
