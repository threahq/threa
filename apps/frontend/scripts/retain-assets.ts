#!/usr/bin/env bun
/**
 * Cross-deploy asset retention for the SPA.
 *
 * CF Pages serves only the latest deployment's files at app.threa.io, so the
 * moment a new build ships every previous build's content-hashed
 * /assets/*.js chunk 404s. A tab still running the old build then fails any
 * lazy `import()` it hasn't loaded yet ("Failed to fetch dynamically imported
 * module"). Older deployments could also cache the HTML app shell under the
 * missing asset URL, which is the stale-deploy crash lib/sw-recovery.ts exists
 * to clean up after.
 *
 * This keeps a rolling window of recent builds' assets and folds them back into
 * the new `dist/` before deploy, so an old tab can keep loading its own chunks
 * until it picks up the new build via the in-app update toast. The crash stops
 * happening rather than being recovered from.
 *
 * Folding happens AFTER `vite build`, so revived chunks are not in the SW
 * precache manifest: the new SW precaches only the current build, and the old
 * chunks are plain network-served fallbacks for tabs still on the old build.
 */
import { mkdir, readdir, copyFile, stat, utimes, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"

export interface RetainAssetsOptions {
  /** The just-built `dist/assets` directory to deploy. */
  distAssetsDir: string
  /** Persistent store of recent builds' assets, carried across CI runs via cache. */
  retainDir: string
  /** Injected for tests; defaults to now. */
  now?: number
  /** How long a chunk that has dropped out of the build stays revivable. */
  retentionMs?: number
}

export interface RetainAssetsResult {
  /** Old chunks copied back into the build so old tabs can still load them. */
  revived: number
  /** Files in the retain store after this run. */
  retained: number
  /** Files dropped for exceeding the retention window. */
  pruned: number
}

const DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000 // 14 days

export async function retainAssets(options: RetainAssetsOptions): Promise<RetainAssetsResult> {
  const now = options.now ?? Date.now()
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS
  const { distAssetsDir, retainDir } = options

  // A missing dist means the build never produced assets — fail loudly rather
  // than deploy a frontend with no chunks (INV-11).
  if (!existsSync(distAssetsDir)) {
    throw new Error(`dist assets dir not found: ${distAssetsDir} (did 'vite build' run first?)`)
  }
  await mkdir(retainDir, { recursive: true })

  // 1) Fold the current build into the retain store first, stamping mtime=now.
  //    Doing this before the prune is what keeps a chunk that is still part of
  //    the live build from ever aging out, however old its retained copy was.
  const currentNames = new Set<string>()
  for (const name of await readdir(distAssetsDir)) {
    const src = path.join(distAssetsDir, name)
    const info = await stat(src)
    if (!info.isFile()) continue
    currentNames.add(name)
    const dest = path.join(retainDir, name)
    await copyFile(src, dest)
    await utimes(dest, new Date(now), new Date(now))
  }

  // 2) Prune retained chunks past the window. mtime is the age signal; because
  //    step 1 re-stamped every live chunk to `now`, only chunks that have been
  //    absent from the build for the whole window age out here.
  let pruned = 0
  for (const name of await readdir(retainDir)) {
    const filePath = path.join(retainDir, name)
    const info = await stat(filePath)
    if (!info.isFile()) continue
    if (now - info.mtimeMs > retentionMs) {
      await rm(filePath)
      pruned++
    }
  }

  // 3) Revive retained chunks that dropped out of the current build. Never
  //    overwrite a current-build file — content-hashed names collide only when
  //    the bytes are identical, but a live file is the source of truth.
  let revived = 0
  for (const name of await readdir(retainDir)) {
    if (currentNames.has(name)) continue
    const src = path.join(retainDir, name)
    const info = await stat(src)
    if (!info.isFile()) continue
    await copyFile(src, path.join(distAssetsDir, name))
    revived++
  }

  const retained = (await readdir(retainDir)).length
  return { revived, retained, pruned }
}

if (import.meta.main) {
  const distAssetsDir = path.resolve(import.meta.dir, "../dist/assets")
  const retainDir = path.resolve(import.meta.dir, "../.retained-assets")
  const result = await retainAssets({ distAssetsDir, retainDir })
  console.log(
    `[retain-assets] revived ${result.revived} old chunk(s), pruned ${result.pruned}, ${result.retained} retained`
  )
}
