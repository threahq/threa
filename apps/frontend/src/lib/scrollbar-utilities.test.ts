import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// Tailwind ships no `scrollbar-*` utilities and this project loads no plugin
// that adds them — every one is hand-written in `index.css`. A name that isn't
// there compiles, lints and types clean while doing nothing, which is how
// `scrollbar-none` rode along on three scroll strips and let the stream header
// paint scrollbars around the label glyphs.

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function collectSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      files.push(full)
    }
  }
  return files
}

describe("scrollbar utilities", () => {
  it("defines every scrollbar-* class the app uses", () => {
    const css = readFileSync(join(srcRoot, "index.css"), "utf8")
    const defined = new Set([...css.matchAll(/\.(scrollbar-[a-z0-9-]+)/g)].map((m) => m[1]))

    const violations: string[] = []
    for (const file of collectSourceFiles(srcRoot)) {
      const lines = readFileSync(file, "utf8").split("\n")
      lines.forEach((line, i) => {
        // `(?<!\[)` skips Tailwind arbitrary properties (`[scrollbar-width:none]`),
        // which are CSS declarations rather than a class this file could define.
        for (const match of line.matchAll(/(?<![[\w-])(scrollbar-[a-z0-9-]+)(?![\w-]|:)/g)) {
          if (!defined.has(match[1])) violations.push(`${relative(srcRoot, file)}:${i + 1} — ${match[1]}`)
        }
      })
    }

    expect(
      violations,
      `Used a scrollbar-* class with no rule in index.css — it renders nothing. ` +
        `Define it next to .scrollbar-thin or use an existing one:\n${violations.join("\n")}`
    ).toEqual([])
  })
})
