import { describe, expect, it } from "bun:test"
import {
  DELEGATION_STATUSES,
  DELEGATION_TERMINAL_STATUSES,
  FOLLOW_UP_STATUSES,
  FOLLOW_UP_TERMINAL_STATUSES,
} from "./constants"
import { AGENT_OUTCOME_KINDS, AGENT_OUTCOME_STATES } from "./agent-outcomes"

describe("agent outcome constants", () => {
  it("keeps both terminal sets a subset of their status list", () => {
    expect([...FOLLOW_UP_STATUSES]).toEqual(expect.arrayContaining([...FOLLOW_UP_TERMINAL_STATUSES]))
    expect([...DELEGATION_STATUSES]).toEqual(expect.arrayContaining([...DELEGATION_TERMINAL_STATUSES]))
  })

  it("leaves exactly the in-flight statuses outstanding", () => {
    const outstanding = FOLLOW_UP_STATUSES.filter(
      (status) => !(FOLLOW_UP_TERMINAL_STATUSES as readonly string[]).includes(status)
    )
    expect(outstanding).toEqual(["pending"])

    const outstandingDelegations = DELEGATION_STATUSES.filter(
      (status) => !(DELEGATION_TERMINAL_STATUSES as readonly string[]).includes(status)
    )
    expect(outstandingDelegations).toEqual(["open", "claimed", "running", "expired"])
  })

  it("enumerates the kinds and states the endpoint accepts", () => {
    expect(AGENT_OUTCOME_KINDS).toEqual(["follow_up", "delegation", "subagent"])
    expect(AGENT_OUTCOME_STATES).toEqual(["outstanding", "settled", "all"])
  })
})
