import { describe, it, expect } from "vitest"
import { resolveDmDisplayName, resolveStreamName, streamLabel } from "./streams"

describe("streamLabel", () => {
  it("prefixes a channel with its slug", () => {
    expect(streamLabel({ type: "channel", slug: "general", displayName: null })).toBe("#general")
  })

  it("uses the displayName for a named non-channel stream", () => {
    expect(streamLabel({ type: "thread", slug: null, displayName: "Launch plan" })).toBe("Launch plan")
  })

  it("falls through to a context-appropriate placeholder when the stream has no name", () => {
    expect(streamLabel({ type: "scratchpad", slug: null, displayName: null }, "sidebar")).toBe("New scratchpad")
  })

  it("defaults the fallback context to generic", () => {
    expect(streamLabel({ type: "thread", slug: null, displayName: null })).toBe("Thread")
  })
})

describe("resolveStreamName", () => {
  const users = [{ id: "user_peer", name: "Pierre Boberg" }]
  const dmPeers = [{ streamId: "stream_dm", userId: "user_peer" }]

  it("resolves a DM peer name even when the DM stream object isn't cached", () => {
    expect(resolveStreamName("stream_dm", { streams: [], users, dmPeers })).toBe("Pierre Boberg")
  })

  it("prefixes channels with their slug from the cached stream", () => {
    const streams = [{ id: "stream_ch", type: "channel" as const, slug: "general", displayName: null }]
    expect(resolveStreamName("stream_ch", { streams, users: [], dmPeers: [] })).toBe("#general")
  })

  it("uses a context-appropriate fallback for a cached stream with no name", () => {
    const streams = [{ id: "stream_sp", type: "scratchpad" as const, slug: null, displayName: null }]
    expect(resolveStreamName("stream_sp", { streams, users: [], dmPeers: [] }, "sidebar")).toBe("New scratchpad")
  })

  it("returns null when the id matches no DM peer and no cached stream", () => {
    expect(resolveStreamName("stream_gone", { streams: [], users: [], dmPeers: [] })).toBeNull()
  })
})

describe("resolveDmDisplayName", () => {
  const workspaceUsers = [
    { id: "user_viewer", name: "Viewer" },
    { id: "user_pierre", name: "Pierre Boberg" },
  ]

  it("returns the peer user's name when the DM peer is known", () => {
    const dmPeers = [{ streamId: "stream_dm_1", userId: "user_pierre" }]
    expect(resolveDmDisplayName("stream_dm_1", workspaceUsers, dmPeers)).toBe("Pierre Boberg")
  })

  it("returns null when no DM peer entry exists for the stream", () => {
    expect(resolveDmDisplayName("stream_dm_unknown", workspaceUsers, [])).toBeNull()
  })

  it("returns null when the peer user is not present in the workspace users cache", () => {
    const dmPeers = [{ streamId: "stream_dm_1", userId: "user_missing" }]
    expect(resolveDmDisplayName("stream_dm_1", workspaceUsers, dmPeers)).toBeNull()
  })
})
