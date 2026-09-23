import { describe, expect, it } from "vitest"
import { buildDirectoryRows, type DirectoryStream } from "./directory"

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
})
