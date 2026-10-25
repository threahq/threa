import { describe, expect, test } from "bun:test"
import { findLocalImageLinks, imageAttachmentLink, uploadLocalImageLinks } from "./local-images"

function paths(markdown: string): string[] {
  return findLocalImageLinks(markdown).map((link) => link.path)
}

describe("findLocalImageLinks", () => {
  test("finds absolute, relative, angle-bracketed, titled and file: targets", () => {
    const markdown = [
      "![one](/tmp/one.png)",
      "![two](out/two.png)",
      "![three](</tmp/my shot.png>)",
      '![four](./four.png "Four")',
      "![five](file:///tmp/five%20x.png)",
    ].join("\n")
    expect(paths(markdown)).toEqual([
      "/tmp/one.png",
      "out/two.png",
      "/tmp/my shot.png",
      "./four.png",
      "/tmp/five x.png",
    ])
  })

  test("leaves web, data and attachment targets alone", () => {
    const markdown = [
      "![a](https://example.com/a.png)",
      "![b](http://example.com/b.png)",
      "![c](data:image/png;base64,AAAA)",
      "![d](attachment:attach_1)",
      "![e](//cdn.example.com/e.png)",
      "![f](#anchor)",
    ].join("\n")
    expect(paths(markdown)).toEqual([])
  })

  test("skips images inside fenced blocks and inline code", () => {
    const markdown = [
      "```md",
      "![fenced](/tmp/fenced.png)",
      "```",
      "~~~~",
      "![tilde](/tmp/tilde.png)",
      "```",
      "~~~~",
      "Use `![inline](/tmp/inline.png)` or ``![double](/tmp/double.png)``.",
      "But ![real](/tmp/real.png) is real.",
    ].join("\n")
    expect(paths(markdown)).toEqual(["/tmp/real.png"])
  })

  test("skips escaped images and plain links", () => {
    expect(paths("\\![escaped](/tmp/a.png) and [link](/tmp/b.png)")).toEqual([])
  })

  test("keeps offsets into the original text", () => {
    const markdown = "Before `code` ![shot](/tmp/shot.png) after"
    const [link] = findLocalImageLinks(markdown)
    expect(link).toEqual({ start: 14, end: 36, alt: "shot", path: "/tmp/shot.png" })
    expect(markdown.slice(link!.start, link!.end)).toBe("![shot](/tmp/shot.png)")
  })
})

describe("imageAttachmentLink", () => {
  test("labels by alt text, falling back to the escaped filename", () => {
    expect(imageAttachmentLink("Direction 1", { id: "attach_1", filename: "a.png" })).toBe(
      "[Direction 1](attachment:attach_1)"
    )
    expect(imageAttachmentLink(" ", { id: "attach_2", filename: "[draft].png" })).toBe(
      "[\\[draft\\].png](attachment:attach_2)"
    )
  })
})

describe("uploadLocalImageLinks", () => {
  test("uploads each path once, rewrites every embed, and drops failures with a reason", async () => {
    const calls: string[] = []
    const result = await uploadLocalImageLinks(
      "A ![one](/tmp/a.png)\nB ![again](/tmp/a.png)\nC ![gone](/tmp/missing.png)\nD ![web](https://x.test/d.png)",
      async (path) => {
        calls.push(path)
        if (path === "/tmp/missing.png") throw new Error("ENOENT")
        return { id: "attach_a", filename: "a.png" }
      },
      (uploaded, link) => imageAttachmentLink(link.alt, uploaded)
    )
    expect({ calls, result }).toEqual({
      calls: ["/tmp/a.png", "/tmp/missing.png"],
      result: {
        markdown: "A [one](attachment:attach_a)\nB [again](attachment:attach_a)\nC \nD ![web](https://x.test/d.png)",
        uploaded: [{ id: "attach_a", filename: "a.png" }],
        failed: ["/tmp/missing.png: ENOENT"],
      },
    })
  })

  test("returns the markdown untouched when nothing is local", async () => {
    const markdown = "No images, just `![code](/tmp/x.png)`."
    const result = await uploadLocalImageLinks(
      markdown,
      async () => {
        throw new Error("unexpected upload")
      },
      () => ""
    )
    expect(result).toEqual({ markdown, uploaded: [], failed: [] })
  })
})
