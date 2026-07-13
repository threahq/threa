import type { Pool } from "pg"
import type { JSONContent } from "@threa/types"
import type { Querier } from "../../db"
import { logger } from "../../lib/logger"
import { escapeXmlAttr } from "../../lib/xml"
import { MAX_PREVIEWS_PER_MESSAGE, getAppOrigins } from "./config"
import { LinkPreviewRepository, type LinkPreview } from "./repository"
import { extractUrls, normalizeUrl } from "./url-utils"

export const DEFAULT_LINK_PREVIEW_PROCESSING_TIMEOUT_MS = 5_000
const POLL_INTERVAL_MS = 100

export interface LinkPreviewContextMessage {
  id: string
  contentMarkdown: string
  contentJson: JSONContent
}

export interface AwaitLinkPreviewProcessingResult {
  allCompleted: boolean
  completedUrls: string[]
  failedOrTimedOutUrls: string[]
}

/**
 * Wait for the preview worker to create and settle every preview implied by the
 * canonical message content. Rows may not exist on the first poll because URL
 * extraction and AI consumers are independent outbox peers.
 */
export async function awaitLinkPreviewProcessing(
  pool: Pool,
  workspaceId: string,
  messages: LinkPreviewContextMessage[],
  timeoutMs: number = DEFAULT_LINK_PREVIEW_PROCESSING_TIMEOUT_MS
): Promise<AwaitLinkPreviewProcessingResult> {
  const appOrigins = getAppOrigins()
  const expected = new Map<string, Set<string>>()
  for (const message of messages) {
    const urls = extractUrls(message.contentMarkdown, appOrigins, message.contentJson).slice(
      0,
      MAX_PREVIEWS_PER_MESSAGE
    )
    if (urls.length > 0) expected.set(message.id, new Set(urls.map(normalizeUrl)))
  }
  if (expected.size === 0) return { allCompleted: true, completedUrls: [], failedOrTimedOutUrls: [] }

  const startedAt = Date.now()
  const completedKeys = new Set<string>()
  const failedKeys = new Set<string>()

  while (Date.now() - startedAt < timeoutMs) {
    const rowsByMessage = await LinkPreviewRepository.findByMessageIds(pool, workspaceId, [...expected.keys()])
    let hasPending = false

    for (const [messageId, normalizedUrls] of expected) {
      const rows = rowsByMessage.get(messageId) ?? []
      for (const normalizedUrl of normalizedUrls) {
        const row = rows.find((candidate) => candidate.normalizedUrl === normalizedUrl)
        if (!row) {
          hasPending = true
        } else if (row.status === "completed") {
          completedKeys.add(`${messageId}:${normalizedUrl}`)
        } else if (row.status === "failed") {
          failedKeys.add(`${messageId}:${normalizedUrl}`)
        } else {
          hasPending = true
        }
      }
    }

    if (!hasPending) break
    await sleep(POLL_INTERVAL_MS)
  }

  const timedOutUrls: string[] = []
  for (const [messageId, normalizedUrls] of expected) {
    for (const normalizedUrl of normalizedUrls) {
      const key = `${messageId}:${normalizedUrl}`
      if (!completedKeys.has(key) && !failedKeys.has(key)) timedOutUrls.push(normalizedUrl)
    }
  }
  if (timedOutUrls.length > 0) {
    logger.warn(
      { workspaceId, timedOutCount: timedOutUrls.length, timeoutMs },
      "Link previews timed out before AI context assembly"
    )
  }

  const failedUrls = [...failedKeys].map((key) => key.slice(key.indexOf(":") + 1))
  const completedUrls = [...completedKeys].map((key) => key.slice(key.indexOf(":") + 1))
  const failedOrTimedOutUrls = [...failedUrls, ...timedOutUrls]
  return {
    allCompleted: failedOrTimedOutUrls.length === 0,
    completedUrls,
    failedOrTimedOutUrls,
  }
}

/** Append completed card metadata to message text without mutating stored content. */
export async function enrichMessagesWithLinkPreviews<T extends LinkPreviewContextMessage>(
  db: Querier,
  workspaceId: string,
  messages: T[]
): Promise<T[]> {
  if (messages.length === 0) return messages
  const previewsByMessage = await LinkPreviewRepository.findByMessageIds(
    db,
    workspaceId,
    messages.map((message) => message.id)
  )

  return messages.map((message) => {
    const rendered = renderLinkPreviewContext(
      (previewsByMessage.get(message.id) ?? []).filter((preview) => preview.status === "completed")
    )
    return rendered ? { ...message, contentMarkdown: `${message.contentMarkdown}\n\n${rendered}` } : message
  })
}

/** Render the textual fields visible on a preview card; image URLs add no semantic context. */
export function renderLinkPreviewContext(previews: LinkPreview[]): string {
  return previews
    .filter((preview) => preview.title || preview.description || preview.siteName)
    .map((preview) => {
      const attrs = [`url="${escapeXmlAttr(preview.url)}"`]
      if (preview.siteName) attrs.push(`site="${escapeXmlAttr(preview.siteName)}"`)
      if (preview.title) attrs.push(`title="${escapeXmlAttr(preview.title)}"`)
      const body = preview.description ? `\n${escapeXml(preview.description)}\n` : ""
      return `<link-preview ${attrs.join(" ")}>${body}</link-preview>`
    })
    .join("\n")
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
