import { describe, expect, test } from "bun:test"
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

  test("skips indented code and fences inside blockquotes and list items", () => {
    const markdown = [
      "Para",
      "",
      "    ![indented](/tmp/indented.png)",
      "",
      "    ![still](/tmp/still.png)",
      "> ```",
      "> ![quoted](/tmp/quoted.png)",
      "> ```",
      "- item",
      "  ```",
      "  ![listed](/tmp/listed.png)",
      "  ```",
      "> ![quote](/tmp/quote.png)",
      "Text",
      "    ![continuation](/tmp/continuation.png)",
    ].join("\n")
    expect(paths(markdown)).toEqual(["/tmp/quote.png", "/tmp/continuation.png"])
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
    expect(
      paths(
        "[![badge](/tmp/badge.png)](https://example.com) [see ![x](/tmp/x.png) here](https://e.com) `[` ![solo](/tmp/solo.png)"
      )
    ).toEqual(["/tmp/solo.png"])
  })

  test("only the bracket that closes into a link makes link text", () => {
    expect([
      paths("Range [0, 10) ![plot](/tmp/plot.png) see [docs](https://d.test)"),
      paths("[ ![a](/tmp/a.png) | ![b](/tmp/b.png) ]"),
      paths("[see ![x](/tmp/x.png)][ref] and [y]: ![z](/tmp/z.png)"),
    ]).toEqual([["/tmp/plot.png"], ["/tmp/a.png", "/tmp/b.png"], ["/tmp/z.png"]])
  })

  test("brackets in an image's path or title, an escaped `!`, or an outer image don't hide the enclosing link", () => {
    expect([
      paths('[ ![a](/tmp/a.png "t]") ](https://x.test)'),
      paths('[ ![a](/tmp/a.png "t[") ](https://x.test)'),
      paths("[see ![a](/tmp/x].png) more](https://x.test)"),
      paths("\\![see ![a](/tmp/a.png)](https://x.test)"),
      paths("![outer ![in](/tmp/in.png)](https://x.test)"),
    ]).toEqual([[], [], [], [], []])
  })

  test("scans many images and links on one line in linear time", () => {
    const line = "[l](https://e.test) ![i](/tmp/i.png) ".repeat(5_000)
    const started = performance.now()
    expect(paths(line)).toHaveLength(5_000)
    expect(performance.now() - started).toBeLessThan(500)
  })

  test("a stray `![` never swallows the prose before a later image", () => {
    const markdown = "Press ![ to open\n\nmore text ![ and [this] too\n\n![shot](/tmp/s.png)"
    expect(findLocalImageLinks(markdown)).toEqual([
      { start: markdown.indexOf("![shot"), end: markdown.length, alt: "shot", path: "/tmp/s.png" },
    ])
  })

  test("scans many unclosed `![` in linear time", () => {
    const started = performance.now()
    expect(paths("![ x ".repeat(20_000))).toEqual([])
    expect(performance.now() - started).toBeLessThan(500)
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
    const image = { mimeType: "image/png", sizeBytes: 12 }
    expect([
      imageAttachmentLink({ ...image, id: "attach_1", filename: "a.png" }, { alt: "Direction\n1" }),
      imageAttachmentLink({ ...image, id: "attach_2", filename: "[draft].png" }, { alt: " " }),
      imageAttachmentLink({ ...image, id: "attach_3", filename: "c.png" }, { alt: "a [b \\] c" }),
    ]).toEqual([
      '[Direction 1](attachment:attach_1 "threa-attachment:filename=a.png&mimeType=image%2Fpng&sizeBytes=12")',
      '[\\[draft\\].png](attachment:attach_2 "threa-attachment:filename=%5Bdraft%5D.png&mimeType=image%2Fpng&sizeBytes=12")',
      '[a \\[b \\] c](attachment:attach_3 "threa-attachment:filename=c.png&mimeType=image%2Fpng&sizeBytes=12")',
    ])
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
    const dir = mkdtempSync(join(tmpdir(), "local-images-"))
    writeFileSync(join(dir, "a.png"), "png")
    writeFileSync(join(dir, "id_rsa"), "key")
    symlinkSync(join(dir, "id_rsa"), join(dir, "logo.png"))
    const calls: string[] = []
    const result = await uploadLocalImageLinks(
      [
        "A ![one](a.png)",
        `B ![again](${dir}/a.png)`,
        "C ![gone](missing.png)",
        "D ![key](logo.png)",
        "E ![web](https://x.test/e.png)",
      ].join("\n"),
      dir,
      async (path) => {
        calls.push(path)
        return { id: `attach_${calls.length}` }
      },
      (uploaded, link) => `[${link.alt}](attachment:${uploaded.id})`
    )
    expect({ calls, result: result }).toEqual({
      calls: ["a.png", `${dir}/a.png`],
      result: {
        markdown:
          "A [one](attachment:attach_1)\nB [again](attachment:attach_2)\nC \nD \nE ![web](https://x.test/e.png)",
        uploaded: [{ id: "attach_1" }, { id: "attach_2" }],
        failed: [expect.stringMatching(/^missing\.png: ENOENT\b/), "logo.png: it links to a file that is not an image"],
      },
    })
  })

  test("returns the markdown untouched when nothing is local", async () => {
    const markdown = "No images, just `![code](/tmp/x.png)`."
    const result = await uploadLocalImageLinks(
      markdown,
      "/",
      async () => {
        throw new Error("unexpected upload")
      },
      () => ""
    )
    expect(result).toEqual({ markdown, uploaded: [], failed: [] })
  })
})
