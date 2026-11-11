import { linkFaviconHost } from "@threahq/types"
import { sql } from "../../db"
import { registerBackfill, type BackfillContext } from "../../lib/backfill"
import type { LinkFaviconService } from "./favicon-service"

export const LINK_FAVICONS_BACKFILL_NAME = "link-favicons"
const CHUNK_SIZE = 20

export type LinkFaviconsChunk = { items: Array<{ pageUrl: string; faviconUrl: string }> }

export async function plan(ctx: BackfillContext, workspaceId: string): Promise<LinkFaviconsChunk[]> {
  const [previews, cached] = await Promise.all([
    ctx.pool.query<{ page_url: string; favicon_url: string }>(
      sql`SELECT normalized_url AS page_url, favicon_url
          FROM link_previews
          WHERE workspace_id = $1 AND status = 'completed' AND favicon_url IS NOT NULL
          ORDER BY fetched_at DESC NULLS LAST, id DESC`,
      [workspaceId]
    ),
    ctx.pool.query<{ host: string }>(sql`SELECT host FROM link_favicons WHERE workspace_id = $1`, [workspaceId]),
  ])

  const cachedHosts = new Set(cached.rows.map((row) => row.host))
  const latestByHost = new Map<string, LinkFaviconsChunk["items"][number]>()
  for (const row of previews.rows) {
    const host = linkFaviconHost(row.page_url)
    if (!host || cachedHosts.has(host) || latestByHost.has(host)) continue
    latestByHost.set(host, { pageUrl: row.page_url, faviconUrl: row.favicon_url })
  }

  const items = [...latestByHost.values()]
  const chunks: LinkFaviconsChunk[] = []
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    chunks.push({ items: items.slice(i, i + CHUNK_SIZE) })
  }
  return chunks
}

export interface LinkFaviconsBackfillContext extends BackfillContext {
  linkFaviconService: LinkFaviconService
}

export async function processChunk(
  ctx: LinkFaviconsBackfillContext,
  workspaceId: string,
  chunk: LinkFaviconsChunk
): Promise<{ processed: number }> {
  for (const item of chunk.items) {
    await ctx.linkFaviconService.ensureForPage(workspaceId, item.pageUrl, item.faviconUrl)
  }
  return { processed: chunk.items.length }
}

export function registerLinkFaviconsBackfill(deps: { linkFaviconService: LinkFaviconService }): void {
  registerBackfill<LinkFaviconsChunk>({
    name: LINK_FAVICONS_BACKFILL_NAME,
    plan,
    processChunk: (ctx, workspaceId, chunk) =>
      processChunk({ ...ctx, linkFaviconService: deps.linkFaviconService }, workspaceId, chunk),
  })
}
