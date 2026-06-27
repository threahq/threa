import { describe, it, expect } from "vitest"
import type { JSONContent } from "@threa/types"
import { classifyDraftLink, extractDraftLinkUrls } from "./in-app-links"

const ORIGIN = "https://app.threa.io"

function linkText(text: string, href: string): JSONContent {
  return { type: "text", text, marks: [{ type: "link", attrs: { href } }] }
}

function doc(...inline: JSONContent[]): JSONContent {
  return { type: "doc", content: [{ type: "paragraph", content: inline }] }
}

describe("classifyDraftLink", () => {
  it("classifies stream, message, and memo links at this origin", () => {
    expect(classifyDraftLink(`${ORIGIN}/w/ws_1/s/stream_1`, ORIGIN)).toEqual({
      kind: "stream",
      url: `${ORIGIN}/w/ws_1/s/stream_1`,
      workspaceId: "ws_1",
      streamId: "stream_1",
    })
    expect(classifyDraftLink(`${ORIGIN}/w/ws_1/s/stream_1?m=msg_1`, ORIGIN)).toEqual({
      kind: "message",
      url: `${ORIGIN}/w/ws_1/s/stream_1?m=msg_1`,
      workspaceId: "ws_1",
      streamId: "stream_1",
      messageId: "msg_1",
    })
    expect(classifyDraftLink(`${ORIGIN}/w/ws_1/memos/memo_1`, ORIGIN)).toEqual({
      kind: "memo",
      url: `${ORIGIN}/w/ws_1/memos/memo_1`,
      workspaceId: "ws_1",
      memoId: "memo_1",
    })
  })

  it("treats external and same-origin non-resource URLs as web links", () => {
    expect(classifyDraftLink("https://example.com/post", ORIGIN)).toEqual({
      kind: "web",
      url: "https://example.com/post",
      host: "example.com",
    })
    // Same origin but not an in-app resource → web chip on our own host.
    expect(classifyDraftLink(`${ORIGIN}/w/ws_1/settings`, ORIGIN)).toMatchObject({ kind: "web", host: "app.threa.io" })
  })

  it("strips a www. prefix from the web host", () => {
    expect(classifyDraftLink("https://www.example.com/x", ORIGIN)).toMatchObject({ kind: "web", host: "example.com" })
  })

  it("rejects non-http(s) URLs", () => {
    expect(classifyDraftLink("mailto:a@b.com", ORIGIN)).toBeNull()
    expect(classifyDraftLink("not a url", ORIGIN)).toBeNull()
  })
})

describe("extractDraftLinkUrls", () => {
  it("collects every link (in-app and web) in document order, deduped", () => {
    const content = doc(
      linkText("channel", `${ORIGIN}/w/ws_1/s/stream_1`),
      { type: "text", text: " and " },
      linkText("blog", "https://example.com/post"),
      { type: "text", text: " and again " },
      linkText("dupe", `${ORIGIN}/w/ws_1/s/stream_1`)
    )
    expect(extractDraftLinkUrls(content)).toEqual([`${ORIGIN}/w/ws_1/s/stream_1`, "https://example.com/post"])
  })

  it("caps at five links", () => {
    const content = doc(...Array.from({ length: 8 }, (_, i) => linkText(`s${i}`, `https://e${i}.com/x`)))
    expect(extractDraftLinkUrls(content)).toHaveLength(5)
  })

  it("returns nothing for empty content", () => {
    expect(extractDraftLinkUrls(null)).toEqual([])
    expect(extractDraftLinkUrls(undefined)).toEqual([])
  })
})
