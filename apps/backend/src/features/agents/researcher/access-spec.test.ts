import { describe, expect, it } from "bun:test"
import { resolveMemoViewer, type AgentAccessSpec } from "./access-spec"

describe("resolveMemoViewer — user-scoped memo retrieval gate (roadmap 6.4)", () => {
  it("returns the owner id only for a private scratchpad (user_full_access)", () => {
    const spec: AgentAccessSpec = { type: "user_full_access", userId: "usr_owner" }
    expect(resolveMemoViewer(spec)).toBe("usr_owner")
  })

  it("returns undefined for a public context (no private tier retrievable)", () => {
    expect(resolveMemoViewer({ type: "public_only" })).toBeUndefined()
  })

  it("returns undefined for a private channel — other members would see a cited private memo", () => {
    expect(resolveMemoViewer({ type: "public_plus_stream", streamId: "stream_x" })).toBeUndefined()
  })

  it("returns undefined for a two-party DM — the other participant is an audience", () => {
    expect(resolveMemoViewer({ type: "user_intersection", userIds: ["usr_a", "usr_b"] })).toBeUndefined()
  })
})
