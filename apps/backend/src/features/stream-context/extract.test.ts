import { describe, expect, it } from "bun:test"
import type { JSONContent } from "@threahq/types"
import { contextRowsForMessage } from "./extract"

const OCCURRED_AT = new Date("2026-07-20T10:00:00.000Z")

function paragraph(...content: JSONContent[]): JSONContent {
  return { type: "paragraph", content }
}

function linkText(href: string, text = "link"): JSONContent {
  return { type: "text", text, marks: [{ type: "link", attrs: { href } }] }
}

function giphy(giphyUrl: string, attrs: Record<string, unknown> = {}): JSONContent {
  return { type: "giphyEmbed", attrs: { giphyUrl, ...attrs } }
}

function run(overrides: Partial<Parameters<typeof contextRowsForMessage>[0]> = {}) {
  return contextRowsForMessage({
    workspaceId: "ws_1",
    streamId: "stream_1",
    rootStreamId: "stream_root",
    messageId: "msg_1",
    authorId: "usr_1",
    occurredAt: OCCURRED_AT,
    sequence: 7n,
    contentJson: { type: "doc", content: [] },
    contentMarkdown: "",
    attachments: [],
    ...overrides,
  })
}

describe("contextRowsForMessage", () => {
  it("takes links from contentJson, not from the markdown", () => {
    const rows = run({
      contentMarkdown: "https://markdown-only.example.com/ignored",
      contentJson: { type: "doc", content: [paragraph(linkText("https://example.com/a?utm_source=x"))] },
    })

    expect(rows.map(({ id, ...rest }) => rest)).toEqual([
      {
        workspaceId: "ws_1",
        streamId: "stream_1",
        rootStreamId: "stream_root",
        category: "link",
        refKind: "url",
        refId: "https://example.com/a?utm_source=x",
        groupKey: "https://example.com/a",
        sourceMessageId: "msg_1",
        authorId: "usr_1",
        occurredAt: OCCURRED_AT,
        sequence: 7n,
        snippet: "https://markdown-only.example.com/ignored",
        detail: { url: "https://example.com/a?utm_source=x" },
      },
    ])
  })

  it("skips hrefs longer than the 2000-char index bound", () => {
    const longHref = `https://example.com/${"a".repeat(2000)}`
    const rows = run({
      contentJson: {
        type: "doc",
        content: [paragraph(linkText(longHref), linkText("https://short.example.com/"))],
      },
    })

    expect(rows.map((row) => row.refId)).toEqual(["https://short.example.com/"])
  })

  it("projects inline giphy embeds as media with their attrs in detail", () => {
    const rows = run({
      contentJson: {
        type: "doc",
        content: [paragraph(giphy("https://media.giphy.com/a.gif", { title: "wave", width: 200, height: 100 }))],
      },
    })

    expect(
      rows.map((row) => ({ category: row.category, refKind: row.refKind, refId: row.refId, detail: row.detail }))
    ).toEqual([
      {
        category: "media",
        refKind: "giphy",
        refId: "https://media.giphy.com/a.gif",
        detail: { giphyUrl: "https://media.giphy.com/a.gif", title: "wave", width: 200, height: 100 },
      },
    ])
  })

  it("splits attachments into media and file, flagging gif and video media kinds", () => {
    const rows = run({
      attachments: [
        { id: "attach_png", mimeType: "image/png" },
        { id: "attach_gif", mimeType: "image/gif" },
        { id: "attach_mp4", mimeType: "video/mp4" },
        { id: "attach_pdf", mimeType: "application/pdf" },
      ],
    })

    expect(rows.map((row) => ({ refId: row.refId, category: row.category, detail: row.detail }))).toEqual([
      { refId: "attach_png", category: "media", detail: { mediaKind: "image" } },
      { refId: "attach_gif", category: "media", detail: { mediaKind: "gif" } },
      { refId: "attach_mp4", category: "media", detail: { mediaKind: "video" } },
      { refId: "attach_pdf", category: "file", detail: {} },
    ])
  })

  it("uses the markdown-stripped first non-empty line, capped at 120 chars", () => {
    const rows = run({
      contentMarkdown: `\n**${"x".repeat(200)}**\nsecond line`,
      attachments: [{ id: "attach_1", mimeType: "application/pdf" }],
    })

    expect(rows[0].snippet).toBe(`${"x".repeat(120)}…`)
  })

  it("dedupes within the message by (category, refId)", () => {
    const rows = run({
      contentJson: {
        type: "doc",
        content: [paragraph(linkText("https://example.com/a"), linkText("https://example.com/a", "again"))],
      },
      attachments: [
        { id: "attach_1", mimeType: "image/png" },
        { id: "attach_1", mimeType: "image/png" },
      ],
    })

    expect(rows.map((row) => `${row.category}:${row.refId}`)).toEqual(["link:https://example.com/a", "media:attach_1"])
  })

  describe("pull request references", () => {
    function text(value: string): JSONContent {
      return { type: "text", text: value }
    }

    function refs(content: JSONContent[]) {
      return run({ contentJson: { type: "doc", content } }).map((row) => ({
        category: row.category,
        refId: row.refId,
        groupKey: row.groupKey,
      }))
    }

    it("projects a PR link as a pull_request row keyed by the canonical PR URL, with the ref in detail", () => {
      const rows = run({
        contentJson: { type: "doc", content: [paragraph(linkText("https://github.com/threahq/threa/pull/1826"))] },
      })

      expect(
        rows.map(({ category, refKind, refId, groupKey, detail }) => ({ category, refKind, refId, groupKey, detail }))
      ).toEqual([
        {
          category: "pull_request",
          refKind: "url",
          refId: "https://github.com/threahq/threa/pull/1826",
          groupKey: "https://github.com/threahq/threa/pull/1826",
          detail: { url: "https://github.com/threahq/threa/pull/1826", owner: "threahq", repo: "threa", number: 1826 },
        },
      ])
    })

    it("finds PR URLs in bare text, inline code, code blocks and quotes", () => {
      expect(
        refs([
          paragraph(text("see https://github.com/a/one/pull/1 for context")),
          paragraph({ type: "text", text: "https://github.com/a/two/pull/2", marks: [{ type: "code" }] }),
          { type: "codeBlock", content: [text("gh pr view https://github.com/a/three/pull/3")] },
          { type: "blockquote", content: [paragraph(text("> https://github.com/a/four/pull/4"))] },
        ])
      ).toEqual([
        {
          category: "pull_request",
          refId: "https://github.com/a/one/pull/1",
          groupKey: "https://github.com/a/one/pull/1",
        },
        {
          category: "pull_request",
          refId: "https://github.com/a/two/pull/2",
          groupKey: "https://github.com/a/two/pull/2",
        },
        {
          category: "pull_request",
          refId: "https://github.com/a/three/pull/3",
          groupKey: "https://github.com/a/three/pull/3",
        },
        {
          category: "pull_request",
          refId: "https://github.com/a/four/pull/4",
          groupKey: "https://github.com/a/four/pull/4",
        },
      ])
    })

    it("folds every view into a PR — files, commits, comments, www, trailing slash — into one row, never a link row", () => {
      expect(
        refs([
          paragraph(
            linkText("https://github.com/a/r/pull/7/files"),
            linkText("https://github.com/a/r/pull/7/commits/abc123"),
            linkText("https://github.com/a/r/pull/7#issuecomment-99"),
            linkText("https://www.github.com/a/r/pull/7/"),
            linkText("http://github.com/a/r/pull/7?w=1")
          ),
        ])
      ).toEqual([
        { category: "pull_request", refId: "https://github.com/a/r/pull/7", groupKey: "https://github.com/a/r/pull/7" },
      ])
    })

    it("does not treat shorthand refs, issues, repos or other hosts as pull requests", () => {
      expect(
        refs([
          paragraph(text("fixed in #1826 and threahq/threa#1827")),
          paragraph(
            linkText("https://github.com/a/r/issues/5"),
            linkText("https://github.com/a/r/pulls"),
            linkText("https://gitlab.com/a/r/pull/5"),
            linkText("https://github.com/a/r/pull/new/branch")
          ),
        ])
      ).toEqual([
        { category: "link", refId: "https://github.com/a/r/issues/5", groupKey: "https://github.com/a/r/issues/5" },
        { category: "link", refId: "https://github.com/a/r/pulls", groupKey: "https://github.com/a/r/pulls" },
        { category: "link", refId: "https://gitlab.com/a/r/pull/5", groupKey: "https://gitlab.com/a/r/pull/5" },
        {
          category: "link",
          refId: "https://github.com/a/r/pull/new/branch",
          groupKey: "https://github.com/a/r/pull/new/branch",
        },
      ])
    })
  })
})
