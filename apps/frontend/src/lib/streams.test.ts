import { describe, it, expect } from "vitest"
import { SLUG_MAX_LENGTH } from "@threahq/types"
import {
  collectSealedStreamIds,
  findArchivedAncestor,
  resolveDmDisplayName,
  resolveStreamName,
  streamChipSlug,
  streamLabel,
} from "./streams"

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

describe("streamChipSlug", () => {
  it("uses a channel's own slug", () => {
    expect(streamChipSlug({ type: "channel", slug: "pizza", displayName: null })).toBe("pizza")
  })

  it("folds a scratchpad's display name into slug shape", () => {
    expect(streamChipSlug({ type: "scratchpad", slug: null, displayName: "Pi remote control" })).toBe(
      "pi-remote-control"
    )
  })

  it("strips punctuation and collapses separators", () => {
    expect(streamChipSlug({ type: "scratchpad", slug: null, displayName: "Kris's plan — v2!" })).toBe("kris-s-plan-v2")
  })

  it("caps the fold at the shared slug length limit", () => {
    const long = "a".repeat(80)
    expect(streamChipSlug({ type: "scratchpad", slug: null, displayName: long })).toHaveLength(SLUG_MAX_LENGTH)
  })

  it("keeps a name written outside the Latin alphabet", () => {
    expect(streamChipSlug({ type: "scratchpad", slug: null, displayName: "日本語のメモ" })).toBe("日本語のメモ")
  })

  it("falls back to the type noun when the name folds to nothing", () => {
    expect(streamChipSlug({ type: "scratchpad", slug: null, displayName: "《》" })).toBe("scratchpad")
  })

  it("folds the placeholder for an unnamed scratchpad", () => {
    expect(streamChipSlug({ type: "scratchpad", slug: null, displayName: null })).toBe("untitled")
  })
})

describe("findArchivedAncestor", () => {
  const rows: Record<
    string,
    { id: string; archivedAt: string | null; parentStreamId: string | null; rootStreamId: string | null }
  > = {
    chan: { id: "chan", archivedAt: null, parentStreamId: null, rootStreamId: null },
    thread_a: { id: "thread_a", archivedAt: "2026-01-01T00:00:00Z", parentStreamId: "chan", rootStreamId: "chan" },
    thread_b: { id: "thread_b", archivedAt: null, parentStreamId: "thread_a", rootStreamId: "chan" },
    thread_c: { id: "thread_c", archivedAt: null, parentStreamId: "thread_b", rootStreamId: "chan" },
    thread_live: { id: "thread_live", archivedAt: null, parentStreamId: "chan", rootStreamId: "chan" },
    archived_root: {
      id: "archived_root",
      archivedAt: "2026-01-01T00:00:00Z",
      parentStreamId: null,
      rootStreamId: null,
    },
  }
  const lookup = (id: string) => rows[id]

  it("names the nearest archived ancestor at any depth", () => {
    expect(findArchivedAncestor(rows.thread_c, lookup)).toEqual({ resolved: true, sealedBy: rows.thread_a })
    expect(findArchivedAncestor(rows.thread_b, lookup)).toEqual({ resolved: true, sealedBy: rows.thread_a })
  })

  it("resolves to nothing when every ancestor is live", () => {
    expect(findArchivedAncestor(rows.thread_live, lookup)).toEqual({ resolved: true, sealedBy: null })
    expect(findArchivedAncestor(rows.chan, lookup)).toEqual({ resolved: true, sealedBy: null })
  })

  it("is unresolved when a chain link is missing and the root is live", () => {
    const orphan = { id: "orphan", archivedAt: null, parentStreamId: "missing", rootStreamId: "chan" }
    expect(findArchivedAncestor(orphan, lookup)).toEqual({ resolved: false, sealedBy: null })
  })

  it("falls back to an archived root when a chain link is missing", () => {
    const orphan = { id: "orphan", archivedAt: null, parentStreamId: "missing", rootStreamId: "archived_root" }
    expect(findArchivedAncestor(orphan, lookup)).toEqual({ resolved: true, sealedBy: rows.archived_root })
  })

  it("stops at the depth bound on a cyclic chain", () => {
    const cyclic = { id: "x", archivedAt: null, parentStreamId: "x", rootStreamId: null }
    expect(findArchivedAncestor(cyclic, () => cyclic)).toEqual({ resolved: false, sealedBy: null })
  })
})

describe("collectSealedStreamIds", () => {
  it("collects archived streams and everything under them, not unresolvable chains", () => {
    const sealed = collectSealedStreamIds([
      { id: "chan", archivedAt: null, parentStreamId: null },
      { id: "thread_a", archivedAt: "2026-01-01T00:00:00Z", parentStreamId: "chan", rootStreamId: "chan" },
      { id: "thread_b", archivedAt: null, parentStreamId: "thread_a", rootStreamId: "chan" },
      { id: "aside", archivedAt: null, parentStreamId: "thread_b", rootStreamId: null },
      { id: "thread_live", archivedAt: null, parentStreamId: "chan", rootStreamId: "chan" },
      { id: "orphan", archivedAt: null, parentStreamId: "missing", rootStreamId: "chan" },
    ])
    expect([...sealed].sort()).toEqual(["aside", "thread_a", "thread_b"])
  })
})
