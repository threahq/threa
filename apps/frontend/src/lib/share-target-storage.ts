/**
 * Transport for a Web Share Target POST: the service worker stashes the shared
 * text and files in the Cache API, the app reads them back after the redirect.
 *
 * The cache is keyed by URL only, so on a browser signed in to several accounts
 * nothing about a stash said whose share it was — whoever opened `/share` next
 * consumed it, and its files were uploaded into that account's workspace. Every
 * stash therefore names the account whose credential the worker verified when
 * the share arrived, and every read states the account it expects; a stash owned
 * by anyone else (or by nobody, as pre-marker stashes are) reads as absent.
 *
 * A share that arrives with no verifiable account keeps no content at all — only
 * the marker `/share` renders its "dropped" state from. Storing the content and
 * naming an owner later would be a guess at the owner, which is the leak itself.
 */

import { SHARE_TARGET_CACHE } from "./sw-messages"

const META_KEY = "/_share/meta"
const UNCLAIMED_KEY = "/_share/unclaimed"

function ownedCacheName(owner: string): string {
  return `${SHARE_TARGET_CACHE}:${owner}`
}

function fileKey(stashId: string, index: number): string {
  return `/_share/file/${stashId}/${index}`
}

/** One stashed share, bound to the account the worker verified at stash time. */
export interface ShareStashMeta {
  title: string | null
  text: string | null
  url: string | null
  fileCount: number
  /** WorkOS user id of the account whose session cookie the worker resolved. */
  owner: string
  /** Identifies this stash, so a file read spanning a replacing share detects it. */
  stashId: string
}

/** Lightweight metadata, safe to pass via `history.state` — no binary blobs. */
export interface ShareMeta {
  title: string | null
  text: string | null
  url: string | null
  hasFiles: boolean
}

/**
 * What `/share` found: `shared` for this account's stash, `unclaimed` when the
 * worker could not name an owner and dropped the content, `none` for no stash,
 * another account's stash, or a pre-marker one whose owner is unknowable.
 */
export type ShareTargetRead = { kind: "none" } | { kind: "unclaimed" } | { kind: "shared"; meta: ShareMeta }

export interface StashShareTargetInput {
  title: string | null
  text: string | null
  url: string | null
  files: File[]
  /** The verified WorkOS user id, or null when the worker could not establish one. */
  owner: string | null
}

/**
 * Replace the stash with this share. Writes the metadata last, so a concurrent
 * read never sees a `fileCount` whose files are still being stored.
 */
export async function stashShareTarget(input: StashShareTargetInput): Promise<void> {
  if (!input.owner) {
    const cache = await caches.open(SHARE_TARGET_CACHE)
    await cache.put(UNCLAIMED_KEY, new Response("1"))
    return
  }

  const cache = await caches.open(ownedCacheName(input.owner))
  const stashId = crypto.randomUUID()
  let fileCount = 0
  for (const file of input.files) {
    await cache.put(
      fileKey(stashId, fileCount),
      new Response(file, {
        headers: {
          "Content-Type": file.type,
          "X-Filename": encodeURIComponent(file.name),
          "X-Size": String(file.size),
        },
      })
    )
    fileCount++
  }

  const meta: ShareStashMeta = {
    title: input.title,
    text: input.text,
    url: input.url,
    fileCount,
    owner: input.owner,
    stashId,
  }
  await cache.put(META_KEY, new Response(JSON.stringify(meta)))
}

function asText(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

/** The stash's own record of itself, or null when it names no owner. */
async function matchMeta(cache: Cache): Promise<ShareStashMeta | null> {
  const response = await cache.match(META_KEY)
  if (!response) return null
  const raw = (await response.json()) as Partial<ShareStashMeta> | null
  if (!raw || typeof raw.owner !== "string" || raw.owner.length === 0) return null
  if (typeof raw.stashId !== "string" || raw.stashId.length === 0) return null
  return {
    title: asText(raw.title),
    text: asText(raw.text),
    url: asText(raw.url),
    fileCount: typeof raw.fileCount === "number" ? raw.fileCount : 0,
    owner: raw.owner,
    stashId: raw.stashId,
  }
}

/** Read the stash's text metadata, for `expectedOwner` and nobody else. */
export async function readShareStash(expectedOwner: string | null): Promise<ShareTargetRead> {
  try {
    if (!expectedOwner) return { kind: "none" }
    const cache = await caches.open(ownedCacheName(expectedOwner))
    const meta = await matchMeta(cache)
    if (!meta) {
      const unclaimed = await caches.open(SHARE_TARGET_CACHE)
      return (await unclaimed.match(UNCLAIMED_KEY)) ? { kind: "unclaimed" } : { kind: "none" }
    }
    if (!expectedOwner || meta.owner !== expectedOwner) return { kind: "none" }
    return {
      kind: "shared",
      meta: { title: meta.title, text: meta.text, url: meta.url, hasFiles: meta.fileCount > 0 },
    }
  } catch {
    return { kind: "none" }
  }
}

/**
 * Read the stashed file blobs, for `expectedOwner` and nobody else. Separate
 * from {@link readShareStash} because files must NOT go through `history.state`
 * — browsers enforce serialization size limits (~640 KB in Firefox).
 *
 * The stash is checked again after the blobs load so a newer share from the
 * same account cannot pair its metadata with the previous share's files.
 */
export async function readShareStashFiles(expectedOwner: string | null): Promise<File[]> {
  try {
    if (!expectedOwner) return []
    const cache = await caches.open(ownedCacheName(expectedOwner))
    const meta = await matchMeta(cache)
    if (!meta || meta.owner !== expectedOwner) return []

    const files: File[] = []
    for (let i = 0; i < meta.fileCount; i++) {
      const fileResponse = await cache.match(fileKey(meta.stashId, i))
      if (!fileResponse) continue
      const blob = await fileResponse.blob()
      const rawFilename = fileResponse.headers.get("X-Filename")
      files.push(new File([blob], rawFilename ? decodeURIComponent(rawFilename) : `file-${i}`, { type: blob.type }))
    }

    const settled = await matchMeta(cache)
    if (!settled || settled.owner !== expectedOwner || settled.stashId !== meta.stashId) return []
    return files
  } catch {
    return []
  }
}

/** Remove the stash after it has been consumed. */
export async function clearShareStash(expectedOwner: string | null): Promise<void> {
  if (!expectedOwner) return
  try {
    await caches.delete(ownedCacheName(expectedOwner))
  } catch {
    // Best-effort cleanup.
  }
}
