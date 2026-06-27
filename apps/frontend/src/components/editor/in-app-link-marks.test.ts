import { describe, it, expect } from "vitest"
import type { JSONContent } from "@threa/types"
import { inAppLinkMarksToNodes } from "./in-app-link-marks"

const ORIGIN = "https://app.threa.io"

function link(text: string, href: string, extraMarks: { type: string }[] = []): JSONContent {
  return { type: "text", text, marks: [{ type: "link", attrs: { href } }, ...extraMarks] }
}

function doc(...inline: JSONContent[]): JSONContent {
  return { type: "doc", content: [{ type: "paragraph", content: inline }] }
}

describe("inAppLinkMarksToNodes", () => {
  it("converts an in-app stream link mark into an inAppLink node", () => {
    const url = `${ORIGIN}/w/ws_1/s/stream_1`
    const result = inAppLinkMarksToNodes(doc({ type: "text", text: "see " }, link("#design", url)), ORIGIN)
    expect(result.content?.[0].content).toEqual([
      { type: "text", text: "see " },
      { type: "inAppLink", attrs: { url, streamId: "stream_1", messageId: null, name: "#design" } },
    ])
  })

  it("converts an in-app message link mark, carrying the message id", () => {
    const url = `${ORIGIN}/w/ws_1/s/stream_1?m=msg_9`
    const result = inAppLinkMarksToNodes(doc(link("Ada", url)), ORIGIN)
    expect(result.content?.[0].content).toEqual([
      { type: "inAppLink", attrs: { url, streamId: "stream_1", messageId: "msg_9", name: "Ada" } },
    ])
  })

  it("merges adjacent nodes sharing one in-app href (e.g. a #slug-shaped name) into one chip", () => {
    const url = `${ORIGIN}/w/ws_1/s/stream_1`
    const channelInsideLink: JSONContent = {
      type: "channelLink",
      attrs: { id: "design", slug: "design" },
      marks: [{ type: "link", attrs: { href: url } }],
    }
    const result = inAppLinkMarksToNodes(doc(channelInsideLink), ORIGIN)
    expect(result.content?.[0].content).toEqual([
      { type: "inAppLink", attrs: { url, streamId: "stream_1", messageId: null, name: "#design" } },
    ])
  })

  it("leaves web links and same-origin non-resource links untouched", () => {
    const web = link("blog", "https://example.com/post")
    const settings = link("settings", `${ORIGIN}/w/ws_1/settings`)
    const input = doc(web, { type: "text", text: " " }, settings)
    expect(inAppLinkMarksToNodes(input, ORIGIN)).toEqual(input)
  })

  it("leaves a styled (bold) in-app link untouched so the formatting round-trips", () => {
    const url = `${ORIGIN}/w/ws_1/s/stream_1`
    const input = doc(link("#design", url, [{ type: "bold" }]))
    // Converting would strip the bold (atoms don't carry their own marks through
    // serialization), so a bold link stays a bold link rather than becoming a chip.
    expect(inAppLinkMarksToNodes(input, ORIGIN)).toEqual(input)
  })

  it("is idempotent — an existing inAppLink atom passes through unchanged", () => {
    const url = `${ORIGIN}/w/ws_1/s/stream_1`
    const already = doc({ type: "inAppLink", attrs: { url, streamId: "stream_1", messageId: null, name: "#design" } })
    expect(inAppLinkMarksToNodes(already, ORIGIN)).toEqual(already)
  })
})
