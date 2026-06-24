import { beforeEach, describe, expect, it } from "vitest"
import type { JSONContent } from "@threa/types"
import type { CachedEvent } from "@/db"
import { deriveStreamContext } from "./derive"
import type { FileContextItem, LinkContextItem, MediaContextItem, ThreadContextItem } from "./types"

let seq = 0
beforeEach(() => {
  seq = 0
})

/** A one-paragraph doc whose text nodes carry `link` marks for each URL. */
function linkDoc(...urls: string[]): JSONContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: urls.map((url) => ({ type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] })),
      },
    ],
  }
}

/** A one-paragraph doc holding a single inline Giphy embed. */
function giphyDoc(giphyUrl: string, attrs: { title?: string; width?: number; height?: number } = {}): JSONContent {
  return { type: "doc", content: [{ type: "giphyEmbed", attrs: { giphyUrl, ...attrs } }] }
}
function messageEvent(createdAt: string, payload: Record<string, unknown>): CachedEvent {
  seq += 1
  return {
    id: `evt_${seq}`,
    workspaceId: "ws_1",
    streamId: "stream_1",
    sequence: String(seq),
    _sequenceNum: seq,
    eventType: "message_created",
    payload: { messageId: `msg_${seq}`, contentMarkdown: "", ...payload },
    actorId: "usr_1",
    actorType: "user",
    createdAt,
    _cachedAt: 0,
  }
}

function memosCapturedEvent(createdAt: string, memos: unknown[]): CachedEvent {
  seq += 1
  return {
    id: `evt_${seq}`,
    workspaceId: "ws_1",
    streamId: "stream_1",
    sequence: String(seq),
    _sequenceNum: seq,
    eventType: "memos:captured",
    payload: { conversationId: "conv_1", memos },
    actorId: null,
    actorType: null,
    createdAt,
    _cachedAt: 0,
  }
}

