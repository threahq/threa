import { describe, expect, it } from "vitest"
import { buildDirectoryRows, pickMostActive, type DirectoryStream } from "./directory"

function stream(id: string, overrides: Partial<DirectoryStream> = {}): DirectoryStream {
  return {
    id,
    type: "channel",
    visibility: "public",
    rootStreamId: null,
    purpose: null,
    archivedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    lastMessagePreview: null,
    ...overrides,
  }
}

const build = (streams: DirectoryStream[], opts: Partial<Parameters<typeof buildDirectoryRows>[0]> = {}) =>
  buildDirectoryRows({
    streams,
    memberStreamIds: new Set(["stream_joined"]),
    tab: "all",
    archived: false,
    query: "",
    nameOf: (s) => s.id,
    ...opts,
  }).map((row) => ({ id: row.stream.id, joinable: row.joinable }))

describe("buildDirectoryRows", () => {
  it("should sort by last activity and mark only unjoined public channels joinable", () => {
    const rows = build([
      stream("stream_joined", { lastMessagePreview: { createdAt: "2026-09-10T00:00:00.000Z" } }),
      stream("stream_open", { lastMessagePreview: { createdAt: "2026-09-12T00:00:00.000Z" } }),
      stream("stream_private", { visibility: "private" }),
      stream("stream_thread", { type: "thread", rootStreamId: "stream_joined" }),
    ])
    expect(rows).toEqual([
      { id: "stream_open", joinable: true },
      { id: "stream_joined", joinable: false },
      { id: "stream_private", joinable: false },
      { id: "stream_thread", joinable: false },
    ])
  })

  it("should never list asides, threads inside asides, or utility streams", () => {
    const rows = build([
      stream("stream_joined"),
      stream("stream_aside", { type: "aside" }),
      stream("stream_aside_thread", { type: "thread", rootStreamId: "stream_aside" }),
      stream("stream_persona_test", { type: "scratchpad", purpose: "persona_test" }),
    ])
    expect(rows).toEqual([{ id: "stream_joined", joinable: false }])
  })

  it("should hide threads under an archived stream from the active listing", () => {
    const rows = build([
      stream("stream_old", { archivedAt: "2026-09-02T00:00:00.000Z" }),
      stream("stream_thread", { type: "thread", parentStreamId: "stream_old", rootStreamId: "stream_old" }),
      stream("stream_nested", { type: "thread", parentStreamId: "stream_thread", rootStreamId: "stream_old" }),
      stream("stream_joined"),
    ])
    expect(rows).toEqual([{ id: "stream_joined", joinable: false }])
  })

  it("should filter by tab, archive state and query when set", () => {
    const streams = [
      stream("stream_joined"),
      stream("stream_pad", { type: "scratchpad" }),
      stream("stream_old", { archivedAt: "2026-09-02T00:00:00.000Z" }),
    ]
    expect(build(streams, { tab: "scratchpads" })).toEqual([{ id: "stream_pad", joinable: false }])
    expect(build(streams, { archived: true })).toEqual([{ id: "stream_old", joinable: false }])
    expect(build(streams, { query: "JOIN" })).toEqual([{ id: "stream_joined", joinable: false }])
  })

  it("should narrow to the threads rooted in a stream when a root is set", () => {
    const streams = [
      stream("stream_joined"),
      stream("stream_thread", { type: "thread", parentStreamId: "stream_joined", rootStreamId: "stream_joined" }),
      stream("stream_nested", { type: "thread", parentStreamId: "stream_thread", rootStreamId: "stream_joined" }),
      stream("stream_elsewhere", { type: "thread", parentStreamId: "stream_open", rootStreamId: "stream_open" }),
      stream("stream_open"),
    ]
    expect(
      build(streams, { tab: "threads", rootStreamId: "stream_joined" })
        .map((r) => r.id)
        .sort()
    ).toEqual(["stream_nested", "stream_thread"])
  })

  it("should narrow to joined or unjoined streams when a membership filter is set", () => {
    const streams = [stream("stream_joined"), stream("stream_open")]
    expect(build(streams, { membership: "joined" })).toEqual([{ id: "stream_joined", joinable: false }])
    expect(build(streams, { membership: "not-joined" })).toEqual([{ id: "stream_open", joinable: true }])
  })

  it("should order by name or member count when asked, falling back to activity", () => {
    const streams = [
      stream("stream_b", { lastMessagePreview: { createdAt: "2026-09-12T00:00:00.000Z" } }),
      stream("stream_a", { lastMessagePreview: { createdAt: "2026-09-10T00:00:00.000Z" } }),
      stream("stream_c", { lastMessagePreview: { createdAt: "2026-09-11T00:00:00.000Z" } }),
    ]
    const counts: Record<string, number> = { stream_a: 3, stream_b: 1, stream_c: 3 }
    const ids = (opts: Partial<Parameters<typeof buildDirectoryRows>[0]>) => build(streams, opts).map((r) => r.id)
    expect({
      name: ids({ sort: "name" }),
      members: ids({ sort: "members", memberCountOf: (id) => counts[id] }),
    }).toEqual({
      name: ["stream_a", "stream_b", "stream_c"],
      members: ["stream_c", "stream_a", "stream_b"],
    })
  })
})

describe("pickMostActive", () => {
  it("should return the busiest streams first and skip idle ones", () => {
    const rows = buildDirectoryRows({
      streams: [stream("stream_quiet"), stream("stream_busy"), stream("stream_idle"), stream("stream_mid")],
      memberStreamIds: new Set(),
      tab: "all",
      archived: false,
      query: "",
      nameOf: (s) => s.id,
    })
    const counts: Record<string, number> = { stream_quiet: 1, stream_busy: 9, stream_idle: 0, stream_mid: 4 }
    expect(pickMostActive(rows, (id) => counts[id], 2).map((r) => r.stream.id)).toEqual(["stream_busy", "stream_mid"])
  })
})
