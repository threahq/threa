import { describe, expect, it } from "bun:test"
import { resolveMemoViewer, type AgentAccessSpec } from "./access-spec"

describe("resolveMemoViewer — user-scoped memo retrieval gate (roadmap 6.4)", () => {
  it("returns the owner id only for a private scratchpad (user_full_access)", () => {
    const spec: AgentAccessSpec = { type: "user_full_access", userId: "usr_owner" }
    expect(resolveMemoViewer(spec)).toBe("usr_owner")
  })

  it("returns undefined for a channel — other members would see a cited private memo", () => {
    expect(resolveMemoViewer({ type: "room_readable", roomStreamId: "stream_room" })).toBeUndefined()
  })

  it("returns undefined for a two-party DM — the other participant is an audience", () => {
    expect(resolveMemoViewer({ type: "user_intersection", userIds: ["usr_a", "usr_b"] })).toBeUndefined()
  })
})
