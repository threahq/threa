import { describe, expect, it } from "bun:test"
import type { JSONContent } from "@threa/types"
import {
  collectAttachmentReferenceIds,
  collectChannelStreamIds,
  collectGiphyEmbeds,
  collectLinkUrls,
  collectMentionActorRefs,
  collectQuoteReplyMessageIds,
  collectUnresolvedChannelLinkSlugs,
  collectUnresolvedMentionSlugs,
  mapMentionAndChannelNodes,
} from "./extractors"

const quoteReply = (messageId: string): JSONContent => ({
  type: "quoteReply",
  attrs: { messageId, snippet: "quoted text", authorId: "usr_x", streamId: "stream_x", actorType: "user" },
})

const mention = (id: string, slug: string, mentionType: string): JSONContent => ({
  type: "mention",
  attrs: { id, slug, mentionType },
})

const channelLink = (id: string, slug: string): JSONContent => ({
  type: "channelLink",
  attrs: { id, slug },
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

describe("collectMentionActorRefs", () => {
  it("derives actorType from the id prefix across user/persona/bot/broadcast", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "hey " },
            mention("usr_alice", "alice", "user"),
            { type: "text", text: " and " },
            mention("persona_system_ariadne", "ariadne", "persona"),
          ],
        },
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [mention("bot_scout", "scout", "bot"), mention("broadcast:here", "here", "broadcast")],
            },
          ],
        },
      ],
    }

    expect(collectMentionActorRefs(doc)).toEqual([
      { actorType: "user", actorId: "usr_alice" },
      { actorType: "persona", actorId: "persona_system_ariadne" },
      { actorType: "bot", actorId: "bot_scout" },
      { actorType: "broadcast", actorId: "broadcast:here" },
    ])
  })

  it("treats the channel broadcast sentinel as a broadcast ref", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [mention("broadcast:channel", "channel", "broadcast")] }],
    }

    expect(collectMentionActorRefs(doc)).toEqual([{ actorType: "broadcast", actorId: "broadcast:channel" }])
  })

  it("derives the ref from the id even when mentionType disagrees (id is authoritative)", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "mention", attrs: { id: "bot_helper", slug: "helper", mentionType: "user" } }],
        },
      ],
    }

    expect(collectMentionActorRefs(doc)).toEqual([{ actorType: "bot", actorId: "bot_helper" }])
  })

  it("dedupes by actorId, keeping first-seen order", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [mention("usr_alice", "alice", "user"), mention("bot_scout", "scout", "bot")],
        },
        {
          type: "blockquote",
          content: [{ type: "paragraph", content: [mention("usr_alice", "alice", "user")] }],
        },
      ],
    }

    expect(collectMentionActorRefs(doc)).toEqual([
      { actorType: "user", actorId: "usr_alice" },
      { actorType: "bot", actorId: "bot_scout" },
    ])
  })

  it("skips unresolved (bare-slug) ids and missing-id nodes", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            mention("ariadne", "ariadne", "persona"),
            { type: "mention", attrs: { slug: "noid", mentionType: "user" } },
            mention("usr_real", "real", "user"),
          ],
        },
      ],
    }

    expect(collectMentionActorRefs(doc)).toEqual([{ actorType: "user", actorId: "usr_real" }])
  })

  it("returns empty array for documents without mentions", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "no mentions here" }] }],
    }

    expect(collectMentionActorRefs(doc)).toEqual([])
  })
})

describe("collectChannelStreamIds", () => {
  it("returns stream ids from resolved channelLink nodes across nested blocks", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [channelLink("stream_general", "general"), channelLink("stream_random", "random")],
        },
        {
          type: "blockquote",
          content: [{ type: "paragraph", content: [channelLink("stream_general", "general")] }],
        },
      ],
    }

    expect(collectChannelStreamIds(doc)).toEqual(["stream_general", "stream_random"])
  })

  it("skips unresolved (bare-slug) channel links", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [channelLink("general", "general"), channelLink("stream_real", "real")],
        },
      ],
    }

    expect(collectChannelStreamIds(doc)).toEqual(["stream_real"])
  })

  it("returns empty array for documents without channel links", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "no channels" }] }],
    }

    expect(collectChannelStreamIds(doc)).toEqual([])
  })
})

