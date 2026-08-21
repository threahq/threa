import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import * as messaging from "../messaging"
import { resolvePublicMessageSlots } from "./message-slots"

afterEach(() => mock.restore())

const shareDoc = {
  type: "doc",
  content: [{ type: "sharedMessage", attrs: { messageId: "msg_src", streamId: "stream_src" } }],
}

describe("resolvePublicMessageSlots", () => {
  it("returns an empty map without running access resolution when no row references a share", async () => {
    const hydrate = spyOn(messaging, "hydrateSharedMessageRefsForAccessibleSet")
    const resolveAccessible = mock(async () => ["stream_1"])

    const slots = await resolvePublicMessageSlots({} as any, "ws_1", resolveAccessible, [
      { type: "doc", content: [{ type: "paragraph" }] },
      null,
      undefined,
    ])

    expect(slots).toEqual({})
    expect(resolveAccessible).not.toHaveBeenCalled()
    expect(hydrate).not.toHaveBeenCalled()
  })

  it("serializes the ok variant to markdown content, dropping contentJson and ISO-encoding dates", async () => {
    spyOn(messaging, "hydrateSharedMessageRefsForAccessibleSet").mockResolvedValue({
      "shared:msg_src": {
        type: "sharedMessage",
        state: "ok",
        messageId: "msg_src",
        streamId: "stream_src",
        authorId: "usr_1",
        authorType: "user",
        authorName: "Ada",
        contentJson: { type: "doc", content: [{ type: "paragraph" }] },
        contentMarkdown: "**hello**",
        editedAt: new Date("2026-02-01T00:00:00Z"),
        createdAt: new Date("2026-01-01T00:00:00Z"),
        attachments: [{ id: "att_1", filename: "f.png", mimeType: "image/png", sizeBytes: 10 }],
      } as any,
    })

    const slots = await resolvePublicMessageSlots({} as any, "ws_1", async () => ["stream_readable"], [shareDoc])

    expect(slots).toEqual({
      "shared:msg_src": {
        type: "sharedMessage",
        state: "ok",
        messageId: "msg_src",
        streamId: "stream_src",
        authorId: "usr_1",
        authorType: "user",
        authorDisplayName: "Ada",
        content: "**hello**",
        editedAt: "2026-02-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        attachments: [{ id: "att_1", filename: "f.png", mimeType: "image/png", sizeBytes: 10 }],
      },
    })
    // The canonical rich-text JSON never reaches the public wire (INV-58).
    expect((slots["shared:msg_src"] as Record<string, unknown>).contentJson).toBeUndefined()
  })

  it("omits authorDisplayName when the hydrated author name is null", async () => {
    spyOn(messaging, "hydrateSharedMessageRefsForAccessibleSet").mockResolvedValue({
      "shared:msg_src": {
        type: "sharedMessage",
        state: "ok",
        messageId: "msg_src",
        streamId: "stream_src",
        authorId: "usr_1",
        authorType: "user",
        authorName: null,
        contentJson: { type: "doc" },
        contentMarkdown: "x",
        editedAt: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        attachments: [],
      } as any,
    })

    const slots = await resolvePublicMessageSlots({} as any, "ws_1", async () => ["s"], [shareDoc])
    expect(slots["shared:msg_src"]).not.toHaveProperty("authorDisplayName")
    expect((slots["shared:msg_src"] as { editedAt: string | null }).editedAt).toBeNull()
  })

  it("preserves the privacy-safe placeholder variants verbatim", async () => {
    spyOn(messaging, "hydrateSharedMessageRefsForAccessibleSet").mockResolvedValue({
      "shared:msg_del": {
        type: "sharedMessage",
        state: "deleted",
        messageId: "msg_del",
        deletedAt: new Date("2026-03-01T00:00:00Z"),
      },
      "shared:msg_miss": { type: "sharedMessage", state: "missing", messageId: "msg_miss" },
      "shared:msg_priv": {
        type: "sharedMessage",
        state: "private",
        messageId: "msg_priv",
        sourceStreamKind: "channel",
        sourceVisibility: "private",
      },
      "shared:msg_trunc": {
        type: "sharedMessage",
        state: "truncated",
        messageId: "msg_trunc",
        streamId: "stream_deep",
      },
    } as any)

    const doc = {
      type: "doc",
      content: [
        { type: "sharedMessage", attrs: { messageId: "msg_del" } },
        { type: "sharedMessage", attrs: { messageId: "msg_miss" } },
        { type: "sharedMessage", attrs: { messageId: "msg_priv" } },
        { type: "sharedMessage", attrs: { messageId: "msg_trunc" } },
      ],
    }
    const slots = await resolvePublicMessageSlots({} as any, "ws_1", async () => ["s"], [doc])

    expect(slots["shared:msg_del"]).toEqual({
      type: "sharedMessage",
      state: "deleted",
      messageId: "msg_del",
      deletedAt: "2026-03-01T00:00:00.000Z",
    })
    expect(slots["shared:msg_miss"]).toEqual({ type: "sharedMessage", state: "missing", messageId: "msg_miss" })
    expect(slots["shared:msg_priv"]).toEqual({
      type: "sharedMessage",
      state: "private",
      messageId: "msg_priv",
      sourceStreamKind: "channel",
      sourceVisibility: "private",
    })
    expect(slots["shared:msg_trunc"]).toEqual({
      type: "sharedMessage",
      state: "truncated",
      messageId: "msg_trunc",
      streamId: "stream_deep",
    })
  })

  it("collects pointers across every row and hydrates once against the resolved accessible set", async () => {
    const hydrate = spyOn(messaging, "hydrateSharedMessageRefsForAccessibleSet").mockResolvedValue({})
    const docA = { type: "doc", content: [{ type: "sharedMessage", attrs: { messageId: "msg_a" } }] }
    const docB = { type: "doc", content: [{ type: "sharedMessage", attrs: { messageId: "msg_b" } }] }

    await resolvePublicMessageSlots({} as any, "ws_1", async () => ["stream_x", "stream_y"], [docA, docB, docA])

    expect(hydrate).toHaveBeenCalledTimes(1)
    const [, ws, accessibleSet, refs] = hydrate.mock.calls[0] as unknown as [
      unknown,
      string,
      ReadonlySet<string>,
      Iterable<{ messageId: string }>,
    ]
    expect(ws).toBe("ws_1")
    expect([...accessibleSet].sort()).toEqual(["stream_x", "stream_y"])
    // Deduped across rows.
    expect([...refs].map((r) => r.messageId).sort()).toEqual(["msg_a", "msg_b"])
  })
})
