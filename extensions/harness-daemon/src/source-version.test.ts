import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSourceChangeWatch, daemonSourceRoots, fingerprintSources } from "./source-version"

const created: string[] = []
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

function packageDir(dependencies: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "harnessd-source-"))
  created.push(dir)
  mkdirSync(join(dir, "pkg", "src"), { recursive: true })
  writeFileSync(join(dir, "pkg", "package.json"), JSON.stringify({ name: "pkg", dependencies }))
  writeFileSync(join(dir, "pkg", "src", "index.ts"), "export const answer = 1\n")
  return join(dir, "pkg")
}

describe("daemonSourceRoots", () => {
  test("is the daemon's own src plus every path-linked workspace dependency that has one", () => {
    const dir = packageDir({ "@threahq/linked": "file:../linked", "@threahq/absent": "file:../absent", ws: "^1.0.0" })
    mkdirSync(join(dir, "..", "linked", "src"), { recursive: true })

    expect(daemonSourceRoots(dir)).toEqual([join(dir, "src"), join(dir, "..", "linked", "src")])
  })
})

describe("fingerprintSources", () => {
  test("follows content, not mtime: a rewritten-identical file reads as unchanged", () => {
    const dir = packageDir()
    const before = fingerprintSources([join(dir, "src")])
    writeFileSync(join(dir, "src", "index.ts"), "export const answer = 1\n")

    expect(fingerprintSources([join(dir, "src")])).toBe(before)

    writeFileSync(join(dir, "src", "index.ts"), "export const answer = 2\n")
    expect(fingerprintSources([join(dir, "src")])).not.toBe(before)
  })

  test("ignores test files, which no running session executes", () => {
    const dir = packageDir()
    const before = fingerprintSources([join(dir, "src")])
    writeFileSync(join(dir, "src", "index.test.ts"), "test('x', () => {})\n")

    expect(fingerprintSources([join(dir, "src")])).toBe(before)
  })

  test("covers nested directories", () => {
    const dir = packageDir()
    const before = fingerprintSources([join(dir, "src")])
    mkdirSync(join(dir, "src", "nested"))
    writeFileSync(join(dir, "src", "nested", "deep.ts"), "export const deep = true\n")

    expect(fingerprintSources([join(dir, "src")])).not.toBe(before)
  })
})

describe("createSourceChangeWatch", () => {
  test("reports a change only once the tree has stopped moving", () => {
    const readings = ["boot", "half-written", "current", "current", "current"]
    let index = 0
    const changed = createSourceChangeWatch(() => readings[index++]!)

    expect([changed(), changed(), changed()]).toEqual([false, false, true])
  })

  test("a tree that comes back to what the process loaded is never a change", () => {
    const readings = ["boot", "other", "boot", "boot"]
    let index = 0
    const changed = createSourceChangeWatch(() => readings[index++]!)

    expect([changed(), changed(), changed()]).toEqual([false, false, false])
  })

  test("fingerprints the real daemon tree without throwing", () => {
    const roots = daemonSourceRoots()
    expect(roots.length).toBeGreaterThan(1)
    expect(fingerprintSources(roots)).toBe(fingerprintSources(roots))
  })
})