describe("collectUnresolvedMentionSlugs", () => {
  it("lowercases and dedupes unresolved mention slugs, excluding resolved and broadcast nodes", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            mention("Ariadne", "Ariadne", "persona"),
            mention("scout", "scout", "bot"),
            mention("usr_resolved", "alreadyresolved", "user"),
            mention("here", "here", "broadcast"),
            mention("channel", "channel", "broadcast"),
          ],
        },
        {
          type: "blockquote",
          content: [{ type: "paragraph", content: [mention("ARIADNE", "ARIADNE", "persona")] }],
        },
      ],
    }

    expect(collectUnresolvedMentionSlugs(doc)).toEqual(["ariadne", "scout"])
  })

  it("collects non-Latin slugs the markdown path produced (no ASCII pattern involved)", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [mention("аріадна", "аріадна", "persona"), mention("研究員", "研究員", "user")],
        },
      ],
    }

    expect(collectUnresolvedMentionSlugs(doc)).toEqual(["аріадна", "研究員"])
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
            mention("real", "real", "bot"),
          ],
        },
      ],
    }

    expect(collectUnresolvedMentionSlugs(doc)).toEqual(["real"])
  })

  it("returns empty array when all mentions are already resolved", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [mention("usr_alice", "alice", "user"), mention("broadcast:here", "here", "broadcast")],
        },
      ],
    }

    expect(collectUnresolvedMentionSlugs(doc)).toEqual([])
  })
})

describe("collectUnresolvedChannelLinkSlugs", () => {
  it("lowercases and dedupes unresolved channel link slugs, excluding resolved ones", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            channelLink("General", "General"),
            channelLink("stream_resolved", "alreadyresolved"),
            channelLink("GENERAL", "GENERAL"),
          ],
        },
      ],
    }

    expect(collectUnresolvedChannelLinkSlugs(doc)).toEqual(["general"])
  })

  it("returns empty array when all channel links are resolved", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [channelLink("stream_general", "general")] }],
    }

    expect(collectUnresolvedChannelLinkSlugs(doc)).toEqual([])
  })
})

describe("mapMentionAndChannelNodes", () => {
  it("rewrites mention and channelLink attrs returned by fn, leaving other nodes untouched", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "hey " },
            mention("alice", "alice", "user"),
            { type: "text", text: " in " },
            channelLink("general", "general"),
          ],
        },
      ],
    }

    const result = mapMentionAndChannelNodes(doc, (node) => {
      if (node.type === "mention") return { ...node.attrs, id: "usr_alice", mentionType: "user" }
      if (node.type === "channelLink") return { ...node.attrs, id: "stream_general" }
      return undefined
    })

    expect(result).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "hey " },
            { type: "mention", attrs: { id: "usr_alice", slug: "alice", mentionType: "user" } },
            { type: "text", text: " in " },
            { type: "channelLink", attrs: { id: "stream_general", slug: "general" } },
          ],
        },
      ],
    })
  })

  it("leaves a node unchanged when fn returns undefined", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [mention("usr_alice", "alice", "user"), mention("bob", "bob", "user")],
        },
      ],
    }

    const result = mapMentionAndChannelNodes(doc, (node) =>
      node.attrs?.slug === "bob" ? { ...node.attrs, id: "usr_bob" } : undefined
    )

    expect(result).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: "usr_alice", slug: "alice", mentionType: "user" } },
            { type: "mention", attrs: { id: "usr_bob", slug: "bob", mentionType: "user" } },
          ],
        },
      ],
    })
  })

  it("recurses nested content and preserves the surrounding tree structure", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [channelLink("general", "general")] }],
            },
          ],
        },
      ],
    }

    const result = mapMentionAndChannelNodes(doc, (node) =>
      node.type === "channelLink" ? { ...node.attrs, id: "stream_general" } : undefined
    )

    expect(result).toEqual({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "channelLink", attrs: { id: "stream_general", slug: "general" } }],
                },
              ],
            },
          ],
        },
      ],
    })
  })

  it("returns a document equal to the input when fn never rewrites", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "no targets" }] }],
    }

    expect(mapMentionAndChannelNodes(doc, () => undefined)).toEqual(doc)
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
