import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { sharedMessageSlotKey, type SharedMessageRef } from "@threa/types"
import {
  collectSharedMessageIds,
  collectSharedMessageRefs,
  hydrateSharedMessageRefs,
  hydrateSharedMessageRefsForAccessibleSet,
  hydrateSharedMessages,
  hydrateSharedMessageRefsForRoom,
  toDualSlotMaps,
  MAX_HYDRATION_DEPTH,
} from "./hydration"
import { MessageRepository } from "../repository"
import { MessageVersionRepository } from "../version-repository"
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

/** An unpinned (legacy) reference — hydrates at the source's current revision. */
function ref(messageId: string, version: number | null = null, range: SharedMessageRef["range"] = null) {
  return { messageId, version, range }
}
const key = sharedMessageSlotKey

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
  overrides: Partial<{
    id: string
    streamId: string
    deletedAt: Date | null
    contentJson: unknown
    revision: number
  }>
) {
  return {
    id: overrides.id ?? "msg_a",
    revision: overrides.revision ?? 1,
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

describe("collectSharedMessageRefs", () => {
  it("keys each node by its pin so one source at two pins stays two entries", () => {
    const refs = new Map<string, SharedMessageRef>()
    collectSharedMessageRefs(
      {
        type: "doc",
        content: [
          { type: "sharedMessage", attrs: { messageId: "msg_a", streamId: "stream_a" } },
          { type: "sharedMessage", attrs: { messageId: "msg_a", streamId: "stream_a", version: 2 } },
          {
            type: "blockquote",
            content: [
              {
                type: "sharedMessage",
                attrs: { messageId: "msg_a", streamId: "stream_a", version: 2, range: { from: 1, to: 4 } },
              },
            ],
          },
        ],
      },
      refs
    )
    expect(Object.fromEntries(refs)).toEqual({
      "shared:msg_a": ref("msg_a"),
      "shared:msg_a@2": ref("msg_a", 2),
      "shared:msg_a@2:1-4": ref("msg_a", 2, { from: 1, to: 4 }),
    })
  })
})

describe("pinned hydration", () => {
  const currentDoc = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "second body" }] }],
  }
  const v1Doc = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "first body" }] }],
  }

  function stubSource() {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([["msg_a", makeMessage({ id: "msg_a", revision: 2, contentJson: currentDoc })]])
    )
    spyOn(MessageVersionRepository, "findByMessageVersions").mockResolvedValue(
      new Map([["msg_a@1", { messageId: "msg_a", versionNumber: 1, contentJson: v1Doc } as any]])
    )
    stubAuthorLookups()
    stubFullAccess()
  }

  it("serves the pinned version's body and reports the source's current revision", async () => {
    stubSource()
    const result = await hydrateSharedMessageRefs({} as any, "ws_1", VIEWER_ID, [ref("msg_a", 1)])
    expect(result[key("msg_a", 1)]).toMatchObject({
      state: "ok",
      contentJson: v1Doc,
      contentMarkdown: "first body",
      version: 1,
      currentRevision: 2,
      range: null,
    })
  })

  it("serves only the referenced span, and no attachments, for a ranged reference", async () => {
    stubSource()
    const findAttachments = spyOn(AttachmentRepository, "findByMessageIds").mockResolvedValue(new Map())

    const range = { from: 1, to: 6 }
    const result = await hydrateSharedMessageRefs({} as any, "ws_1", VIEWER_ID, [ref("msg_a", 1, range)])
    expect(result[key("msg_a", 1, range)]).toMatchObject({
      state: "ok",
      contentMarkdown: "first",
      version: 1,
      range,
      attachments: [],
    })
    // The source's files are never looked up for a span reference.
    expect(findAttachments).toHaveBeenCalledWith({}, [])
  })

  it("hydrates the same source at two pins into two independent slots", async () => {
    stubSource()
    const result = await hydrateSharedMessageRefs({} as any, "ws_1", VIEWER_ID, [ref("msg_a", 1), ref("msg_a", 2)])
    expect(result[key("msg_a", 1)]).toMatchObject({ contentMarkdown: "first body", version: 1 })
    expect(result[key("msg_a", 2)]).toMatchObject({ contentMarkdown: "second body", version: 2 })
  })

  it("an unpinned legacy reference hydrates at the current revision under the bare key", async () => {
    stubSource()
    const result = await hydrateSharedMessageRefs({} as any, "ws_1", VIEWER_ID, [ref("msg_a")])
    expect(result["shared:msg_a"]).toMatchObject({
      state: "ok",
      contentMarkdown: "second body",
      version: 2,
      currentRevision: 2,
    })
  })
})

