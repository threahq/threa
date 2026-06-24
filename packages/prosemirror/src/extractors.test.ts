import { describe, expect, it } from "bun:test"
import type { JSONContent } from "@threa/types"
import {
  collectAttachmentReferenceIds,
  collectGiphyEmbeds,
  collectLinkUrls,
  collectMentionSlugs,
  collectQuoteReplyMessageIds,
} from "./extractors"

const quoteReply = (messageId: string): JSONContent => ({
  type: "quoteReply",
  attrs: { messageId, snippet: "quoted text", authorId: "usr_x", streamId: "stream_x", actorType: "user" },
})

const mention = (slug: string): JSONContent => ({
  type: "mention",
  attrs: { id: slug, slug, mentionType: "bot" },
})

const reference = (id: string, status: string = "uploaded"): JSONContent => ({
  type: "attachmentReference",
  attrs: {
    id,
    filename: `${id}.pdf`,
    mimeType: "application/pdf",
    sizeBytes: 1024,
    status,
    imageIndex: null,
    error: null,
  },
})

describe("collectAttachmentReferenceIds", () => {
  it("returns ids in document order across nested blocks", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "see " }, reference("attach_a"), reference("attach_b")],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [reference("attach_c")],
                },
              ],
            },
          ],
        },
      ],
    }

    expect(collectAttachmentReferenceIds(doc)).toEqual(["attach_a", "attach_b", "attach_c"])
  })

  it("filters uploading and error nodes", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            reference("attach_ok", "uploaded"),
            reference("attach_pending", "uploading"),
            reference("attach_failed", "error"),
          ],
        },
      ],
    }

    expect(collectAttachmentReferenceIds(doc)).toEqual(["attach_ok"])
  })

  it("dedupes repeats while preserving first-seen order", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [reference("attach_x"), reference("attach_y"), reference("attach_x")],
        },
      ],
    }

    expect(collectAttachmentReferenceIds(doc)).toEqual(["attach_x", "attach_y"])
  })

  it("returns empty array for documents without attachment references", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hello world" }] }],
    }

    expect(collectAttachmentReferenceIds(doc)).toEqual([])
  })

  it("ignores nodes with missing or empty id", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "attachmentReference", attrs: { status: "uploaded" } },
            { type: "attachmentReference", attrs: { id: "", status: "uploaded" } },
            reference("attach_real"),
          ],
        },
      ],
    }

    expect(collectAttachmentReferenceIds(doc)).toEqual(["attach_real"])
  })
})

describe("collectQuoteReplyMessageIds", () => {
  it("returns quoted message ids in document order across nested blocks", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        quoteReply("msg_a"),
        { type: "paragraph", content: [{ type: "text", text: "håller med" }] },
        {
          type: "blockquote",
          content: [{ type: "paragraph", content: [quoteReply("msg_b")] }],
        },
      ],
    }

    expect(collectQuoteReplyMessageIds(doc)).toEqual(["msg_a", "msg_b"])
  })

  it("dedupes repeats while preserving first-seen order", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [quoteReply("msg_a"), quoteReply("msg_b"), quoteReply("msg_a")],
    }

    expect(collectQuoteReplyMessageIds(doc)).toEqual(["msg_a", "msg_b"])
  })

  it("ignores quoteReply nodes with missing or empty messageId", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        { type: "quoteReply", attrs: { snippet: "no id" } },
        { type: "quoteReply", attrs: { messageId: "" } },
        quoteReply("msg_real"),
      ],
    }

    expect(collectQuoteReplyMessageIds(doc)).toEqual(["msg_real"])
  })

  it("returns empty array for documents without quote replies", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
    }

    expect(collectQuoteReplyMessageIds(doc)).toEqual([])
  })
})

describe("collectMentionSlugs", () => {
  it("returns slugs in document order across nested blocks, keeping duplicates", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "hey " },
            mention("ariadne"),
            { type: "text", text: " and " },
            mention("scout"),
          ],
        },
        {
          type: "blockquote",
          content: [{ type: "paragraph", content: [mention("ariadne")] }],
        },
      ],
    }

    expect(collectMentionSlugs(doc)).toEqual(["ariadne", "scout", "ariadne"])
  })

  it("collects non-ASCII slugs the editor produced (no ASCII pattern involved)", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [mention("аріадна"), mention("研究員")],
        },
      ],
    }

    expect(collectMentionSlugs(doc)).toEqual(["аріадна", "研究員"])
  })

  it("lowercases slugs", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [mention("Ariadne")] }],
    }

    expect(collectMentionSlugs(doc)).toEqual(["ariadne"])
  })

  it("ignores plain text that merely looks like a mention", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "email test@example.com mentions @nobody as text" }],
        },
      ],
    }

    expect(collectMentionSlugs(doc)).toEqual([])
  })

  it("ignores mention nodes with missing or empty slug", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: "x", mentionType: "bot" } },
            { type: "mention", attrs: { id: "y", slug: "", mentionType: "bot" } },
            mention("real"),
          ],
        },
      ],
    }

    expect(collectMentionSlugs(doc)).toEqual(["real"])
  })
})

