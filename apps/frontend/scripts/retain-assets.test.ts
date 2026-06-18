import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, mkdir, writeFile, rm, readFile, utimes, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { retainAssets } from "./retain-assets"

const DAY = 24 * 60 * 60 * 1000

describe("retainAssets", () => {
  let root: string
  let distAssetsDir: string
  let retainDir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "retain-assets-"))
    distAssetsDir = path.join(root, "dist", "assets")
    retainDir = path.join(root, ".retained-assets")
    await mkdir(distAssetsDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function writeAsset(dir: string, name: string, content: string, mtimeMs?: number) {
    const filePath = path.join(dir, name)
    await mkdir(dir, { recursive: true })
    await writeFile(filePath, content)
    if (mtimeMs !== undefined) await utimes(filePath, new Date(mtimeMs), new Date(mtimeMs))
  }

  it("revives a chunk that dropped out of the new build", async () => {
    // Previous build retained an old chunk; the new build no longer ships it.
    await writeAsset(retainDir, "old-AAA.js", "old-chunk")
    await writeAsset(distAssetsDir, "index-BBB.js", "new-entry")

    const result = await retainAssets({ distAssetsDir, retainDir })

    expect(result).toMatchObject({ revived: 1, pruned: 0 })
    expect(existsSync(path.join(distAssetsDir, "old-AAA.js"))).toBe(true)
    expect(await readFile(path.join(distAssetsDir, "old-AAA.js"), "utf8")).toBe("old-chunk")
  })

  it("never overwrites a current-build file with a retained copy", async () => {
    await writeAsset(retainDir, "index-BBB.js", "stale-bytes")
    await writeAsset(distAssetsDir, "index-BBB.js", "fresh-bytes")

    const result = await retainAssets({ distAssetsDir, retainDir })

    expect(result.revived).toBe(0)
    expect(await readFile(path.join(distAssetsDir, "index-BBB.js"), "utf8")).toBe("fresh-bytes")
  })

  it("prunes a chunk that has been absent past the retention window", async () => {
    const now = Date.now()
    await writeAsset(retainDir, "ancient-CCC.js", "ancient", now - 20 * DAY)
    await writeAsset(distAssetsDir, "index-BBB.js", "new-entry")

    const result = await retainAssets({ distAssetsDir, retainDir, now, retentionMs: 14 * DAY })

    expect(result).toMatchObject({ revived: 0, pruned: 1 })
    expect(existsSync(path.join(retainDir, "ancient-CCC.js"))).toBe(false)
    expect(existsSync(path.join(distAssetsDir, "ancient-CCC.js"))).toBe(false)
  })

  it("keeps a chunk alive indefinitely while it stays in the build", async () => {
    const start = Date.now()
    // The chunk has been in the retain store since well past the window, but it
    // is still part of the current build, so it must not be pruned.
    await writeAsset(retainDir, "stable-DDD.js", "stable", start - 30 * DAY)
    await writeAsset(distAssetsDir, "stable-DDD.js", "stable")

    const result = await retainAssets({ distAssetsDir, retainDir, now: start, retentionMs: 14 * DAY })

    expect(result.pruned).toBe(0)
    expect(existsSync(path.join(retainDir, "stable-DDD.js"))).toBe(true)

    // A later deploy where the chunk has finally dropped out now ages it from
    // the freshly-stamped mtime, not its original 30-day-old one.
    await rm(path.join(distAssetsDir, "stable-DDD.js"))
    await writeAsset(distAssetsDir, "index-EEE.js", "newer-entry")
    const later = await retainAssets({
      distAssetsDir,
      retainDir,
      now: start + 10 * DAY,
      retentionMs: 14 * DAY,
    })
    expect(later).toMatchObject({ revived: 1, pruned: 0 })
  })

  it("creates the retain store on first run and folds the build into it", async () => {
    await writeAsset(distAssetsDir, "index-BBB.js", "new-entry")
    await writeAsset(distAssetsDir, "vendor-FFF.js", "vendor")

    const result = await retainAssets({ distAssetsDir, retainDir })

    expect(result).toMatchObject({ revived: 0, pruned: 0, retained: 2 })
    expect((await readdir(retainDir)).sort()).toEqual(["index-BBB.js", "vendor-FFF.js"])
  })

  it("throws when the dist assets dir is missing", async () => {
    await rm(distAssetsDir, { recursive: true, force: true })
    await expect(retainAssets({ distAssetsDir, retainDir })).rejects.toThrow(/dist assets dir not found/)
  })
})
