import { afterEach, describe, expect, it, spyOn } from "bun:test"
import type { Pool } from "pg"
import type { Stream } from "../streams"
import * as streamsBarrel from "../streams"
import { E2eStreamsRepository } from "../e2e-streams"
import { decodeKeysetCursor } from "../../lib/keyset-cursor"
import { StreamContextReadRepository, type StreamContextFeedRow } from "./read-repository"
import { createStreamContextService } from "./service"

const pool = {} as Pool
const service = createStreamContextService({ pool })

function stream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream_thread",
    workspaceId: "ws_1",
    type: "thread",
    rootStreamId: "stream_channel",
    parentStreamId: "stream_channel",
    ...overrides,
  } as Stream
}

function feedRow(overrides: Partial<StreamContextFeedRow> = {}): StreamContextFeedRow {
  return {
    key: "link:https://example.com/a:msg_1",
    category: "link",
    refKind: "url",
    refId: "https://example.com/a",
    groupKey: "https://example.com/a",
    anchorEventId: null,
    streamId: "stream_thread",
    sourceMessageId: "msg_1",
    authorId: "usr_1",
    occurredAt: "2026-07-20T10:00:00.000Z",
    sequence: "42",
    snippet: "look",
    occurrenceCount: 2,
    detail: {
      url: "https://example.com/a",
      title: null,
      description: null,
      siteName: null,
      faviconUrl: null,
      imageUrl: null,
      previewType: null,
      contentType: null,
      previewStatus: null,
    },
    cursorOccurredAtKey: "2026-07-20T10:00:00.100200Z",
    id: "sctx_1",
    ...overrides,
  }
}

function grantAccess(result: Stream | null = stream()) {
  return spyOn(streamsBarrel, "checkStreamAccess").mockResolvedValue(result)
}

function sealed(value: boolean) {
  return spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(value)
}

const listParams = {
  workspaceId: "ws_1",
  userId: "usr_1",
  streamId: "stream_thread",
  scope: "tree" as const,
  limit: 2,
}

afterEach(() => {
  spyOn(streamsBarrel, "checkStreamAccess").mockRestore()
  spyOn(E2eStreamsRepository, "isE2eStream").mockRestore()
  spyOn(StreamContextReadRepository, "listFeed").mockRestore()
  spyOn(StreamContextReadRepository, "countsByCategory").mockRestore()
  spyOn(StreamContextReadRepository, "listOccurrences").mockRestore()
})

