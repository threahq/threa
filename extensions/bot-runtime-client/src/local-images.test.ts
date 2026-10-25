import { describe, expect, test } from "bun:test"
import { findLocalImageLinks, imageAttachmentLink, redactLocalImageLinks, uploadLocalImageLinks } from "./local-images"

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

  test("only image files count, so an echoed key or env file never uploads", () => {
    expect(paths("![k](/home/u/.ssh/id_rsa) ![e](../.env) ![p](/tmp/report.pdf) ![i](/tmp/SHOT.JPEG)")).toEqual([
      "/tmp/SHOT.JPEG",
    ])
  })

  test("reads one level of parentheses in a path", () => {
    expect(paths("![copy](/tmp/a(1).png)")).toEqual(["/tmp/a(1).png"])
  })

  test("skips an image that is a link's text", () => {
    expect(paths("[![badge](/tmp/badge.png)](https://example.com) ![solo](/tmp/solo.png)")).toEqual(["/tmp/solo.png"])
  })

  test("keeps offsets into the original text", () => {
    const markdown = "Before `code` ![shot](/tmp/shot.png) after"
    const [link] = findLocalImageLinks(markdown)
    expect(link).toEqual({ start: 14, end: 36, alt: "shot", path: "/tmp/shot.png" })
    expect(markdown.slice(link!.start, link!.end)).toBe("![shot](/tmp/shot.png)")
  })
})

describe("imageAttachmentLink", () => {
  test("labels by alt text, falling back to the escaped filename, with the chip metadata title", () => {
    expect(
      imageAttachmentLink("Direction\n1", { id: "attach_1", filename: "a.png", mimeType: "image/png", sizeBytes: 12 })
    ).toBe('[Direction 1](attachment:attach_1 "threa-attachment:filename=a.png&mimeType=image%2Fpng&sizeBytes=12")')
    expect(
      imageAttachmentLink(" ", { id: "attach_2", filename: "[draft].png", mimeType: "image/png", sizeBytes: 3 })
    ).toBe(
      '[\\[draft\\].png](attachment:attach_2 "threa-attachment:filename=%5Bdraft%5D.png&mimeType=image%2Fpng&sizeBytes=3")'
    )
  })
})

describe("redactLocalImageLinks", () => {
  test("hides local image paths and leaves web images and code alone", () => {
    expect(
      redactLocalImageLinks("See ![shot](/home/u/shot.png), ![web](https://x.test/w.png) and `![c](/tmp/c.png)`")
    ).toBe("See [image: local path omitted], ![web](https://x.test/w.png) and `![c](/tmp/c.png)`")
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
      (uploaded, link) => `[${link.alt}](attachment:${uploaded.id})`
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
