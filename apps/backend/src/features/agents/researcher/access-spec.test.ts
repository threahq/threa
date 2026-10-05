import { describe, expect, it } from "bun:test"
import { memoAudienceForSpec, resolveMemoViewer, resolvePeopleViewer, type AgentAccessSpec } from "./access-spec"

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

describe("resolvePeopleViewer — whose people an agent turn may search", () => {
  it("gives a private scratchpad the invoker's own view", () => {
    expect(resolvePeopleViewer({ type: "user_full_access", userId: "usr_owner" }, "stream_pad")).toEqual({
      kind: "user",
      userId: "usr_owner",
    })
  })

  it("gives a channel the view of its room, resolved from whichever stream the turn runs in", () => {
    expect(resolvePeopleViewer({ type: "room_readable", roomStreamId: "stream_room" }, "stream_thread")).toEqual({
      kind: "room",
      roomStreamId: "stream_thread",
    })
  })

  it("gives a two-party DM the view of its room, since the other participant is an audience", () => {
    expect(resolvePeopleViewer({ type: "user_intersection", userIds: ["usr_a", "usr_b"] }, "stream_dm")).toEqual({
      kind: "room",
      roomStreamId: "stream_dm",
    })
  })
})

describe("memoAudienceForSpec — who reads what an agent turn retrieves", () => {
  it("should make the invoker the audience when the spec is a private scratchpad", () => {
    expect(memoAudienceForSpec({ type: "user_full_access", userId: "usr_owner" })).toEqual({
      kind: "users",
      userIds: ["usr_owner"],
    })
  })

  it("should make both participants the audience when the spec is a DM", () => {
    expect(memoAudienceForSpec({ type: "user_intersection", userIds: ["usr_a", "usr_b"] })).toEqual({
      kind: "users",
      userIds: ["usr_a", "usr_b"],
    })
  })

  it("should make the room the audience when the spec is a channel, by the spec's effective root", () => {
    expect(memoAudienceForSpec({ type: "room_readable", roomStreamId: "stream_room" })).toEqual({
      kind: "room",
      roomStreamId: "stream_room",
    })
  })
})