const linkText = (text: string, href: string, extraMarks: { type: string }[] = []): JSONContent => ({
  type: "text",
  text,
  marks: [{ type: "link", attrs: { href } }, ...extraMarks],
})

describe("collectLinkUrls", () => {
  it("reads the href from a link mark, even when the link is also bold", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [linkText("the PR", "https://github.com/acme/repo/pull/42", [{ type: "bold" }])],
        },
      ],
    }

    expect(collectLinkUrls(doc)).toEqual(["https://github.com/acme/repo/pull/42"])
  })

  it("does not let bold emphasis leak into a bare URL (the markdown-parse bug)", () => {
    // An autolinked URL inside a bold span. Reading the href keeps it clean;
    // a regex over the serialized `**https://example.com**` would capture the
    // trailing `**`.
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [linkText("https://example.com", "https://example.com", [{ type: "bold" }])],
        },
      ],
    }

    expect(collectLinkUrls(doc)).toEqual(["https://example.com"])
  })

  it("finds plain-text URLs in text nodes that carry no link mark", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "see https://example.com/docs and https://example.org/x" }],
        },
      ],
    }

    expect(collectLinkUrls(doc)).toEqual(["https://example.com/docs", "https://example.org/x"])
  })

  it("preserves a link mark href verbatim, even when it ends in significant punctuation", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [linkText("wiki", "https://example.com/Yahoo!")] }],
    }

    expect(collectLinkUrls(doc)).toEqual(["https://example.com/Yahoo!"])
  })

  it("trims trailing sentence punctuation from a plain-text URL only", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "see https://example.com/docs." }] }],
    }

    expect(collectLinkUrls(doc)).toEqual(["https://example.com/docs"])
  })

  it("does not scan a linked text node's display text for stray URLs", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [linkText("click https://evil.example here", "https://good.example")],
        },
      ],
    }

    expect(collectLinkUrls(doc)).toEqual(["https://good.example"])
  })

  it("keeps document-order duplicates for callers to ref-count", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [linkText("home", "https://example.com")] },
        { type: "paragraph", content: [{ type: "text", text: "again https://example.com" }] },
      ],
    }

    expect(collectLinkUrls(doc)).toEqual(["https://example.com", "https://example.com"])
  })

  it("excludes custom-protocol links (giphy/memo/attachment/quote)", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [linkText("a gif", "giphy:https://media.giphy.com/abc/giphy.gif?w=1&h=2")],
        },
      ],
    }

    expect(collectLinkUrls(doc)).toEqual([])
  })
})

const giphyEmbed = (giphyUrl: string, attrs: Record<string, unknown> = {}): JSONContent => ({
  type: "giphyEmbed",
  attrs: { giphyUrl, ...attrs },
})

describe("collectGiphyEmbeds", () => {
  it("reads giphy attrs straight from the node, in document order", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [giphyEmbed("https://media.giphy.com/a.gif", { title: "first", width: 2, height: 1 })],
        },
        { type: "paragraph", content: [giphyEmbed("https://media.giphy.com/b.gif")] },
      ],
    }

    expect(collectGiphyEmbeds(doc)).toEqual([
      { giphyUrl: "https://media.giphy.com/a.gif", title: "first", width: 2, height: 1 },
      { giphyUrl: "https://media.giphy.com/b.gif", title: "", width: undefined, height: undefined },
    ])
  })

  it("dedupes by giphyUrl, first title wins", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [giphyEmbed("https://media.giphy.com/a.gif", { title: "keep" })] },
        { type: "paragraph", content: [giphyEmbed("https://media.giphy.com/a.gif", { title: "drop" })] },
      ],
    }

    expect(collectGiphyEmbeds(doc)).toEqual([
      { giphyUrl: "https://media.giphy.com/a.gif", title: "keep", width: undefined, height: undefined },
    ])
  })

  it("ignores embeds with a missing or empty giphyUrl", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "giphyEmbed", attrs: { title: "no url" } }] },
        { type: "paragraph", content: [giphyEmbed("", { title: "empty" })] },
        { type: "paragraph", content: [giphyEmbed("https://media.giphy.com/real.gif")] },
      ],
    }

    expect(collectGiphyEmbeds(doc)).toEqual([
      { giphyUrl: "https://media.giphy.com/real.gif", title: "", width: undefined, height: undefined },
    ])
  })
})
