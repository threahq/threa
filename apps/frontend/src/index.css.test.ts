import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "index.css")
const css = readFileSync(cssPath, "utf8")

describe("index.css accessibility font families", () => {
  it("applies selected font family to the body when data-font-family is set on root", () => {
    expect(css).toMatch(/\[data-font-family="system"] body/)
    expect(css).toMatch(/\[data-font-family="monospace"] body/)
    expect(css).toMatch(/\[data-font-family="dyslexic"] body/)
  })

  it("keeps the app default font stack for the system accessibility option", () => {
    expect(css).toMatch(/\[data-font-family="system"],\s*\[data-font-family="system"] body\s*{[\s\S]*"Space Grotesk"/)
  })
})

describe("index.css mobile inline-edit composer hiding", () => {
  it("hides the mobile stream composer while an inline edit surface is active", () => {
    expect(css).toMatch(
      /@media\s*\(max-width:\s*639px\)\s*{[\s\S]*body\[data-inline-edit-active\]\s*\[data-message-composer-root\]\s*{[\s\S]*display:\s*none/
    )
    expect(css).not.toContain("body:has(")
  })
})
