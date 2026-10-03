import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadGuideArticles } from "@threahq/user-guide"

import { MIRROR_PREFIX, mirrorCandidates } from "../functions/_middleware"
import type { SearchEntry } from "../src/lib/search"
import { rehypeAppLinks } from "../src/lib/rehype-app-links"

const dist = fileURLToPath(new URL("../dist", import.meta.url))
const read = (path: string) => readFileSync(join(dist, path), "utf8")
const articles = loadGuideArticles()
const index: SearchEntry[] = JSON.parse(read("guide/search-index.json"))

describe("user guide pages", () => {
  test("builds a page and a markdown mirror for the overview and every article", () => {
    for (const path of ["guide", ...articles.map((a) => `guide/${a.slug}`)]) {
      const mirror = path === "guide" ? "guide/index.md" : `${path}.md`
      expect(read(`${path}/index.html`)).toContain('<article class="docs-article is-guide">')
      expect(read(mirror).startsWith(MIRROR_PREFIX)).toBe(true)
      expect(mirrorCandidates(`/${path}`)).toContain(`/${mirror}`)
    }
  })

  test("serves an article's own markdown as its mirror, with guide links pointing at mirrors", () => {
    const mirror = read("guide/meet-ariadne.md")
    expect(mirror).toContain("source: https://threa.io/guide/meet-ariadne\n")
    expect(mirror).toContain("[Your first scratchpad](https://threa.io/guide/your-first-scratchpad.md)")
    expect(mirror).toContain("[Memory](app:memory)")
  })

  test("renders app: links as chips into the app and leaves no raw app: href behind", () => {
    const html = read("guide/meet-ariadne/index.html")
    expect(html).toContain(
      '<a href="https://app.threa.io" class="app-link" title="Opens in the Threa app">AI settings</a>'
    )
    expect(html).not.toContain('href="app:')
  })

  test("shows the draft banner and the guide chrome, not the developers one", () => {
    const html = read("guide/what-is-threa/index.html")
    expect(html).toContain("docs-draft-banner")
    expect(html).toContain('data-search-index="/guide/search-index.json"')
    expect(html).not.toContain('id="pg-toggle"')
    expect(html).not.toContain('id="pg-panel"')
  })

  test("lists the guide in llms.txt, carries it in llms-full.txt and routes /guide through the markdown middleware", () => {
    const llms = read("llms.txt")
    expect(llms).toContain("## User guide (rough draft)")
    for (const a of articles) expect(llms).toContain(`(https://threa.io/guide/${a.slug}.md)`)

    const full = read("llms-full.txt")
    for (const a of articles) expect(full).toContain(`*Source: https://threa.io/guide/${a.slug}*\n\n# ${a.title}\n`)

    const routes = JSON.parse(read("_routes.json")) as { include: string[] }
    expect(routes.include).toEqual(expect.arrayContaining(["/guide", "/guide/*"]))
  })
})

describe("user guide search index", () => {
  test("has a page entry for every article, named for its section", () => {
    for (const a of articles) {
      expect(index.find((e) => e.url === `/guide/${a.slug}`)).toMatchObject({ kind: "page", title: a.title })
    }
    expect(index.find((e) => e.url === "/guide/meet-ariadne")?.where).toBe("Page in Getting started")
  })

  test("links every heading to an id that exists on its page", () => {
    const headings = index.filter((e) => e.kind === "heading")
    expect(headings.length).toBeGreaterThan(0)
    for (const h of headings) {
      const [path, id] = h.url.split("#")
      const html = read(`${path!.slice(1)}/index.html`)
      expect(html).toContain(`id="${id}"`)
    }
  })
})

describe("rehypeAppLinks", () => {
  type Node = Parameters<ReturnType<typeof rehypeAppLinks>>[0]
  const link = (href: string): Node => ({
    type: "element",
    tagName: "a",
    properties: { href },
    children: [{ type: "text" }],
  })

  test("rewrites a valid app: link into a chip that opens the app", () => {
    const a = link("app:settings/ai")
    rehypeAppLinks({ appUrl: "https://app.example" })({
      type: "root",
      children: [{ type: "element", tagName: "p", children: [a] }],
    })
    expect(a.properties).toEqual({
      href: "https://app.example",
      className: ["app-link"],
      title: "Opens in the Threa app",
    })
  })

  test("leaves ordinary links alone", () => {
    const a = link("/guide/meet-ariadne")
    rehypeAppLinks({ appUrl: "https://app.example" })({ type: "root", children: [a] })
    expect(a.properties).toEqual({ href: "/guide/meet-ariadne" })
  })

  test("fails when an app: link names a destination the app does not know", () => {
    const tree: Node = { type: "root", children: [link("app:nowhere")] }
    expect(() => rehypeAppLinks({ appUrl: "https://app.example" })(tree)).toThrow(
      /not a destination the app understands/
    )
  })
})
