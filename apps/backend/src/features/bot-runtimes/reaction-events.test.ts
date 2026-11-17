import { describe, expect, it } from "bun:test"
import type { BotInvocationReactionEvent } from "@threahq/types"
import { parseReactionEvents, planReactionChange, type ReactionChange } from "./reaction-events"

const event = (action: "added" | "removed", emoji = ":+1:", reactorId = "usr_1"): BotInvocationReactionEvent => ({
  action,
  emoji,
  reactorId,
  reactorName: null,
})
const change = (action: "added" | "removed", emoji = ":+1:", reactorId = "usr_1"): ReactionChange => ({
  action,
  emoji,
  reactorId,
})
const pending = (...events: BotInvocationReactionEvent[]) => ({ id: "inv_pending", events })

describe("planReactionChange", () => {
  it("starts an invocation for an add the agent has no history of", () => {
    expect(planReactionChange([], null, change("added"))).toEqual({ kind: "insert" })
  })

  it("appends an add to the pending invocation", () => {
    expect(planReactionChange([], pending(event("added", ":heart:")), change("added"))).toEqual({
      kind: "replace",
      invocationId: "inv_pending",
      retained: [event("added", ":heart:")],
      append: true,
    })
  })

  it("drops an add the agent already has, whether delivered or pending", () => {
    expect(planReactionChange([event("added")], null, change("added"))).toEqual({ kind: "unchanged" })
    expect(planReactionChange([], pending(event("added")), change("added"))).toEqual({ kind: "unchanged" })
  })

  it("tells the agent about a re-add after a delivered removal", () => {
    expect(planReactionChange([event("added"), event("removed")], null, change("added"))).toEqual({ kind: "insert" })
  })

  it("cancels the pending invocation when its only add is removed", () => {
    expect(planReactionChange([], pending(event("added")), change("removed"))).toEqual({
      kind: "cancel",
      invocationId: "inv_pending",
    })
  })

  it("withdraws just the removed add and keeps the rest pending", () => {
    expect(planReactionChange([], pending(event("added"), event("added", ":heart:")), change("removed"))).toEqual({
      kind: "replace",
      invocationId: "inv_pending",
      retained: [event("added", ":heart:")],
      append: false,
    })
  })

  it("reports a removal of a delivered add, appending to a pending invocation when there is one", () => {
    expect(planReactionChange([event("added")], null, change("removed"))).toEqual({ kind: "insert" })
    expect(planReactionChange([event("added")], pending(event("added", ":heart:")), change("removed"))).toEqual({
      kind: "replace",
      invocationId: "inv_pending",
      retained: [event("added", ":heart:")],
      append: true,
    })
  })

  it("withdraws a pending removal when the delivered reaction is added back", () => {
    expect(planReactionChange([event("added")], pending(event("removed")), change("added"))).toEqual({
      kind: "cancel",
      invocationId: "inv_pending",
    })
    expect(
      planReactionChange([event("added")], pending(event("added", ":heart:"), event("removed")), change("added"))
    ).toEqual({ kind: "replace", invocationId: "inv_pending", retained: [event("added", ":heart:")], append: false })
  })

  it("ignores a removal of a reaction the agent never heard of or was already told is gone", () => {
    expect(planReactionChange([], null, change("removed"))).toEqual({ kind: "unchanged" })
    expect(planReactionChange([event("added"), event("removed")], null, change("removed"))).toEqual({
      kind: "unchanged",
    })
  })

  it("keeps reactors and emoji apart", () => {
    expect(planReactionChange([event("added", ":+1:", "usr_2")], null, change("added"))).toEqual({ kind: "insert" })
    expect(planReactionChange([event("added", ":heart:")], null, change("removed"))).toEqual({ kind: "unchanged" })
  })
})

describe("parseReactionEvents", () => {
  it("fails loudly on metadata the backend did not write", () => {
    expect(() => parseReactionEvents({})).toThrow()
  })
})