describe("StreamContextService.list", () => {
  it("queries the resolved root under scope=tree, so a non-member thread inside a member channel is included", async () => {
    grantAccess(stream())
    sealed(false)
    const listFeed = spyOn(StreamContextReadRepository, "listFeed").mockResolvedValue([
      feedRow({ streamId: "stream_thread" }),
    ])
    spyOn(StreamContextReadRepository, "countsByCategory").mockResolvedValue({
      link: 1,
      media: 0,
      file: 0,
      memo: 0,
      delegation: 0,
      follow_up: 0,
      thread: 0,
    })

    const response = await service.list(listParams)

    expect(listFeed.mock.calls[0]![1]).toEqual({
      workspaceId: "ws_1",
      rootStreamId: "stream_channel",
      streamId: "stream_thread",
      scope: "tree",
      category: undefined,
      queryText: undefined,
      authorId: undefined,
      before: undefined,
      after: undefined,
      cursor: undefined,
      limit: 3,
    })
    expect(response).toEqual({
      items: [
        {
          key: "link:https://example.com/a:msg_1",
          category: "link",
          refKind: "url",
          refId: "https://example.com/a",
          groupKey: "https://example.com/a",
          streamId: "stream_thread",
          sourceMessageId: "msg_1",
          anchorEventId: null,
          authorId: "usr_1",
          occurredAt: "2026-07-20T10:00:00.000Z",
          sequence: "42",
          snippet: "look",
          occurrenceCount: 2,
          detail: {
            url: "https://example.com/a",
            title: null,
            description: null,
            siteName: null,
            faviconUrl: null,
            imageUrl: null,
            previewType: null,
            contentType: null,
            previewStatus: null,
          },
        },
      ],
      counts: { link: 1, media: 0, file: 0, memo: 0, delegation: 0, follow_up: 0, thread: 0 },
      nextCursor: null,
      mode: "index",
    })
  })

  it("pages by keyset: the extra row is withheld and its predecessor becomes the cursor", async () => {
    grantAccess(stream())
    sealed(false)
    spyOn(StreamContextReadRepository, "countsByCategory").mockResolvedValue({
      link: 3,
      media: 0,
      file: 0,
      memo: 0,
      delegation: 0,
      follow_up: 0,
      thread: 0,
    })
    spyOn(StreamContextReadRepository, "listFeed").mockResolvedValue([
      feedRow({ key: "a", id: "sctx_3", cursorOccurredAtKey: "2026-07-20T12:00:00.300400Z" }),
      feedRow({ key: "b", id: "sctx_2", cursorOccurredAtKey: "2026-07-20T11:00:00.500600Z" }),
      feedRow({ key: "c", id: "sctx_1", cursorOccurredAtKey: "2026-07-20T10:00:00.100200Z" }),
    ])

    const first = await service.list(listParams)

    expect(first.items.map((item) => item.key)).toEqual(["a", "b"])
    expect(decodeKeysetCursor(first.nextCursor!)).toEqual({
      at: "2026-07-20T11:00:00.500600Z",
      id: "sctx_2",
    })

    const listFeed = spyOn(StreamContextReadRepository, "listFeed").mockResolvedValue([feedRow({ key: "c" })])
    listFeed.mockClear()
    const counts = spyOn(StreamContextReadRepository, "countsByCategory")
    counts.mockClear()

    const second = await service.list({ ...listParams, cursor: first.nextCursor! })

    expect(listFeed.mock.calls[0]![1]!.cursor).toEqual({
      at: "2026-07-20T11:00:00.500600Z",
      id: "sctx_2",
    })
    expect(second.items.map((item) => item.key)).toEqual(["c"])
    // Counts are whole-scope and first-page only — later pages omit them.
    expect(second.counts).toBeNull()
    expect(counts).not.toHaveBeenCalled()
  })

  it("passes every filter through untouched", async () => {
    grantAccess(stream())
    sealed(false)
    const listFeed = spyOn(StreamContextReadRepository, "listFeed").mockResolvedValue([])
    spyOn(StreamContextReadRepository, "countsByCategory").mockResolvedValue({
      link: 0,
      media: 0,
      file: 0,
      memo: 0,
      delegation: 0,
      follow_up: 0,
      thread: 0,
    })

    await service.list({
      ...listParams,
      scope: "stream",
      category: "media",
      queryText: "budget",
      authorId: "usr_7",
      before: new Date("2026-07-01T00:00:00.000Z"),
      after: new Date("2026-06-01T00:00:00.000Z"),
    })

    expect(listFeed.mock.calls[0]![1]).toEqual({
      workspaceId: "ws_1",
      rootStreamId: "stream_channel",
      streamId: "stream_thread",
      scope: "stream",
      category: "media",
      queryText: "budget",
      authorId: "usr_7",
      before: new Date("2026-07-01T00:00:00.000Z"),
      after: new Date("2026-06-01T00:00:00.000Z"),
      cursor: undefined,
      limit: 3,
    })
  })

  it("counts the whole scope with the category selector stripped, keeping the other filters", async () => {
    grantAccess(stream())
    sealed(false)
    spyOn(StreamContextReadRepository, "listFeed").mockResolvedValue([])
    const counts = spyOn(StreamContextReadRepository, "countsByCategory").mockResolvedValue({
      link: 4,
      media: 2,
      file: 0,
      memo: 1,
      delegation: 0,
      follow_up: 0,
      thread: 0,
    })

    await service.list({ ...listParams, category: "link", queryText: "budget" })

    expect(counts.mock.calls[0]![1]).toEqual({
      workspaceId: "ws_1",
      rootStreamId: "stream_channel",
      streamId: "stream_thread",
      scope: "tree",
      category: undefined,
      queryText: "budget",
      authorId: undefined,
      before: undefined,
      after: undefined,
    })
  })

  it("404s a caller without stream access", async () => {
    grantAccess(null)
    const listFeed = spyOn(StreamContextReadRepository, "listFeed").mockResolvedValue([])

    await expect(service.list(listParams)).rejects.toMatchObject({ status: 404, code: "STREAM_NOT_FOUND" })
    expect(listFeed).not.toHaveBeenCalled()
  })

  it("rejects a malformed cursor instead of returning the unfiltered first page", async () => {
    grantAccess(stream())
    sealed(false)
    const listFeed = spyOn(StreamContextReadRepository, "listFeed").mockResolvedValue([])

    await expect(service.list({ ...listParams, cursor: "not-a-cursor" })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_CURSOR",
    })
    expect(listFeed).not.toHaveBeenCalled()
  })

  it("hands a sealed stream back to the client path without touching the index", async () => {
    grantAccess(stream({ id: "stream_channel", rootStreamId: null }))
    sealed(true)
    const listFeed = spyOn(StreamContextReadRepository, "listFeed").mockResolvedValue([])

    const response = await service.list(listParams)

    expect(response).toEqual({
      items: [],
      counts: { link: 0, media: 0, file: 0, memo: 0, delegation: 0, follow_up: 0, thread: 0 },
      nextCursor: null,
      mode: "client",
    })
    expect(listFeed).not.toHaveBeenCalled()
  })
})

describe("StreamContextService.listOccurrences", () => {
  it("queries one artifact's rows against the resolved root", async () => {
    grantAccess(stream())
    sealed(false)
    const listOccurrences = spyOn(StreamContextReadRepository, "listOccurrences").mockResolvedValue([
      feedRow({ key: "a", occurrenceCount: 1 }),
    ])

    const response = await service.listOccurrences({
      workspaceId: "ws_1",
      userId: "usr_1",
      streamId: "stream_thread",
      scope: "tree",
      category: "link",
      groupKey: "https://example.com/a",
      limit: 2,
    })

    expect(listOccurrences.mock.calls[0]![1]).toEqual({
      workspaceId: "ws_1",
      rootStreamId: "stream_channel",
      streamId: "stream_thread",
      scope: "tree",
      category: "link",
      groupKey: "https://example.com/a",
      cursor: undefined,
      limit: 3,
    })
    expect(response.items.map((item) => item.key)).toEqual(["a"])
    expect(response.nextCursor).toBeNull()
  })

  it("returns nothing for a sealed stream", async () => {
    grantAccess(stream())
    sealed(true)
    const listOccurrences = spyOn(StreamContextReadRepository, "listOccurrences").mockResolvedValue([])

    const response = await service.listOccurrences({
      workspaceId: "ws_1",
      userId: "usr_1",
      streamId: "stream_thread",
      scope: "tree",
      category: "link",
      groupKey: "https://example.com/a",
      limit: 2,
    })

    expect(response).toEqual({ items: [], nextCursor: null })
    expect(listOccurrences).not.toHaveBeenCalled()
  })
})
