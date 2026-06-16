import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// INV-63: success is silent. A happy-path action that the UI already reflects
// must not pop a `toast.success(...)`. Toasts are reserved for what needs the
// user's attention (errors, warnings, deferred/offline state). The only
// `toast.success` calls allowed are actions with no other on-screen signal
// (clipboard copy / download from a closing menu or a keyboard shortcut), and
// each carries an `INV-63-allow:` justification on the same or preceding line.
// This guard fails the build on any unjustified success toast so the policy
// can't silently regress as new mutation handlers are added.

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

describe("INV-63: no happy-path success toasts", () => {
  it("has no toast.success() call without an INV-63-allow justification", () => {
    const violations: string[] = []
    for (const file of collectSourceFiles(srcRoot)) {
      const lines = readFileSync(file, "utf8").split("\n")
      lines.forEach((line, i) => {
        if (!/\btoast\.success\s*\(/.test(line)) return
        const prev = lines[i - 1] ?? ""
        if (line.includes("INV-63-allow") || prev.includes("INV-63-allow")) return
        violations.push(`${relative(srcRoot, file)}:${i + 1}`)
      })
    }

    expect(
      violations,
      `Found happy-path success toast(s) (INV-63). Remove them — the UI already ` +
        `reflects the result — or, if the action has no other on-screen signal, ` +
        `confirm in place (icon → checkmark) or add an "INV-63-allow: <reason>" ` +
        `comment:\n${violations.join("\n")}`
    ).toEqual([])
  })
})
