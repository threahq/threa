import { describe, it, expect } from "vitest"
import type { AttachmentSummary, JSONContent } from "@threa/types"
import type { CachedEvent } from "@/db"
import { contextItemsFromEvent } from "./rows"

const CTX = { workspaceId: "ws_1", streamId: "stream_thread", rootStreamId: "stream_root" }

function attachment(overrides: Partial<AttachmentSummary> & { id: string; mimeType: string }): AttachmentSummary {
  return { filename: "f", sizeBytes: 10, ...overrides }
}

function messageEvent(payload: Record<string, unknown>, createdAt = "2026-07-01T10:00:00.000Z"): CachedEvent {
  return {
    id: "event_1",
    workspaceId: "ws_1",
    streamId: "stream_thread",
    sequence: "42",
    _sequenceNum: 42,
    eventType: "message_created",
    payload,
    actorId: "usr_1",
    actorType: "user",
    createdAt,
    _cachedAt: 0,
  }
}

function doc(...content: JSONContent[]): JSONContent {
  return { type: "doc", content: [{ type: "paragraph", content }] }
}

describe("contextItemsFromEvent", () => {
  it("emits one row per artifact with the message's own timestamp and identity keys", () => {
    const rows = contextItemsFromEvent(
      messageEvent({
        messageId: "msg_1",
        contentMarkdown: "# Heading\nlook at [this](https://example.com/a)",
        contentJson: doc({
          type: "text",
          text: "this",
          marks: [{ type: "link", attrs: { href: "https://example.com/a" } }],
        }),
        attachments: [
          attachment({ id: "att_img", mimeType: "image/png" }),
          attachment({ id: "att_file", mimeType: "application/pdf" }),
        ],
      }),
      CTX
    )

    expect(rows.map((r) => r.key)).toEqual([
      "link:https://example.com/a:msg_1",
      "media:att_img:msg_1",
      "file:att_file:msg_1",
    ])
    expect(rows.map((r) => [r.category, r.refKind, r.refId])).toEqual([
      ["link", "url", "https://example.com/a"],
      ["media", "attachment", "att_img"],
      ["file", "attachment", "att_file"],
    ])
    expect(rows.every((r) => r.occurredAt === "2026-07-01T10:00:00.000Z")).toBe(true)
    expect(rows.every((r) => r.streamId === "stream_thread" && r.rootStreamId === "stream_root")).toBe(true)
    expect(rows.every((r) => r.sourceMessageId === "msg_1" && r.authorId === "usr_1")).toBe(true)
    // Snippet is the stripped first line (INV-60), not the raw markdown.
    expect(rows[0].snippet).toBe("Heading")
  })

  it("leaves groupKey equal to refId — the collapse key is server-computed", () => {
    const [row] = contextItemsFromEvent(
      messageEvent({
        messageId: "msg_1",
        contentMarkdown: "x",
        contentJson: doc({
          type: "text",
          text: "x",
          // A trailing slash + fragment the server's normalizer would strip.
          marks: [{ type: "link", attrs: { href: "https://Example.com/a/#frag" } }],
        }),
      }),
      CTX
    )
    expect(row.refId).toBe("https://Example.com/a/#frag")
    expect(row.groupKey).toBe("https://Example.com/a/#frag")
    expect(row.groupRef).toBe("link:https://Example.com/a/#frag")
  })

  it("splits media/file and mediaKind the way the server does", () => {
    const rows = contextItemsFromEvent(
      messageEvent({
        messageId: "msg_1",
        contentMarkdown: "",
        attachments: [
          attachment({ id: "a_gif", mimeType: "image/gif" }),
          attachment({ id: "a_gif_param", mimeType: "image/gif; charset=binary" }),
          attachment({ id: "a_png", mimeType: "image/png" }),
          attachment({ id: "a_mp4", mimeType: "video/mp4" }),
          attachment({ id: "a_zip", mimeType: "application/zip" }),
        ],
      }),
      CTX
    )
    expect(rows.map((r) => [r.refId, r.category, (r.detail as { mediaKind: string | null }).mediaKind])).toEqual([
      ["a_gif", "media", "gif"],
      // Parameterised mime is NOT a gif — equality, matching extract.ts.
      ["a_gif_param", "media", "image"],
      ["a_png", "media", "image"],
      ["a_mp4", "media", "video"],
      ["a_zip", "file", null],
    ])
  })

  it("emits a media row per inline Giphy embed", () => {
    const rows = contextItemsFromEvent(
      messageEvent({
        messageId: "msg_1",
        contentMarkdown: "",
        contentJson: {
          type: "doc",
          content: [
            {
              type: "giphyEmbed",
              attrs: { giphyUrl: "https://media.giphy.com/x.gif", title: "cat", width: 200, height: 100 },
            },
          ],
        },
      }),
      CTX
    )
    expect(rows.map((r) => r.key)).toEqual(["media:https://media.giphy.com/x.gif:msg_1"])
    expect(rows[0].refKind).toBe("giphy")
    expect(rows[0].detail).toMatchObject({
      mediaKind: "gif",
      giphyUrl: "https://media.giphy.com/x.gif",
      giphyTitle: "cat",
      attachmentId: null,
    })
  })

  it("dedupes repeated refs within one message", () => {
    const rows = contextItemsFromEvent(
      messageEvent({
        messageId: "msg_1",
        contentMarkdown: "",
        contentJson: doc(
          { type: "text", text: "a", marks: [{ type: "link", attrs: { href: "https://example.com/a" } }] },
          { type: "text", text: " " },
          { type: "text", text: "b", marks: [{ type: "link", attrs: { href: "https://example.com/a" } }] }
        ),
      }),
      CTX
    )
    expect(rows).toHaveLength(1)
  })

  it("skips non-http hrefs and over-long urls the server never projects", () => {
    const long = `https://example.com/${"x".repeat(2100)}`
    const rows = contextItemsFromEvent(
      messageEvent({
        messageId: "msg_1",
        contentMarkdown: "",
        contentJson: doc(
          { type: "text", text: "a", marks: [{ type: "link", attrs: { href: "mailto:a@b.com" } }] },
          { type: "text", text: "b", marks: [{ type: "link", attrs: { href: long } }] }
        ),
      }),
      CTX
    )
    expect(rows).toEqual([])
  })

  it("blocks the same hosts the server's isBlockedUrl blocks (shared lists)", () => {
    const rows = contextItemsFromEvent(
      messageEvent({
        messageId: "msg_1",
        contentMarkdown: "",
        contentJson: doc(
          { type: "text", text: "a", marks: [{ type: "link", attrs: { href: "http://0.10.0.1/x" } }] },
          { type: "text", text: "b", marks: [{ type: "link", attrs: { href: "http://[fd00::1]/x" } }] },
          {
            type: "text",
            text: "c",
            marks: [{ type: "link", attrs: { href: "https://metadata.google.internal/x" } }],
          }
        ),
      }),
      CTX
    )
    expect(rows).toEqual([])
  })

  it("collapses a ?ref= duplicate the way the server's TRACKING_PARAMS do", () => {
    const rows = contextItemsFromEvent(
      messageEvent({
        messageId: "msg_1",
        contentMarkdown: "",
        contentJson: doc(
          { type: "text", text: "a", marks: [{ type: "link", attrs: { href: "https://example.com/post" } }] },
          {
            type: "text",
            text: "b",
            marks: [{ type: "link", attrs: { href: "https://example.com/post?ref=threa" } }],
          }
        ),
      }),
      CTX
    )
    expect(rows.map((r) => r.key)).toEqual(["link:https://example.com/post:msg_1"])
  })

  it("anchors memo rows on the first surviving source and the latest source's timestamp", () => {
    // msg_9 is cited first but deleted (absent from the window); msg_10 and
    // msg_11 survive, msg_11 being the later of the two.
    const sources = new Map<string, CachedEvent>([
      [
        "msg_10",
        {
          ...messageEvent({ messageId: "msg_10" }, "2026-06-01T09:00:00.000Z"),
          id: "e10",
          actorId: "usr_2",
          sequence: "50",
        },
      ],
      [
        "msg_11",
        {
          ...messageEvent({ messageId: "msg_11" }, "2026-06-01T09:30:00.000Z"),
          id: "e11",
          actorId: "usr_3",
          sequence: "51",
        },
      ],
    ])
    const rows = contextItemsFromEvent(
      {
        ...messageEvent({}, "2026-07-01T10:00:00.000Z"),
        eventType: "memos:captured",
        payload: {
          memos: [
            {
              memoId: "memo_1",
              title: "Decision",
              knowledgeType: "decision",
              sourceMessageIds: ["msg_10", "msg_11"],
            },
            // No resolvable source — the server skips it, so must we.
            { memoId: "memo_2", title: "Fact", knowledgeType: "fact", sourceMessageIds: [] },
            // PARTIALLY resolvable: the server resolves sources workspace-wide,
            // this sees only a window, so anchoring on the resolvable subset
            // would key the row differently and never reconcile. Skip it.
            {
              memoId: "memo_3",
              title: "Partial",
              knowledgeType: "context",
              sourceMessageIds: ["msg_9", "msg_10"],
            },
          ],
        },
      },
      CTX,
      sources
    )
    expect(rows.map((r) => [r.key, r.sourceMessageId, r.occurredAt, r.authorId, r.sequence])).toEqual([
      ["memo:memo_1:msg_10", "msg_10", "2026-06-01T09:30:00.000Z", "usr_3", "51"],
    ])
    expect(rows[0].detail).toEqual({ title: "Decision", knowledgeType: "decision" })
    expect(rows[0].snippet).toBe("Decision")
  })

  it("collapses hrefs the server dedupes into one row (fragment / tracking params)", () => {
    const rows = contextItemsFromEvent(
      messageEvent({
        messageId: "msg_1",
        contentMarkdown: "",
        contentJson: doc(
          { type: "text", text: "a", marks: [{ type: "link", attrs: { href: "https://docs.example.com/guide" } }] },
          {
            type: "text",
            text: "b",
            marks: [{ type: "link", attrs: { href: "https://docs.example.com/guide#install" } }],
          },
          {
            type: "text",
            text: "c",
            marks: [{ type: "link", attrs: { href: "https://docs.example.com/guide?utm_source=x" } }],
          },
          { type: "text", text: "d", marks: [{ type: "link", attrs: { href: "https://DOCS.example.com/guide/" } }] }
        ),
      }),
      CTX
    )
    // One row, keyed on the FIRST raw href — the same one the server projects.
    expect(rows.map((r) => r.key)).toEqual(["link:https://docs.example.com/guide:msg_1"])
  })

  it("ignores events that carry no context artifacts", () => {
    expect(contextItemsFromEvent({ ...messageEvent({}), eventType: "thread_created" }, CTX)).toEqual([])
    // A message event without a messageId can't be keyed.
    expect(contextItemsFromEvent(messageEvent({ contentMarkdown: "hi" }), CTX)).toEqual([])
  })

  /**
   * Parity seam: these are the exact keys `contextRowsForMessage`
   * (apps/backend/src/features/stream-context/extract.ts) produces for the same
   * message. Pinned as literals — the frontend test setup can't import backend
   * code, and the whole reconcile collapses if the two spellings drift.
   */
  it("produces the same keys the backend projection writes for the same message", () => {
    const rows = contextItemsFromEvent(
      messageEvent({
        messageId: "msg_parity",
        contentMarkdown: "see [docs](https://example.com/docs)",
        contentJson: doc({
          type: "text",
          text: "docs",
          marks: [{ type: "link", attrs: { href: "https://example.com/docs" } }],
        }),
        attachments: [
          attachment({ id: "att_1", mimeType: "image/gif" }),
          attachment({ id: "att_2", mimeType: "text/csv" }),
        ],
      }),
      CTX
    )
    expect(new Set(rows.map((r) => r.key))).toEqual(
      new Set(["link:https://example.com/docs:msg_parity", "media:att_1:msg_parity", "file:att_2:msg_parity"])
    )
  })
})
