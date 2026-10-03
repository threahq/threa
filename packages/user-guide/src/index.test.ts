import { describe, expect, test } from "bun:test"
import { parseAppLinkHref } from "@threahq/types"

import { loadGuideArticles, parseGuideArticle } from "./index"

const articles = loadGuideArticles()

const hrefs = (body: string) => [...body.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!)

describe("guide articles", () => {
  test("should parse every shipped article when loading the content directory", () => {
    expect(articles.length).toBeGreaterThan(0)
  })

  test("should have unique slugs when articles are flat files", () => {
    const slugs = articles.map((a) => a.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  test("should not use the overview's slug when naming an article", () => {
    expect(articles.map((a) => a.slug)).not.toContain("index")
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
        .filter((href) => !slugs.has(href.slice("/guide/".length)))
        .map((href) => `${a.slug}: ${href}`)
    )
    expect(dangling).toEqual([])
  })
})

describe("parseGuideArticle", () => {
  const valid = "---\ntitle: A title\nsummary: One line.\nsection: memory\norder: 3\n---\n\n# Body\n"

  test("should return the front matter fields and the trimmed body when the article is valid", () => {
    expect(parseGuideArticle("a-title", valid)).toEqual({
      slug: "a-title",
      title: "A title",
      summary: "One line.",
      section: "memory",
      order: 3,
      body: "# Body",
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

  test("should reject the article when there is no front matter", () => {
    expect(() => parseGuideArticle("x", "# Just a body\n")).toThrow(/missing front matter/)
  })
})
