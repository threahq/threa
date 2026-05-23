import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import {
  collectSharedMessageIds,
  hydrateSharedMessageIds,
  hydrateSharedMessages,
  MAX_HYDRATION_DEPTH,
} from "./hydration"
import { MessageRepository } from "../repository"
import { UserRepository } from "../../workspaces"
import { PersonaRepository } from "../../agents"
import * as streamsBarrel from "../../streams"
import { StreamRepository } from "../../streams"
import { AttachmentRepository } from "../../attachments"
import { SharedMessageRepository } from "./repository"

afterEach(() => {
  mock.restore()
})

// Every ok-state hydration triggers `AttachmentRepository.findByMessageIds`
// to enrich the payload. Default the stub to "no attachments" so the
// existing battery of tests doesn't have to opt in; the dedicated
// attachment tests below override it.
beforeEach(() => {
  spyOn(AttachmentRepository, "findByMessageIds").mockResolvedValue(new Map())
})

const VIEWER_ID = "usr_viewer"

function stubAuthorLookups() {
  spyOn(UserRepository, "findByIds").mockResolvedValue([])
  spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
}

/**
 * Default access mocks: viewer has access to every stream we ask about,
 * and no share grants. Tests that exercise the private/truncated paths
 * override these.
 */
function stubFullAccess() {
  spyOn(streamsBarrel, "listAccessibleStreamIds").mockImplementation(async (_db, _ws, _uid, candidates) => {
    return new Set(candidates)
  })
  spyOn(SharedMessageRepository, "listSourcesGrantedToViewer").mockResolvedValue(new Set())
}

function stubNoAccess() {
  spyOn(streamsBarrel, "listAccessibleStreamIds").mockResolvedValue(new Set())
  spyOn(SharedMessageRepository, "listSourcesGrantedToViewer").mockResolvedValue(new Set())
}

function makeMessage(
  overrides: Partial<{ id: string; streamId: string; deletedAt: Date | null; contentJson: unknown }>
) {
  return {
    id: overrides.id ?? "msg_a",
    streamId: overrides.streamId ?? "stream_source",
    authorId: "usr_author",
    authorType: "user",
    contentJson: overrides.contentJson ?? { type: "doc", content: [{ type: "paragraph" }] },
    contentMarkdown: "hello",
    editedAt: null,
    createdAt: new Date("2026-01-01"),
    deletedAt: overrides.deletedAt ?? null,
  } as any
}

describe("collectSharedMessageIds", () => {
  it("collects messageIds from nested sharedMessage nodes", () => {
    const ids = new Set<string>()
    collectSharedMessageIds(
      {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hello" }] },
          { type: "sharedMessage", attrs: { messageId: "msg_a", streamId: "stream_a" } },
          {
            type: "blockquote",
            content: [{ type: "sharedMessage", attrs: { messageId: "msg_b", streamId: "stream_b" } }],
          },
        ],
      },
      ids
    )
    expect(Array.from(ids).sort()).toEqual(["msg_a", "msg_b"])
  })

  it("ignores nodes that are not sharedMessage", () => {
    const ids = new Set<string>()
    collectSharedMessageIds(
      {
        type: "doc",
        content: [{ type: "quoteReply", attrs: { messageId: "msg_quote", streamId: "stream_q" } }],
      },
      ids
    )
    expect(ids.size).toBe(0)
  })
})

