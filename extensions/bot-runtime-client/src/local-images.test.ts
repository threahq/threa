import { describe, expect, test } from "bun:test"
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findLocalFileLinks, fileAttachmentLink, redactLocalFileLinks, uploadLocalFileLinks } from "./local-images"

function paths(markdown: string): string[] {
  return findLocalFileLinks(markdown).map((link) => link.path)
}

describe("findLocalFileLinks", () => {
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

  test("skips escaped images", () => {
    expect(paths("\\![escaped](/tmp/a.png)")).toEqual([])
  })

  test("only image files count, so an echoed key or env file never uploads", () => {
    expect(paths("![k](/home/u/.ssh/id_rsa) ![e](../.env) ![p](/tmp/report.pdf) ![i](/tmp/SHOT.JPEG)")).toEqual([
      "/tmp/SHOT.JPEG",
    ])
  })

  test("reads nested parentheses, non-ASCII spaces, line breaks and every title form", () => {
    expect(
      paths(
        [
          "![a](/tmp/a(1).png)",
          "![b](/tmp/b((1)).png)",
          "![c](/tmp/Shot\u202FAM.png)",
          '![d](/tmp/d.png "say \\"hi\\"")',
          "![e](/tmp/e.png 'title')",
          "![f](/tmp/f.png (title))",
          "![g](\r\n/tmp/g.png\r\n)",
        ].join("\n\n")
      )
    ).toEqual([
      "/tmp/a(1).png",
      "/tmp/b((1)).png",
      "/tmp/Shot\u202FAM.png",
      "/tmp/d.png",
      "/tmp/e.png",
      "/tmp/f.png",
      "/tmp/g.png",
    ])
  })

  test("reads an image the scan misses once another image triggers the parse", () => {
    expect(paths("![two\nlines](/tmp/m.png) ![s](/tmp/s.png)")).toEqual(["/tmp/m.png", "/tmp/s.png"])
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
    ]).toEqual([["/tmp/plot.png"], ["/tmp/a.png", "/tmp/b.png"], ["/tmp/x.png", "/tmp/z.png"]])
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

  test("parses many images and links on one line in linear time", () => {
    const line = (n: number) => "[l](https://e.test) ![i](/tmp/i.png) ".repeat(n)
    const fastest = (n: number) => {
      let best = Infinity
      for (let run = 0; run < 3; run++) {
        const started = performance.now()
        expect(paths(line(n))).toHaveLength(n)
        best = Math.min(best, performance.now() - started)
      }
      return best
    }
    fastest(400)
    fastest(1_600)
    // Linear work grows 4x; a quadratic scan would grow 16x.
    expect(fastest(1_600) / fastest(400)).toBeLessThan(8)
  })

  test("a stray `![` never swallows the prose before a later image", () => {
    const markdown = "Press ![ to open\n\nmore text ![ and [this] too\n\n![shot](/tmp/s.png)"
    expect(findLocalFileLinks(markdown)).toEqual([
      { start: markdown.indexOf("![shot"), end: markdown.length, alt: "shot", path: "/tmp/s.png" },
    ])
  })

  test("scans many unclosed `![` in linear time", () => {
    const started = performance.now()
    expect(paths("![ x ".repeat(20_000))).toEqual([])
    expect(performance.now() - started).toBeLessThan(500)
  })

  test("keeps offsets past a leading byte-order mark", () => {
    const markdown = "\uFEFFSee ![shot](/tmp/shot.png)"
    const [link] = findLocalFileLinks(markdown)
    expect(markdown.slice(link!.start, link!.end)).toBe("![shot](/tmp/shot.png)")
  })

  test("keeps backslashes in a Windows path", () => {
    expect(paths("![w](C:\\tmp\\_a.png)")).toEqual(["C:\\tmp\\_a.png"])
  })

  test("keeps offsets into the original text", () => {
    const markdown = "Before `code` ![shot](/tmp/shot.png) after"
    const [link] = findLocalFileLinks(markdown)
    expect(link).toEqual({ start: 14, end: 36, alt: "shot", path: "/tmp/shot.png" })
    expect(markdown.slice(link!.start, link!.end)).toBe("![shot](/tmp/shot.png)")
  })
})