describe("deriveStreamContext", () => {
  it("returns an empty result for no events", () => {
    const result = deriveStreamContext(undefined)
    expect(result.total).toBe(0)
    expect(result.items).toEqual([])
    expect(result.counts).toEqual({ link: 0, media: 0, file: 0, memo: 0, thread: 0 })
  })

  it("extracts external links from rich previews and the document body, with a github badge", () => {
    const events = [
      messageEvent("2026-06-23T10:00:00.000Z", {
        contentJson: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "see " },
                {
                  type: "text",
                  text: "the PR",
                  marks: [{ type: "link", attrs: { href: "https://github.com/acme/repo/pull/42" } }],
                },
                { type: "text", text: " and https://example.com/docs" },
              ],
            },
          ],
        },
        linkPreviews: [
          {
            id: "lp_1",
            url: "https://github.com/acme/repo/pull/42",
            title: "Fix the thing",
            description: null,
            imageUrl: null,
            faviconUrl: "https://github.com/favicon.ico",
            siteName: "GitHub",
            contentType: "website",
            previewType: "github_pr",
            position: 0,
          },
        ],
      }),
    ]

    const { items, counts } = deriveStreamContext(events)
    expect(counts.link).toBe(2)

    const pr = items.find((i): i is LinkContextItem => i.category === "link" && i.url.includes("/pull/42"))
    expect(pr?.title).toBe("Fix the thing")
    expect(pr?.previewKind).toBe("github")
    expect(pr?.badge).toBe("PR")
    expect(pr?.sourceMessageId).toBe("msg_1")

    // The plain-text URL in the body with no preview still surfaces.
    const bare = items.find((i): i is LinkContextItem => i.category === "link" && i.url.includes("example.com"))
    expect(bare?.title).toBeNull()
    expect(bare?.badge).toBeNull()
  })

  it("reads links from contentJson, so a bold link keeps a clean URL (no trailing ** leak)", () => {
    const events = [
      messageEvent("2026-06-23T10:00:00.000Z", {
        // Serialized, this is `**[https://example.com](https://example.com)**`;
        // reading the `link` mark's href keeps the `**` out of the URL.
        contentJson: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "https://example.com",
                  marks: [{ type: "link", attrs: { href: "https://example.com" } }, { type: "bold" }],
                },
              ],
            },
          ],
        },
      }),
    ]

    const links = deriveStreamContext(events).items.filter((i): i is LinkContextItem => i.category === "link")
    expect(links).toHaveLength(1)
    expect(links[0].url).toBe("https://example.com")
  })

  it("keeps an authoritative link href verbatim when its last character is significant", () => {
    const events = [
      messageEvent("2026-06-23T10:00:00.000Z", {
        contentJson: linkDoc("https://example.com/Yahoo!"),
      }),
    ]

    const links = deriveStreamContext(events).items.filter((i): i is LinkContextItem => i.category === "link")
    expect(links).toHaveLength(1)
    expect(links[0].url).toBe("https://example.com/Yahoo!")
  })

  it("dedups a repeated link by URL, keeps the newest occurrence, and counts refs", () => {
    const events = [
      messageEvent("2026-06-23T09:00:00.000Z", {
        contentJson: linkDoc("https://example.com/page/"),
      }),
      messageEvent("2026-06-23T11:00:00.000Z", {
        contentJson: linkDoc("https://example.com/page"),
      }),
    ]

    const links = deriveStreamContext(events).items.filter((i): i is LinkContextItem => i.category === "link")
    expect(links).toHaveLength(1)
    expect(links[0].refCount).toBe(2)
    // Trailing-slash difference collapses; the newest message wins the origin.
    expect(links[0].sourceMessageId).toBe("msg_2")
  })

  it("excludes in-app message_link previews from the links list", () => {
    const events = [
      messageEvent("2026-06-23T10:00:00.000Z", {
        linkPreviews: [
          {
            id: "lp_1",
            url: "https://app.threa.io/w/ws_1/s/stream_2?m=msg_x",
            title: "A shared message",
            description: null,
            imageUrl: null,
            faviconUrl: null,
            siteName: null,
            contentType: "message_link",
            position: 0,
          },
        ],
      }),
    ]
    expect(deriveStreamContext(events).counts.link).toBe(0)
  })

  it("buckets image/gif/video attachments as media and others as files", () => {
    const events = [
      messageEvent("2026-06-23T10:00:00.000Z", {
        attachments: [
          { id: "att_img", filename: "shot.png", mimeType: "image/png", sizeBytes: 1000, width: 800, height: 600 },
          { id: "att_gif", filename: "loop.gif", mimeType: "image/gif", sizeBytes: 2000 },
          { id: "att_vid", filename: "clip.mp4", mimeType: "video/mp4", sizeBytes: 3000, processingStatus: "ready" },
          { id: "att_pdf", filename: "spec.pdf", mimeType: "application/pdf", sizeBytes: 4000 },
        ],
      }),
    ]

    const { items, counts } = deriveStreamContext(events)
    expect(counts.media).toBe(3)
    expect(counts.file).toBe(1)

    const gif = items.find((i): i is MediaContextItem => i.category === "media" && i.attachmentId === "att_gif")
    expect(gif?.mediaKind).toBe("gif")
    const video = items.find((i): i is MediaContextItem => i.category === "media" && i.attachmentId === "att_vid")
    expect(video?.mediaKind).toBe("video")
    const pdf = items.find((i): i is FileContextItem => i.category === "file")
    expect(pdf?.fileCategory).toBe("pdf")
    expect(pdf?.filename).toBe("spec.pdf")
  })

  it("extracts inline Giphy GIFs as media", () => {
    const events = [
      messageEvent("2026-06-23T10:00:00.000Z", {
        contentJson: giphyDoc("https://media.giphy.com/media/abc/giphy.gif", {
          title: "party",
          width: 200,
          height: 150,
        }),
      }),
    ]
    const media = deriveStreamContext(events).items.filter((i): i is MediaContextItem => i.category === "media")
    expect(media).toHaveLength(1)
    expect(media[0].mediaKind).toBe("gif")
    expect(media[0].giphyUrl).toContain("giphy.com")
    expect(media[0].attachmentId).toBeNull()
  })

  it("derives memories from memos:captured events", () => {
    const events = [
      memosCapturedEvent("2026-06-23T10:00:00.000Z", [
        {
          memoId: "memo_1",
          title: "We chose Postgres",
          knowledgeType: "decision",
          sourceMessageIds: ["msg_a", "msg_b"],
        },
      ]),
    ]
    const { items, counts } = deriveStreamContext(events)
    expect(counts.memo).toBe(1)
    const memo = items[0]
    expect(memo.category).toBe("memo")
    if (memo.category === "memo") {
      expect(memo.memoId).toBe("memo_1")
      expect(memo.knowledgeType).toBe("decision")
      expect(memo.sourceMessageId).toBe("msg_a")
    }
  })

  it("derives threads from messages with replies and orders by last reply", () => {
    const events = [
      messageEvent("2026-06-23T10:00:00.000Z", {
        contentMarkdown: "Parent message",
        threadId: "stream_thread_1",
        replyCount: 3,
        threadSummary: {
          lastReplyAt: "2026-06-23T12:00:00.000Z",
          participants: [],
          latestReply: { messageId: "msg_r", actorId: "usr_2", actorType: "user", contentMarkdown: "latest reply" },
        },
      }),
    ]
    const thread = deriveStreamContext(events).items.find((i): i is ThreadContextItem => i.category === "thread")
    expect(thread?.threadId).toBe("stream_thread_1")
    expect(thread?.replyCount).toBe(3)
    expect(thread?.lastReplyPreview).toBe("latest reply")
    expect(thread?.createdAt).toBe("2026-06-23T12:00:00.000Z")
  })

  it("orders all items newest-first across categories", () => {
    const events = [
      messageEvent("2026-06-23T08:00:00.000Z", { contentJson: linkDoc("https://a.example.com") }),
      messageEvent("2026-06-23T09:00:00.000Z", {
        attachments: [{ id: "att_1", filename: "x.pdf", mimeType: "application/pdf", sizeBytes: 10 }],
      }),
      memosCapturedEvent("2026-06-23T10:00:00.000Z", [
        { memoId: "memo_1", title: "T", knowledgeType: "learning", sourceMessageIds: ["msg_z"] },
      ]),
    ]
    const cats = deriveStreamContext(events).items.map((i) => i.category)
    expect(cats).toEqual(["memo", "file", "link"])
  })
})
