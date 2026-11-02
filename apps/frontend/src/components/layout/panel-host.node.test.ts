import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// PanelHost keys its child on the promotion's draft id so a draft thread that
// becomes a real stream keeps its StreamPanel — and with it the composer's
// content and the focus hand-over that holds the mobile keyboard open. A host
// that keys the element itself unmounts everything before that key can apply,
// which is invisible on desktop and drops the keyboard on mobile. Three hosts
// did exactly that; this guard is why they can't again.

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

function collectSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...collectSourceFiles(full))
    else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) files.push(full)
  }
  return files
}

describe("PanelHost mount sites", () => {
  it("never carries a `key` prop from its host", () => {
    const violations: string[] = []
    for (const file of collectSourceFiles(srcRoot)) {
      const source = readFileSync(file, "utf8")
      // `[^>]*` spans newlines, so a key on its own line is caught too.
      for (const match of source.matchAll(/<PanelHost\b[^>]*\bkey=/g)) {
        const line = source.slice(0, match.index).split("\n").length
        violations.push(`${relative(srcRoot, file)}:${line}`)
      }
    }

    expect(
      violations,
      `A host keyed <PanelHost>. Remove the key — PanelHost keys its own child, ` +
        `and an outer key remounts the panel across a draft promotion:\n${violations.join("\n")}`
    ).toEqual([])
  })
})