describe("fileAttachmentLink", () => {
  test("labels by alt text, falling back to the escaped filename, with the chip metadata title", () => {
    const image = { mimeType: "image/png", sizeBytes: 12 }
    expect([
      fileAttachmentLink({ ...image, id: "attach_1", filename: "a.png" }, { alt: "Direction\n1" }),
      fileAttachmentLink({ ...image, id: "attach_2", filename: "[draft].png" }, { alt: " " }),
      fileAttachmentLink({ ...image, id: "attach_3", filename: "c.png" }, { alt: "a [b ] c\\d `e`" }),
    ]).toEqual([
      '[Direction 1](attachment:attach_1 "threa-attachment:filename=a.png&mimeType=image%2Fpng&sizeBytes=12")',
      '[\\[draft\\].png](attachment:attach_2 "threa-attachment:filename=%5Bdraft%5D.png&mimeType=image%2Fpng&sizeBytes=12")',
      '[a \\[b \\] c\\\\d \\`e\\`](attachment:attach_3 "threa-attachment:filename=c.png&mimeType=image%2Fpng&sizeBytes=12")',
    ])
  })
})

describe("redactLocalFileLinks", () => {
  test("hides every local image path, in code, HTML blocks and footnotes too, and leaves web images alone", () => {
    expect(
      redactLocalFileLinks(
        [
          "See ![shot](/home/u/shot.png), ![web](https://x.test/w.png) and `![c](/tmp/c.png)`",
          "<details>",
          "![d](/tmp/d.png)",
          "</details>",
          "[^1]: ![f](./f.png)",
        ].join("\n")
      )
    ).toBe(
      [
        "See [image: local path omitted], ![web](https://x.test/w.png) and `[image: local path omitted]`",
        "<details>",
        "[image: local path omitted]",
        "</details>",
        "[^1]: [image: local path omitted]",
      ].join("\n")
    )
  })

  test("scans a large trace in a few milliseconds", () => {
    const trace = "const x = a[i] ![ (b) `c` ".repeat(10_000) + "![shot](/tmp/s.png)"
    const started = performance.now()
    expect(redactLocalFileLinks(trace).endsWith("[image: local path omitted]")).toBe(true)
    expect(performance.now() - started).toBeLessThan(200)
  })

  test("hides escaped and nested-parenthesis paths", () => {
    expect(redactLocalFileLinks("![a](/tmp/a\\).png) ![b](/tmp/b((1)).png)")).toBe(
      "[image: local path omitted] [image: local path omitted]"
    )
  })

  test("scans many unclosed parenthesized titles in linear time", () => {
    const trace = "![a](b (".repeat(20_000)
    const started = performance.now()
    expect(redactLocalFileLinks(trace)).toBe(trace)
    expect(findLocalFileLinks(trace)).toEqual([])
    expect(performance.now() - started).toBeLessThan(200)
  })
})

describe("uploadLocalFileLinks", () => {
  test("uploads each path once, rewrites every embed, and drops failures with a reason", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-images-"))
    writeFileSync(join(dir, "a.png"), "png")
    writeFileSync(join(dir, "id_rsa"), "key")
    symlinkSync(join(dir, "id_rsa"), join(dir, "logo.png"))
    const calls: string[] = []
    const result = await uploadLocalFileLinks(
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
        failed: [
          expect.stringMatching(/^missing\.png: ENOENT\b/),
          "logo.png: it links to a file that is not an allowed deliverable",
        ],
      },
    })
  })

  test("returns the markdown untouched when nothing is local", async () => {
    const markdown = "No images, just `![code](/tmp/x.png)`."
    const result = await uploadLocalFileLinks(
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

test("should recognize only explicit allowlisted deliverable links", () => {
  const allowed = [
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "svg",
    "md",
    "pdf",
    "html",
    "csv",
    "txt",
    "mp4",
    "webm",
    "mov",
    "mp3",
    "wav",
    "ogg",
  ]
  expect(paths(allowed.map((ext) => `[file](/tmp/out.${ext})`).join(" "))).toEqual(
    allowed.map((ext) => `/tmp/out.${ext}`)
  )
  expect(
    paths(
      "[env](/tmp/.env) [key](/tmp/key.pem) [archive](/tmp/out.zip) [config](/tmp/out.json) [source](/tmp/out.ts) [relative](out.md) /tmp/bare.pdf"
    )
  ).toEqual([])
})

test("should reject a deliverable symlink to a secret before uploading", async () => {
  const dir = mkdtempSync(join(tmpdir(), "local-files-"))
  writeFileSync(join(dir, ".env"), "synthetic secret")
  symlinkSync(join(dir, ".env"), join(dir, "report.md"))
  const result = await uploadLocalFileLinks(
    `[report](${dir}/report.md)`,
    dir,
    async () => {
      throw new Error("must not upload")
    },
    () => "uploaded"
  )
  expect(result).toEqual({
    markdown: "",
    uploaded: [],
    failed: [`${dir}/report.md: it links to a file that is not an allowed deliverable`],
  })
})
