/* Lives outside functions/ on purpose: every file under functions/ is a Pages
   route, so a test file there would deploy as one. */
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { mirrorCandidates, wantsMarkdown } from "../functions/_middleware"

describe("wantsMarkdown", () => {
  test("browsers keep getting HTML", () => {
    expect(wantsMarkdown("text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8")).toBe(false)
    expect(wantsMarkdown("")).toBe(false)
    expect(wantsMarkdown("*/*")).toBe(false)
  })

  test("text/markdown wins wherever it appears, unless refused", () => {
    expect(wantsMarkdown("text/markdown")).toBe(true)
    expect(wantsMarkdown("Text/Markdown; q=0.9")).toBe(true)
    expect(wantsMarkdown("text/markdown, text/plain, */*")).toBe(true)
    expect(wantsMarkdown("text/html, text/markdown;q=0")).toBe(false)
  })
})

describe("mirrorCandidates", () => {
  test("maps a page route to its mirrors, trailing slash or not", () => {
    expect(mirrorCandidates("/")).toEqual(["/index.md"])
    expect(mirrorCandidates("/about")).toEqual(["/about.md", "/about/index.md"])
    expect(mirrorCandidates("/developers/")).toEqual(["/developers.md", "/developers/index.md"])
  })

  test("a mirror asking for itself does not recurse", () => {
    expect(mirrorCandidates("/about.md")).toEqual([])
  })
})

/* The candidate order only pays off if the mirrors build-llms.ts writes are
   where the middleware looks; a rename on either side breaks negotiation
   silently, so this reads the real build output. */
test("every page route resolves to a built mirror", () => {
  const dist = (p: string) => fileURLToPath(new URL(`../dist${p}`, import.meta.url))
  if (!existsSync(dist("/index.html"))) {
    throw new Error("No dist/ — run `bun run build` before this test; it checks the built mirrors")
  }

  for (const route of ["/", "/about", "/developers", "/developers/authentication", "/developers/reference"]) {
    expect(mirrorCandidates(route).find((candidate) => existsSync(dist(candidate)))).toBeString()
  }
})