describe("hydrateSharedMessageIds", () => {
  it("returns an empty map when given no ids", async () => {
    const result = await hydrateSharedMessageIds({} as any, "ws_1", VIEWER_ID, [])
    expect(result).toEqual({})
  })

  it("returns ok-state payloads when viewer can access the source stream", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([["msg_a", makeMessage({ id: "msg_a" })]])
    )
    spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_author", name: "Ada" } as any])
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
    stubFullAccess()

    const result = await hydrateSharedMessageIds({} as any, "ws_1", VIEWER_ID, ["msg_a"])
    expect(result.msg_a).toMatchObject({
      state: "ok",
      messageId: "msg_a",
      streamId: "stream_source",
      authorName: "Ada",
    })
  })

  it("returns deleted payloads for soft-deleted accessible sources", async () => {
    const deletedAt = new Date("2026-02-01")
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([["msg_a", makeMessage({ id: "msg_a", deletedAt })]])
    )
    stubAuthorLookups()
    stubFullAccess()
    const result = await hydrateSharedMessageIds({} as any, "ws_1", VIEWER_ID, ["msg_a"])
    expect(result.msg_a).toEqual({ state: "deleted", messageId: "msg_a", deletedAt })
  })

  it("returns missing payloads for ids that resolve to no row", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(new Map())
    stubAuthorLookups()
    stubFullAccess()
    const result = await hydrateSharedMessageIds({} as any, "ws_1", VIEWER_ID, ["msg_missing"])
    expect(result.msg_missing).toEqual({ state: "missing", messageId: "msg_missing" })
  })

  it("returns a private placeholder when viewer can't access the source stream", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([["msg_a", makeMessage({ id: "msg_a" })]])
    )
    stubAuthorLookups()
    stubNoAccess()
    spyOn(StreamRepository, "findByIds").mockResolvedValue([
      {
        id: "stream_source",
        type: "channel",
        visibility: "private",
        rootStreamId: null,
      } as any,
    ])

    const result = await hydrateSharedMessageIds({} as any, "ws_1", VIEWER_ID, ["msg_a"])
    expect(result.msg_a).toEqual({
      state: "private",
      messageId: "msg_a",
      sourceStreamKind: "channel",
      sourceVisibility: "private",
    })
  })

  it("for thread sources, the private placeholder reports the parent's kind/visibility", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([["msg_a", makeMessage({ id: "msg_a" })]])
    )
    stubAuthorLookups()
    stubNoAccess()
    const findStreams = spyOn(StreamRepository, "findByIds")
      .mockResolvedValueOnce([
        {
          id: "stream_source",
          type: "thread",
          visibility: "private",
          rootStreamId: "stream_root",
        } as any,
      ])
      .mockResolvedValueOnce([
        {
          id: "stream_root",
          type: "channel",
          visibility: "public",
          rootStreamId: null,
        } as any,
      ])

    const result = await hydrateSharedMessageIds({} as any, "ws_1", VIEWER_ID, ["msg_a"])
    expect(result.msg_a).toEqual({
      state: "private",
      messageId: "msg_a",
      sourceStreamKind: "channel",
      sourceVisibility: "public",
    })
    expect(findStreams).toHaveBeenCalledTimes(2)
  })

  it("treats source-via-share-grant as accessible even when not a stream member", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([["msg_a", makeMessage({ id: "msg_a" })]])
    )
    stubAuthorLookups()
    spyOn(streamsBarrel, "listAccessibleStreamIds").mockResolvedValue(new Set()) // not a member
    spyOn(SharedMessageRepository, "listSourcesGrantedToViewer").mockResolvedValue(new Set(["msg_a"])) // but has share grant

    const result = await hydrateSharedMessageIds({} as any, "ws_1", VIEWER_ID, ["msg_a"])
    expect(result.msg_a).toMatchObject({ state: "ok", messageId: "msg_a" })
  })

  it("recurses into nested pointers up to MAX_HYDRATION_DEPTH and emits truncated past the cap", async () => {
    // Build a chain msg_0 → msg_1 → msg_2 → msg_3 → msg_4 (4 levels deep beyond seed)
    // With MAX_HYDRATION_DEPTH = 3, msg_0..msg_2 hydrate as ok and msg_3 is truncated.
    //
    // The cached `streamId` on every share node attr is "stream_cached", but
    // the live row for the past-cap source lives in "stream_live" (simulating
    // a post-move state where the cached attr went stale). The truncated
    // payload must report the live streamId, not the cached one — otherwise
    // the "open in source stream" link drops the user on the wrong stream.
    const findByIds = spyOn(MessageRepository, "findByIdsInWorkspace").mockImplementation(async (_db, _ws, ids) => {
      const map = new Map<string, any>()
      for (const id of ids) {
        const next = id.replace(/^msg_(\d+)$/, (_m, n) => `msg_${Number(n) + 1}`)
        map.set(
          id,
          makeMessage({
            id,
            streamId: id === `msg_${MAX_HYDRATION_DEPTH}` ? "stream_live" : "stream_source",
            contentJson: {
              type: "doc",
              content: [{ type: "sharedMessage", attrs: { messageId: next, streamId: "stream_cached" } }],
            },
          })
        )
      }
      return map
    })
    stubAuthorLookups()
    stubFullAccess()

    const result = await hydrateSharedMessageIds({} as any, "ws_1", VIEWER_ID, ["msg_0"])

    // 0..(MAX-1) are fetched and hydrated as ok
    for (let i = 0; i < MAX_HYDRATION_DEPTH; i++) {
      expect(result[`msg_${i}`]).toMatchObject({ state: "ok" })
    }
    // The truncated entry reports the LIVE streamId from the row, not the
    // stale cached attr — the fix for "shared_messages cached streamId goes
    // stale after batch move-to-thread".
    expect(result[`msg_${MAX_HYDRATION_DEPTH}`]).toEqual({
      state: "truncated",
      messageId: `msg_${MAX_HYDRATION_DEPTH}`,
      streamId: "stream_live",
    })
    // MAX_HYDRATION_DEPTH BFS lookups + 1 batched lookup for past-cap entries.
    expect(findByIds).toHaveBeenCalledTimes(MAX_HYDRATION_DEPTH + 1)
  })

  it("emits deleted (not truncated) when a past-cap source has been tombstoned", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockImplementation(async (_db, _ws, ids) => {
      const map = new Map<string, any>()
      for (const id of ids) {
        const next = id.replace(/^msg_(\d+)$/, (_m, n) => `msg_${Number(n) + 1}`)
        const past = id === `msg_${MAX_HYDRATION_DEPTH}`
        map.set(
          id,
          makeMessage({
            id,
            deletedAt: past ? new Date("2026-04-01") : null,
            contentJson: past
              ? { type: "doc", content: [] }
              : {
                  type: "doc",
                  content: [{ type: "sharedMessage", attrs: { messageId: next, streamId: "stream_cached" } }],
                },
          })
        )
      }
      return map
    })
    stubAuthorLookups()
    stubFullAccess()

    const result = await hydrateSharedMessageIds({} as any, "ws_1", VIEWER_ID, ["msg_0"])
    expect(result[`msg_${MAX_HYDRATION_DEPTH}`]).toEqual({
      state: "deleted",
      messageId: `msg_${MAX_HYDRATION_DEPTH}`,
      deletedAt: new Date("2026-04-01"),
    })
  })

  it("emits missing when a past-cap source row is gone entirely", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockImplementation(async (_db, _ws, ids) => {
      const map = new Map<string, any>()
      for (const id of ids) {
        // Simulate the past-cap source being deleted from the row set.
        if (id === `msg_${MAX_HYDRATION_DEPTH}`) continue
        const next = id.replace(/^msg_(\d+)$/, (_m, n) => `msg_${Number(n) + 1}`)
        map.set(
          id,
          makeMessage({
            id,
            contentJson: {
              type: "doc",
              content: [{ type: "sharedMessage", attrs: { messageId: next, streamId: "stream_cached" } }],
            },
          })
        )
      }
      return map
    })
    stubAuthorLookups()
    stubFullAccess()

    const result = await hydrateSharedMessageIds({} as any, "ws_1", VIEWER_ID, ["msg_0"])
    expect(result[`msg_${MAX_HYDRATION_DEPTH}`]).toEqual({
      state: "missing",
      messageId: `msg_${MAX_HYDRATION_DEPTH}`,
    })
  })

  it("emits private (not truncated) when a past-cap source has been moved into an inaccessible stream", async () => {
    // Past-cap source M lives in stream_private after a move; the cached
    // streamId on the share-node attrs is "stream_cached", but the viewer
    // can only read the streams reachable along the BFS chain. Surfacing
    // the live `stream_private` without an access check would leak the
    // existence of the new private stream the viewer has no rights to.
    spyOn(MessageRepository, "findByIdsInWorkspace").mockImplementation(async (_db, _ws, ids) => {
      const map = new Map<string, any>()
      for (const id of ids) {
        const next = id.replace(/^msg_(\d+)$/, (_m, n) => `msg_${Number(n) + 1}`)
        const past = id === `msg_${MAX_HYDRATION_DEPTH}`
        map.set(
          id,
          makeMessage({
            id,
            streamId: past ? "stream_private" : "stream_chain",
            contentJson: past
              ? { type: "doc", content: [] }
              : {
                  type: "doc",
                  content: [{ type: "sharedMessage", attrs: { messageId: next, streamId: "stream_cached" } }],
                },
          })
        )
      }
      return map
    })
    stubAuthorLookups()
    spyOn(streamsBarrel, "listAccessibleStreamIds").mockImplementation(async (_db, _ws, _uid, candidates) => {
      // Viewer can read the BFS chain's stream but NOT the post-move private one.
      return new Set([...candidates].filter((id) => id !== "stream_private"))
    })
    spyOn(SharedMessageRepository, "listSourcesGrantedToViewer").mockResolvedValue(new Set())
    spyOn(StreamRepository, "findByIds").mockResolvedValue([
      { id: "stream_private", type: "channel", visibility: "private", rootStreamId: null } as any,
    ])

    const result = await hydrateSharedMessageIds({} as any, "ws_1", VIEWER_ID, ["msg_0"])
    expect(result[`msg_${MAX_HYDRATION_DEPTH}`]).toEqual({
      state: "private",
      messageId: `msg_${MAX_HYDRATION_DEPTH}`,
      sourceStreamKind: "channel",
      sourceVisibility: "private",
    })
  })

  it("skips truncated emission for a private inner pointer (no extra access leak)", async () => {
    // A two-hop chain where the viewer can read msg_outer but not msg_inner.
    // The plan says inner should render as `private`, not as `truncated`.
    spyOn(MessageRepository, "findByIdsInWorkspace").mockImplementation(async (_db, _ws, ids) => {
      const map = new Map<string, any>()
      for (const id of ids) {
        if (id === "msg_outer") {
          map.set(
            id,
            makeMessage({
              id,
              streamId: "stream_outer",
              contentJson: {
                type: "doc",
                content: [{ type: "sharedMessage", attrs: { messageId: "msg_inner", streamId: "stream_inner" } }],
              },
            })
          )
        } else if (id === "msg_inner") {
          map.set(id, makeMessage({ id, streamId: "stream_inner" }))
        }
      }
      return map
    })
    stubAuthorLookups()
    spyOn(streamsBarrel, "listAccessibleStreamIds").mockImplementation(async (_db, _ws, _uid, candidates) => {
      return new Set([...candidates].filter((id) => id === "stream_outer"))
    })
    spyOn(SharedMessageRepository, "listSourcesGrantedToViewer").mockResolvedValue(new Set())
    spyOn(StreamRepository, "findByIds").mockResolvedValue([
      { id: "stream_inner", type: "channel", visibility: "private", rootStreamId: null } as any,
    ])

    const result = await hydrateSharedMessageIds({} as any, "ws_1", VIEWER_ID, ["msg_outer"])
    expect(result.msg_outer).toMatchObject({ state: "ok" })
    expect(result.msg_inner).toEqual({
      state: "private",
      messageId: "msg_inner",
      sourceStreamKind: "channel",
      sourceVisibility: "private",
    })
  })

  it("inlines attachments on ok-state payloads", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([["msg_a", makeMessage({ id: "msg_a" })]])
    )
    stubAuthorLookups()
    stubFullAccess()
    spyOn(AttachmentRepository, "findByMessageIds").mockResolvedValue(
      new Map([
        [
          "msg_a",
          [
            {
              id: "att_pic",
              filename: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 1234,
              processingStatus: "completed",
            } as any,
          ],
        ],
      ])
    )

    const result = await hydrateSharedMessageIds({} as any, "ws_1", VIEWER_ID, ["msg_a"])
    expect(result.msg_a).toMatchObject({
      state: "ok",
      attachments: [{ id: "att_pic", filename: "screenshot.png", mimeType: "image/png", sizeBytes: 1234 }],
    })
    // Non-video attachments must NOT carry processingStatus on the wire —
    // the field is exclusively for video transcoding state, mirroring
    // event-service.ts's emit logic so the wire payload stays consistent.
    expect(
      (result.msg_a as { attachments: Array<{ processingStatus?: string }> }).attachments[0].processingStatus
    ).toBeUndefined()
  })

  it("emits an empty attachments array when the source has none", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([["msg_a", makeMessage({ id: "msg_a" })]])
    )
    stubAuthorLookups()
    stubFullAccess()
    // Default beforeEach stub returns an empty map, but be explicit here.
    spyOn(AttachmentRepository, "findByMessageIds").mockResolvedValue(new Map())

    const result = await hydrateSharedMessageIds({} as any, "ws_1", VIEWER_ID, ["msg_a"])
    expect(result.msg_a).toMatchObject({ state: "ok", attachments: [] })
  })

  it("batches attachment lookups across every ok-state message in one round-trip (INV-56)", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([
        ["msg_a", makeMessage({ id: "msg_a" })],
        ["msg_b", makeMessage({ id: "msg_b" })],
      ])
    )
    stubAuthorLookups()
    stubFullAccess()
    const findAttachments = spyOn(AttachmentRepository, "findByMessageIds").mockResolvedValue(new Map())

    await hydrateSharedMessageIds({} as any, "ws_1", VIEWER_ID, ["msg_a", "msg_b"])
    expect(findAttachments).toHaveBeenCalledTimes(1)
    const calledWith = (findAttachments as any).mock.calls[0][2].sort()
    expect(calledWith).toEqual(["msg_a", "msg_b"])
  })

  it("does not fetch attachments when no ok-state messages survive", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(new Map())
    stubAuthorLookups()
    stubFullAccess()
    const findAttachments = spyOn(AttachmentRepository, "findByMessageIds").mockResolvedValue(new Map())

    const result = await hydrateSharedMessageIds({} as any, "ws_1", VIEWER_ID, ["msg_missing"])
    expect(result.msg_missing).toEqual({ state: "missing", messageId: "msg_missing" })
    expect(findAttachments).not.toHaveBeenCalled()
  })
})

describe("hydrateSharedMessages", () => {
  it("scans input messages' contentJson and hydrates referenced ids in one pass", async () => {
    const findByIds = spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(new Map())
    stubAuthorLookups()
    stubFullAccess()
    await hydrateSharedMessages({} as any, "ws_1", VIEWER_ID, [
      {
        id: "msg_1",
        contentJson: {
          type: "doc",
          content: [
            { type: "sharedMessage", attrs: { messageId: "msg_a", streamId: "stream_a" } },
            { type: "sharedMessage", attrs: { messageId: "msg_b", streamId: "stream_b" } },
          ],
        },
      } as any,
      {
        id: "msg_2",
        contentJson: {
          type: "doc",
          content: [{ type: "sharedMessage", attrs: { messageId: "msg_a", streamId: "stream_a" } }],
        },
      } as any,
    ])

    expect(findByIds).toHaveBeenCalledTimes(1)
    const ids = (findByIds as any).mock.calls[0][2].sort()
    expect(ids).toEqual(["msg_a", "msg_b"])
  })
})