describe("hydrateSharedMessageRefs", () => {
  it("returns an empty map when given no ids", async () => {
    const result = await hydrateSharedMessageRefs({} as any, "ws_1", VIEWER_ID, [])
    expect(result).toEqual({})
  })

  it("returns ok-state payloads when viewer can access the source stream", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([["msg_a", makeMessage({ id: "msg_a" })]])
    )
    spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_author", name: "Ada" } as any])
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
    stubFullAccess()

    const result = await hydrateSharedMessageRefs({} as any, "ws_1", VIEWER_ID, [ref("msg_a")])
    expect(result[key("msg_a")]).toMatchObject({
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
    const result = await hydrateSharedMessageRefs({} as any, "ws_1", VIEWER_ID, [ref("msg_a")])
    expect(result[key("msg_a")]).toEqual({ type: "sharedMessage", state: "deleted", messageId: "msg_a", deletedAt })
  })

  it("returns missing payloads for ids that resolve to no row", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(new Map())
    stubAuthorLookups()
    stubFullAccess()
    const result = await hydrateSharedMessageRefs({} as any, "ws_1", VIEWER_ID, [ref("msg_missing")])
    expect(result[key("msg_missing")]).toEqual({ type: "sharedMessage", state: "missing", messageId: "msg_missing" })
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

    const result = await hydrateSharedMessageRefs({} as any, "ws_1", VIEWER_ID, [ref("msg_a")])
    expect(result[key("msg_a")]).toEqual({
      type: "sharedMessage",
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

    const result = await hydrateSharedMessageRefs({} as any, "ws_1", VIEWER_ID, [ref("msg_a")])
    expect(result[key("msg_a")]).toEqual({
      type: "sharedMessage",
      state: "private",
      messageId: "msg_a",
      sourceStreamKind: "channel",
      sourceVisibility: "public",
    })
    expect(findStreams).toHaveBeenCalledTimes(2)
  })

  it("presents an aside source as scratchpad in the private placeholder", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([["msg_a", makeMessage({ id: "msg_a" })]])
    )
    stubAuthorLookups()
    stubNoAccess()
    spyOn(StreamRepository, "findByIds").mockResolvedValue([
      {
        id: "stream_source",
        type: "aside",
        visibility: "private",
        rootStreamId: null,
      } as any,
    ])

    const result = await hydrateSharedMessageRefs({} as any, "ws_1", VIEWER_ID, [ref("msg_a")])
    expect(result[key("msg_a")]).toEqual({
      type: "sharedMessage",
      state: "private",
      messageId: "msg_a",
      sourceStreamKind: "scratchpad",
      sourceVisibility: "private",
    })
  })

  it("presents a thread inside an aside as scratchpad in the private placeholder", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([["msg_a", makeMessage({ id: "msg_a" })]])
    )
    stubAuthorLookups()
    stubNoAccess()
    spyOn(StreamRepository, "findByIds")
      .mockResolvedValueOnce([
        {
          id: "stream_source",
          type: "thread",
          visibility: "private",
          rootStreamId: "stream_aside",
        } as any,
      ])
      .mockResolvedValueOnce([
        {
          id: "stream_aside",
          type: "aside",
          visibility: "private",
          rootStreamId: null,
        } as any,
      ])

    const result = await hydrateSharedMessageRefs({} as any, "ws_1", VIEWER_ID, [ref("msg_a")])
    expect(result[key("msg_a")]).toEqual({
      type: "sharedMessage",
      state: "private",
      messageId: "msg_a",
      sourceStreamKind: "scratchpad",
      sourceVisibility: "private",
    })
  })

  it("treats source-via-share-grant as accessible even when not a stream member", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([["msg_a", makeMessage({ id: "msg_a" })]])
    )
    stubAuthorLookups()
    spyOn(streamsBarrel, "listAccessibleStreamIds").mockResolvedValue(new Set()) // not a member
    spyOn(SharedMessageRepository, "listSourcesGrantedToViewer").mockResolvedValue(new Set(["msg_a"])) // but has share grant

    const result = await hydrateSharedMessageRefs({} as any, "ws_1", VIEWER_ID, [ref("msg_a")])
    expect(result[key("msg_a")]).toMatchObject({ state: "ok", messageId: "msg_a" })
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

    const result = await hydrateSharedMessageRefs({} as any, "ws_1", VIEWER_ID, [ref("msg_0")])

    // 0..(MAX-1) are fetched and hydrated as ok
    for (let i = 0; i < MAX_HYDRATION_DEPTH; i++) {
      expect(result[key(`msg_${i}`)]).toMatchObject({ state: "ok" })
    }
    // The truncated entry reports the LIVE streamId from the row, not the
    // stale cached attr — the fix for "shared_messages cached streamId goes
    // stale after batch move-to-thread".
    expect(result[key(`msg_${MAX_HYDRATION_DEPTH}`)]).toEqual({
      type: "sharedMessage",
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

    const result = await hydrateSharedMessageRefs({} as any, "ws_1", VIEWER_ID, [ref("msg_0")])
    expect(result[key(`msg_${MAX_HYDRATION_DEPTH}`)]).toEqual({
      type: "sharedMessage",
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

    const result = await hydrateSharedMessageRefs({} as any, "ws_1", VIEWER_ID, [ref("msg_0")])
    expect(result[key(`msg_${MAX_HYDRATION_DEPTH}`)]).toEqual({
      type: "sharedMessage",
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

    const result = await hydrateSharedMessageRefs({} as any, "ws_1", VIEWER_ID, [ref("msg_0")])
    expect(result[key(`msg_${MAX_HYDRATION_DEPTH}`)]).toEqual({
      type: "sharedMessage",
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

    const result = await hydrateSharedMessageRefs({} as any, "ws_1", VIEWER_ID, [ref("msg_outer")])
    expect(result[key("msg_outer")]).toMatchObject({ state: "ok" })
    expect(result[key("msg_inner")]).toEqual({
      type: "sharedMessage",
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
              safetyStatus: "clean",
            } as any,
          ],
        ],
      ])
    )

    const result = await hydrateSharedMessageRefs({} as any, "ws_1", VIEWER_ID, [ref("msg_a")])
    expect(result[key("msg_a")]).toMatchObject({
      state: "ok",
      attachments: [{ id: "att_pic", filename: "screenshot.png", mimeType: "image/png", sizeBytes: 1234 }],
    })
    // Non-video attachments must NOT carry processingStatus on the wire —
    // the field is exclusively for video transcoding state, mirroring
    // event-service.ts's emit logic so the wire payload stays consistent.
    expect(
      (result[key("msg_a")] as { attachments: Array<{ processingStatus?: string }> }).attachments[0].processingStatus
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

    const result = await hydrateSharedMessageRefs({} as any, "ws_1", VIEWER_ID, [ref("msg_a")])
    expect(result[key("msg_a")]).toMatchObject({ state: "ok", attachments: [] })
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

    await hydrateSharedMessageRefs({} as any, "ws_1", VIEWER_ID, [ref("msg_a"), ref("msg_b")])
    expect(findAttachments).toHaveBeenCalledTimes(1)
    const calledWith = (findAttachments as any).mock.calls[0][1].sort()
    expect(calledWith).toEqual(["msg_a", "msg_b"])
  })

  it("does not fetch attachments when no ok-state messages survive", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(new Map())
    stubAuthorLookups()
    stubFullAccess()
    const findAttachments = spyOn(AttachmentRepository, "findByMessageIds").mockResolvedValue(new Map())

    const result = await hydrateSharedMessageRefs({} as any, "ws_1", VIEWER_ID, [ref("msg_missing")])
    expect(result[key("msg_missing")]).toEqual({ type: "sharedMessage", state: "missing", messageId: "msg_missing" })
    expect(findAttachments).not.toHaveBeenCalled()
  })
})

