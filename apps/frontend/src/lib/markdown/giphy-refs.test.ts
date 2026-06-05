import { describe, expect, it } from "vitest"
import { serializeToMarkdown } from "@threa/prosemirror"
import { extractGiphyRefs } from "./giphy-refs"

const GIF_URL = "https://media3.giphy.com/media/abc123/200w.gif?cid=xyz&rid=200w.gif"
const GIF_URL_2 = "https://media1.giphy.com/media/def456/200w.gif"

// Build markdown through the real serializer so the test tracks the actual
// `giphy:` wire format rather than a hand-written guess.
function giphyMarkdown(giphyUrl: string, title: string): string {
  return serializeToMarkdown({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "giphyEmbed", attrs: { giphyUrl, title } }] }],
  })
}

describe("extractGiphyRefs", () => {
  it("returns no refs for a body without giphy links", () => {
    expect(extractGiphyRefs("just text with a [link](https://example.com)")).toEqual([])
  })

  it("extracts a giphy ref with its title", () => {
    expect(extractGiphyRefs(giphyMarkdown(GIF_URL, "happy cat"))).toEqual([{ giphyUrl: GIF_URL, title: "happy cat" }])
  })

  it("de-duplicates repeated references by url, keeping the first title", () => {
    const md = `${giphyMarkdown(GIF_URL, "happy cat")}\n\n${giphyMarkdown(GIF_URL, "same gif")}`
    expect(extractGiphyRefs(md)).toEqual([{ giphyUrl: GIF_URL, title: "happy cat" }])
  })

  it("preserves order and keeps distinct gifs separate", () => {
    const md = `${giphyMarkdown(GIF_URL, "first")}\n\n${giphyMarkdown(GIF_URL_2, "second")}`
    expect(extractGiphyRefs(md)).toEqual([
      { giphyUrl: GIF_URL, title: "first" },
      { giphyUrl: GIF_URL_2, title: "second" },
    ])
  })

  it("skips non-Giphy hosts", () => {
    expect(extractGiphyRefs("[evil](giphy:https%3A%2F%2Fevil.example.com%2Fx.gif)")).toEqual([])
  })
})
