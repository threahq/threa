import { describe, it, expect } from "vitest"
import type { JSONContent } from "@threa/types"
import { extractInAppLinkUrls } from "./in-app-links"

const ORIGIN = "https://app.threa.io"

function linkText(text: string, href: string): JSONContent {
  return { type: "text", text, marks: [{ type: "link", attrs: { href } }] }
}

function doc(...inline: JSONContent[]): JSONContent {
  return { type: "doc", content: [{ type: "paragraph", content: inline }] }
}

describe("extractInAppLinkUrls", () => {
  it("collects stream, message, and memo links at this origin", () => {
    const content = doc(
      linkText("channel", `${ORIGIN}/w/ws_1/s/stream_1`),
      { type: "text", text: " and " },
      linkText("a message", `${ORIGIN}/w/ws_1/s/stream_1?m=msg_1`),
      { type: "text", text: " and " },
      linkText("a memo", `${ORIGIN}/w/ws_1/memos/memo_1`)
    )

    expect(extractInAppLinkUrls(content, ORIGIN)).toEqual([
      `${ORIGIN}/w/ws_1/s/stream_1`,
      `${ORIGIN}/w/ws_1/s/stream_1?m=msg_1`,
      `${ORIGIN}/w/ws_1/memos/memo_1`,
    ])
  })

  it("ignores external links and non-in-app app paths", () => {
    const content = doc(
      linkText("blog", "https://example.com/post"),
      linkText("settings", `${ORIGIN}/w/ws_1/settings`),
      linkText("root", `${ORIGIN}/`)
    )
    expect(extractInAppLinkUrls(content, ORIGIN)).toEqual([])
  })

  it("ignores in-app links from a different origin", () => {
    const content = doc(linkText("staging", "https://staging.threa.io/w/ws_1/s/stream_1"))
    expect(extractInAppLinkUrls(content, ORIGIN)).toEqual([])
  })

  it("dedupes repeated links preserving first-seen order", () => {
    const content = doc(
      linkText("one", `${ORIGIN}/w/ws_1/s/stream_1`),
      linkText("again", `${ORIGIN}/w/ws_1/s/stream_1`)
    )
    expect(extractInAppLinkUrls(content, ORIGIN)).toEqual([`${ORIGIN}/w/ws_1/s/stream_1`])
  })

  it("caps at five previews", () => {
    const content = doc(...Array.from({ length: 8 }, (_, i) => linkText(`s${i}`, `${ORIGIN}/w/ws_1/s/stream_${i}`)))
    expect(extractInAppLinkUrls(content, ORIGIN)).toHaveLength(5)
  })

  it("returns nothing for empty content", () => {
    expect(extractInAppLinkUrls(null, ORIGIN)).toEqual([])
    expect(extractInAppLinkUrls(undefined, ORIGIN)).toEqual([])
  })
})