describe("hydrateSharedMessageRefsForRoom", () => {
  it("hydrates depth-1 grants uniformly without viewer access", async () => {
    const deletedAt = new Date("2026-02-01")
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([
        ["msg_ok", makeMessage({ id: "msg_ok", streamId: "stream_private" })],
        ["msg_deleted", makeMessage({ id: "msg_deleted", streamId: "stream_private", deletedAt })],
      ])
    )
    spyOn(streamsBarrel, "listRoomReadableStreamIds").mockResolvedValue(new Set())
    spyOn(SharedMessageRepository, "listSourcesGrantedToRoom").mockResolvedValue(new Set(["msg_ok", "msg_deleted"]))
    spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_author", name: "Ada" } as any])
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])

    const result = await hydrateSharedMessageRefsForRoom({} as any, "ws_1", "stream_target", [
      ref("msg_ok"),
      ref("msg_deleted"),
      ref("msg_missing"),
    ])

    expect(result).toMatchObject({
      [key("msg_ok")]: {
        type: "sharedMessage",
        state: "ok",
        messageId: "msg_ok",
        authorName: "Ada",
        attachments: [],
      },
      [key("msg_deleted")]: { type: "sharedMessage", state: "deleted", messageId: "msg_deleted", deletedAt },
      [key("msg_missing")]: { type: "sharedMessage", state: "missing", messageId: "msg_missing" },
    })
  })

  it("hydrates a nested pointer into a public stream as ok with no grant rows", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockImplementation(async (_db, _ws, ids) => {
      const map = new Map<string, any>()
      for (const id of ids) {
        if (id === "msg_outer") {
          map.set(
            id,
            makeMessage({
              id,
              streamId: "stream_target",
              contentJson: {
                type: "doc",
                content: [{ type: "sharedMessage", attrs: { messageId: "msg_inner", streamId: "stream_public" } }],
              },
            })
          )
        } else if (id === "msg_inner") {
          map.set(id, makeMessage({ id, streamId: "stream_public" }))
        }
      }
      return map
    })
    stubAuthorLookups()
    spyOn(streamsBarrel, "listRoomReadableStreamIds").mockImplementation(async (_db, _ws, _room, candidates) => {
      return new Set([...candidates].filter((id) => id === "stream_target" || id === "stream_public"))
    })
    spyOn(SharedMessageRepository, "listSourcesGrantedToRoom").mockResolvedValue(new Set())

    const result = await hydrateSharedMessageRefsForRoom({} as any, "ws_1", "stream_target", [ref("msg_outer")])
    expect(result[key("msg_outer")]).toMatchObject({ type: "sharedMessage", state: "ok", messageId: "msg_outer" })
    expect(result[key("msg_inner")]).toMatchObject({
      type: "sharedMessage",
      state: "ok",
      messageId: "msg_inner",
      streamId: "stream_public",
    })
  })

  it("renders a nested pointer into a private stream as a private placeholder reporting the root's kind/visibility", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockImplementation(async (_db, _ws, ids) => {
      const map = new Map<string, any>()
      for (const id of ids) {
        if (id === "msg_outer") {
          map.set(
            id,
            makeMessage({
              id,
              streamId: "stream_target",
              contentJson: {
                type: "doc",
                content: [{ type: "sharedMessage", attrs: { messageId: "msg_inner", streamId: "stream_thread" } }],
              },
            })
          )
        } else if (id === "msg_inner") {
          map.set(id, makeMessage({ id, streamId: "stream_thread" }))
        }
      }
      return map
    })
    stubAuthorLookups()
    spyOn(streamsBarrel, "listRoomReadableStreamIds").mockImplementation(async (_db, _ws, _room, candidates) => {
      // A thread under a private root is not room-readable; only the room itself is.
      return new Set([...candidates].filter((id) => id === "stream_target"))
    })
    spyOn(SharedMessageRepository, "listSourcesGrantedToRoom").mockResolvedValue(new Set())
    spyOn(StreamRepository, "findByIds")
      .mockResolvedValueOnce([
        { id: "stream_thread", type: "thread", visibility: "private", rootStreamId: "stream_root" } as any,
      ])
      .mockResolvedValueOnce([{ id: "stream_root", type: "channel", visibility: "private", rootStreamId: null } as any])

    const result = await hydrateSharedMessageRefsForRoom({} as any, "ws_1", "stream_target", [ref("msg_outer")])
    expect(result[key("msg_outer")]).toMatchObject({ type: "sharedMessage", state: "ok", messageId: "msg_outer" })
    expect(result[key("msg_inner")]).toEqual({
      type: "sharedMessage",
      state: "private",
      messageId: "msg_inner",
      sourceStreamKind: "channel",
      sourceVisibility: "private",
    })
  })

  it("emits truncated with the live streamId for a public chain past MAX_HYDRATION_DEPTH", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockImplementation(async (_db, _ws, ids) => {
      const map = new Map<string, any>()
      for (const id of ids) {
        const next = id.replace(/^msg_(\d+)$/, (_m, n) => `msg_${Number(n) + 1}`)
        map.set(
          id,
          makeMessage({
            id,
            streamId: id === `msg_${MAX_HYDRATION_DEPTH}` ? "stream_live" : "stream_public",
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
    // Every source resolves to a public root → room-readable at every level.
    spyOn(streamsBarrel, "listRoomReadableStreamIds").mockImplementation(async (_db, _ws, _room, candidates) => {
      return new Set(candidates)
    })
    spyOn(SharedMessageRepository, "listSourcesGrantedToRoom").mockResolvedValue(new Set())

    const result = await hydrateSharedMessageRefsForRoom({} as any, "ws_1", "stream_target", [ref("msg_0")])
    for (let i = 0; i < MAX_HYDRATION_DEPTH; i++) {
      expect(result[key(`msg_${i}`)]).toMatchObject({ state: "ok" })
    }
    expect(result[key(`msg_${MAX_HYDRATION_DEPTH}`)]).toEqual({
      type: "sharedMessage",
      state: "truncated",
      messageId: `msg_${MAX_HYDRATION_DEPTH}`,
      streamId: "stream_live",
    })
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

describe("toDualSlotMaps", () => {
  const entry = { type: "sharedMessage", state: "missing", messageId: "msg_a" } as const

  it("expresses one hydration result as canonical namespaced + legacy bare-key maps with identical values", () => {
    const dual = toDualSlotMaps({ [key("msg_a")]: entry, [key("msg_b")]: { ...entry, messageId: "msg_b" } })
    expect(dual.slots).toEqual({
      "shared:msg_a": entry,
      "shared:msg_b": { ...entry, messageId: "msg_b" },
    })
    expect(dual.sharedMessages).toEqual({ msg_a: entry, msg_b: { ...entry, messageId: "msg_b" } })
    // Same object references — only the key scheme differs.
    expect(dual.slots["shared:msg_a"]).toBe(dual.sharedMessages.msg_a)
  })

  it("returns two empty maps for an empty hydration result", () => {
    expect(toDualSlotMaps({})).toEqual({ slots: {}, sharedMessages: {} })
  })

  it("gives the legacy bare key the whole-message slot when a source is also referenced by range", () => {
    const ok = {
      type: "sharedMessage",
      state: "ok",
      messageId: "msg_a",
      contentMarkdown: "whole",
      version: 2,
      currentRevision: 2,
      range: null,
    } as any
    const ranged = { ...ok, contentMarkdown: "part", range: { from: 1, to: 4 } }

    const dual = toDualSlotMaps({ [key("msg_a", 2, { from: 1, to: 4 })]: ranged, [key("msg_a", 2)]: ok })
    // The bare key rides along for tabs still on a pre-pin bundle, and it gets
    // the whole-message slot rather than the span.
    expect(Object.keys(dual.slots).sort()).toEqual(["shared:msg_a", "shared:msg_a@2", "shared:msg_a@2:1-4"])
    expect(dual.slots["shared:msg_a"]).toBe(ok)
    expect(dual.sharedMessages.msg_a).toBe(ok)
  })
})

describe("hydrateSharedMessageRefsForAccessibleSet", () => {
  it("hydrates a source directly readable in the accessible set as ok", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([["msg_a", makeMessage({ id: "msg_a" })]])
    )
    spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_author", name: "Ada" } as any])
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
    const grantSpy = spyOn(SharedMessageRepository, "listSourcesGrantedToAnyStream").mockResolvedValue(new Set())

    const result = await hydrateSharedMessageRefsForAccessibleSet({} as any, "ws_1", new Set(["stream_source"]), [
      ref("msg_a"),
    ])
    expect(result[key("msg_a")]).toMatchObject({ state: "ok", messageId: "msg_a", streamId: "stream_source" })
    expect(grantSpy).toHaveBeenCalled()
  })

  it("hydrates a source reachable only via a share grant into a readable stream", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([["msg_a", makeMessage({ id: "msg_a", streamId: "stream_other" })]])
    )
    spyOn(UserRepository, "findByIds").mockResolvedValue([])
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
    // stream_other is NOT in the accessible set, but a grant reaches a readable target.
    spyOn(SharedMessageRepository, "listSourcesGrantedToAnyStream").mockResolvedValue(new Set(["msg_a"]))

    const result = await hydrateSharedMessageRefsForAccessibleSet({} as any, "ws_1", new Set(["stream_readable"]), [
      ref("msg_a"),
    ])
    expect(result[key("msg_a")]).toMatchObject({ state: "ok", messageId: "msg_a" })
  })

  it("renders a private placeholder when the source is neither readable nor granted", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([["msg_a", makeMessage({ id: "msg_a", streamId: "stream_other" })]])
    )
    stubAuthorLookups()
    spyOn(SharedMessageRepository, "listSourcesGrantedToAnyStream").mockResolvedValue(new Set())
    spyOn(StreamRepository, "findByIds").mockResolvedValue([
      { id: "stream_other", type: "channel", visibility: "private", rootStreamId: null } as any,
    ])

    const result = await hydrateSharedMessageRefsForAccessibleSet({} as any, "ws_1", new Set(["stream_readable"]), [
      ref("msg_a"),
    ])
    expect(result[key("msg_a")]).toEqual({
      type: "sharedMessage",
      state: "private",
      messageId: "msg_a",
      sourceStreamKind: "channel",
      sourceVisibility: "private",
    })
  })

  it("issues one grant lookup per level, not per source id (INV-56)", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([
        ["msg_a", makeMessage({ id: "msg_a" })],
        ["msg_b", makeMessage({ id: "msg_b" })],
        ["msg_c", makeMessage({ id: "msg_c" })],
      ])
    )
    spyOn(UserRepository, "findByIds").mockResolvedValue([])
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
    const grantSpy = spyOn(SharedMessageRepository, "listSourcesGrantedToAnyStream").mockResolvedValue(new Set())

    await hydrateSharedMessageRefsForAccessibleSet({} as any, "ws_1", new Set(["stream_source"]), [
      ref("msg_a"),
      ref("msg_b"),
      ref("msg_c"),
    ])
    // A single flat chain resolves in one level → exactly one grant query
    // carrying all three ids.
    expect(grantSpy).toHaveBeenCalledTimes(1)
    expect([...grantSpy.mock.calls[0][3]].sort()).toEqual(["msg_a", "msg_b", "msg_c"])
  })
})
