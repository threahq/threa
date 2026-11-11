import type { Pool } from "pg"
import { linkFaviconHost, resolveFetchUserAgent } from "@threahq/types"
import { LinkFaviconRepository } from "./favicon-repository"
import { isBlockedUrl } from "./url-utils"
import { FAVICON_FETCH_TIMEOUT_MS, FAVICON_RETRY_TTL_MS, FAVICON_TTL_MS, MAX_FAVICON_BYTES } from "./config"

export interface LinkFaviconServiceDeps {
  pool: Pool
}

export interface LinkFaviconIcon {
  contentType: string
  bytes: Uint8Array
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b)
}

export function sniffFaviconType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp"
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon"
  return null
}

async function readCapped(response: Response): Promise<Uint8Array | null> {
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_FAVICON_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks, total)
}

async function fetchIcon(url: string, signal: AbortSignal): Promise<LinkFaviconIcon | null> {
  if (isBlockedUrl(url)) return null
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": resolveFetchUserAgent("Link Preview", url), Accept: "image/*" },
      signal,
      redirect: "follow",
    })
    if ((response.url && isBlockedUrl(response.url)) || !response.ok) {
      response.body?.cancel()
      return null
    }
    const bytes = await readCapped(response)
    if (!bytes) return null
    const contentType = sniffFaviconType(bytes)
    return contentType ? { contentType, bytes } : null
  } catch {
    return null
  }
}

export class LinkFaviconService {
  private readonly pool: Pool
  private readonly refreshes = new Map<string, Promise<void>>()

  constructor(deps: LinkFaviconServiceDeps) {
    this.pool = deps.pool
  }

  /** Concurrent calls for one host share a single refresh: links in a message hydrate in parallel. */
  async ensureForPage(workspaceId: string, pageUrl: string, candidateUrl: string): Promise<void> {
    const host = linkFaviconHost(pageUrl)
    if (!host) return

    const key = `${workspaceId} ${host}`
    let refresh = this.refreshes.get(key)
    if (!refresh) {
      refresh = this.refresh(workspaceId, host, pageUrl, candidateUrl).finally(() => this.refreshes.delete(key))
      this.refreshes.set(key, refresh)
    }
    await refresh
  }

  private async refresh(workspaceId: string, host: string, pageUrl: string, candidateUrl: string): Promise<void> {
    const existing = await LinkFaviconRepository.find(this.pool, workspaceId, host)
    if (existing && existing.expiresAt.getTime() > Date.now()) return

    const signal = AbortSignal.timeout(FAVICON_FETCH_TIMEOUT_MS)
    const candidates = [...new Set([candidateUrl, `${new URL(pageUrl).origin}/favicon.ico`])]
    for (const candidate of candidates) {
      const icon = await fetchIcon(candidate, signal)
      if (icon) {
        await LinkFaviconRepository.storeIcon(this.pool, {
          workspaceId,
          host,
          contentType: icon.contentType,
          bytes: icon.bytes,
          expiresAt: new Date(Date.now() + FAVICON_TTL_MS),
        })
        return
      }
    }

    await LinkFaviconRepository.recordMiss(this.pool, {
      workspaceId,
      host,
      expiresAt: new Date(Date.now() + FAVICON_RETRY_TTL_MS),
    })
  }

  async getIcon(workspaceId: string, host: string): Promise<LinkFaviconIcon | null> {
    const row = await LinkFaviconRepository.find(this.pool, workspaceId, host)
    if (!row?.bytes || !row.contentType) return null
    return { contentType: row.contentType, bytes: row.bytes }
  }
}
