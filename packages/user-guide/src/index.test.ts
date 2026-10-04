import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseAppLinkHref } from "@threahq/types"

import { loadGuideArticles, parseGuideArticle } from "./index"

const articles = loadGuideArticles()

const hrefs = (body: string) => [...body.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!)

describe("guide articles", () => {
  test("should parse every shipped article when loading the content directory", () => {
    expect(articles.length).toBeGreaterThan(0)
  })

  test("should link only to app destinations the app understands when a body uses an app: link", () => {
    const rejected = articles.flatMap((a) =>
      hrefs(a.body)
        .filter((href) => href.startsWith("app:") && parseAppLinkHref(href) === null)
        .map((href) => `${a.slug}: ${href}`)
    )
    expect(rejected).toEqual([])
  })

  test("should link only to shipped articles when a body links inside the guide", () => {
    const slugs = new Set(articles.map((a) => a.slug))
    const dangling = articles.flatMap((a) =>
      hrefs(a.body)
        .filter((href) => href.startsWith("/guide/"))
        .filter((href) => !slugs.has(href.slice("/guide/".length).split("#")[0]!))
        .map((href) => `${a.slug}: ${href}`)
    )
    expect(dangling).toEqual([])
  })

  test("should keep angle-bracket placeholders in code when a body uses one", () => {
    // The site renders markdown with raw HTML on, so a bare `<name>` becomes an unknown tag and disappears.
    const prose = (body: string) => body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "")
    const tags = articles.flatMap((a) =>
      [...prose(a.body).matchAll(/<[a-zA-Z][^>\n]*>/g)].map((m) => `${a.slug}: ${m[0]}`)
    )
    expect(tags).toEqual([])
  })
})

const valid = "---\ntitle: A title\nsummary: One line.\nsection: memory\norder: 3\n---\n\n# A title\n\nText.\n"

describe("loadGuideArticles", () => {
  const contentDir = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "user-guide-"))
    for (const [name, raw] of Object.entries(files)) writeFileSync(join(dir, name), raw)
    return dir
  }

  test("should ignore hidden files when the content directory holds OS litter", () => {
    const dir = contentDir({ "a-title.md": valid, ".DS_Store": "\0binary" })

    expect(loadGuideArticles(dir).map((article) => article.slug)).toEqual(["a-title"])
  })

  test("should reject the content when it holds a visible file that is not an article", () => {
    const dir = contentDir({ "a-title.md": valid, "notes.txt": "draft" })

    expect(() => loadGuideArticles(dir)).toThrow('Guide content holds "notes.txt", which is not a .md article')
  })
})

describe("parseGuideArticle", () => {

  test("should return the front matter fields and the trimmed body when the article is valid", () => {
    expect(parseGuideArticle("a-title", valid)).toEqual({
      slug: "a-title",
      title: "A title",
      summary: "One line.",
      section: "memory",
      order: 3,
      body: "# A title\n\nText.",
    })
  })

  test("should reject the article when the section is unknown", () => {
    expect(() => parseGuideArticle("x", valid.replace("section: memory", "section: nope"))).toThrow(
      /unknown section "nope"/
    )
  })

  test("should reject the article when a field is missing", () => {
    expect(() => parseGuideArticle("x", valid.replace("summary: One line.\n", ""))).toThrow(/needs "summary"/)
  })

  test("should reject the article when order is not an integer", () => {
    expect(() => parseGuideArticle("x", valid.replace("order: 3", "order: soon"))).toThrow(/"order" must be an integer/)
  })

  test("should reject the article when the front matter has a key it does not know", () => {
    expect(() => parseGuideArticle("x", valid.replace("order: 3", "order: 3\ntags: memory"))).toThrow(
      /unknown front matter key "tags"/
    )
  })

  test("should reject the article when a value is quoted", () => {
    expect(() => parseGuideArticle("x", valid.replace("title: A title", 'title: "A title"'))).toThrow(
      /"title" must not be quoted/
    )
  })

  test("should reject the article when a key repeats", () => {
    expect(() => parseGuideArticle("x", valid.replace("order: 3", "order: 3\ntitle: Another"))).toThrow(
      /repeats "title"/
    )
  })

  test("should reject the article when the body does not open with its title as the heading", () => {
    expect(() => parseGuideArticle("x", valid.replace("# A title", "# Another title"))).toThrow(
      /body must start with "# A title"/
    )
  })

  test.each(["index", "Meet_Ariadne", "-lead"])("should reject the article when its slug is %p", (slug) => {
    expect(() => parseGuideArticle(slug, valid)).toThrow(/lowercase-hyphenated slug/)
  })

  test("should reject the article when there is no front matter", () => {
    expect(() => parseGuideArticle("x", "# Just a body\n")).toThrow(/missing front matter/)
  })
})
