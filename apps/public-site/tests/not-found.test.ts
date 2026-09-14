import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const dist = (p: string) => fileURLToPath(new URL(`../dist${p}`, import.meta.url))

describe("404 page", () => {
  test("should ship a built 404.html fallback", () => {
    expect(existsSync(dist("/404.html"))).toBe(true)
  })

  test("should serve its own content and a home link", () => {
    const html = readFileSync(dist("/404.html"), "utf8")
    expect(html).toContain("That page doesn't exist.")
    expect(html).toContain('href="/"')
    expect(html).not.toContain("Chat that remembers")
  })

  test("should leave the fallback out of markdown discovery", () => {
    const mirror = ["/404.md", "/404/index.md"].find((path) => existsSync(dist(path))) ?? null
    expect(mirror).toBeNull()
  })
})
