import type { Querier } from "../../db"
import type { JSONContent } from "@threa/types"
import { collectQuoteReplyMessageIds } from "@threa/prosemirror"
import {
  MessageRepository,
  MessageVersionRepository,
  messageVersionKey,
  type Message,
  type MessageVersion,
  type MessageVersionKey,
} from "../messaging"
import { UserRepository } from "../workspaces"
import { PersonaRepository } from "./persona-repository"
import { logger } from "../../lib/logger"
import { escapeXmlAttr } from "../../lib/xml"

/**
 * Default maximum depth of quote-reply precursors to resolve.
 * A value of 5 means: for a seed message that quotes B, we follow up to
 * B→C→D→E→F (five hops of precursors from the seed).
 */
export const DEFAULT_MAX_QUOTE_DEPTH = 5

/**
 * Upper bound on the total number of precursor messages we will fetch across
 * all depth levels. Defends against crafted messages that try to explode the
 * fan-out (many quotes per message × many depth levels).
 */
export const DEFAULT_MAX_TOTAL_RESOLVED = 100

export interface ResolveQuoteRepliesInput {
  /**
   * Messages the caller already has; we walk their `contentJson` for
   * quoteReply nodes but never re-fetch them.
   */
  seedMessages: Message[]
  /**
   * Streams the invoking actor can read. A quoted message whose `streamId`
   * is not in this set is silently dropped (not leaked into the prompt).
   * For bot-initiated turns with no invoking user, callers should pass a
   * set containing only the current stream's id.
   */
  accessibleStreamIds: Set<string>
  /** Maximum precursor depth. Defaults to {@link DEFAULT_MAX_QUOTE_DEPTH}. */
  maxDepth?: number
  /** Hard cap on total fetched precursors. Defaults to {@link DEFAULT_MAX_TOTAL_RESOLVED}. */
  maxTotalResolved?: number
}

/** One `quoteReply` node reduced to what the prompt renderer needs. */
interface QuoteRef {
  messageId: string
  /** Source revision the node is pinned to; `null` on legacy unpinned nodes. */
  version: number | null
}

function collectQuoteReplyRefs(content: JSONContent | undefined): QuoteRef[] {
  const refs: QuoteRef[] = []
  const walk = (node: JSONContent | undefined): void => {
    if (!node) return
    if (node.type === "quoteReply") {
      const attrs = node.attrs as { messageId?: string; version?: number | null } | undefined
      if (attrs?.messageId) refs.push({ messageId: attrs.messageId, version: attrs.version ?? null })
    }
    for (const child of node.content ?? []) walk(child)
  }
  walk(content)
  return refs
}

/** Pinned precursor bodies, keyed by {@link messageVersionKey}. */
export type PinnedQuoteVersions = Map<string, MessageVersion>

export interface ResolveQuoteRepliesResult {
  /**
   * Map from quoted (precursor) message ID to the full resolved {@link Message}.
   * Only contains messages that were actually fetched — callers doing rendering
   * should treat missing entries as "do not expand" (the inline snippet will
   * still appear via the base markdown).
   */
  resolved: Map<string, Message>
  /**
   * Author names for every author of a resolved precursor, batch-fetched in
   * a single pair of queries at the end. Merge this into your own author map
   * before rendering.
   */
  authorNames: Map<string, string>
  /**
   * Bodies for precursors quoted at a revision older than their current one.
   * Pass to {@link renderMessageWithQuoteContext} so the model reads what the
   * quoter actually quoted, not what the source says now.
   */
  pinnedVersions: PinnedQuoteVersions
}

/**
 * Recursively resolve quote-reply precursors for a set of seed messages.
 *
 * BFS by depth level. At each level, collects all `quoteReply.attrs.messageId`
 * references from the current frontier, filters out already-visited IDs
 * (handles cycles, including edit-induced ones, since `MessageRepository.updateContent`
 * mutates in place and preserves the ID), then batch-fetches the next level
 * via `MessageRepository.findByIdsInStreams` — which applies access scoping
 * and soft-delete filtering at the SQL level.
 */
export async function resolveQuoteReplies(
  db: Querier,
  workspaceId: string,
  input: ResolveQuoteRepliesInput
): Promise<ResolveQuoteRepliesResult> {
  const maxDepth = input.maxDepth ?? DEFAULT_MAX_QUOTE_DEPTH
  const maxTotalResolved = input.maxTotalResolved ?? DEFAULT_MAX_TOTAL_RESOLVED
  const streamIdsArray = [...input.accessibleStreamIds]

  const resolved = new Map<string, Message>()
  // Seed visited with ALL seed IDs before walking, so adjacent history
  // messages that quote each other are never re-fetched as "precursors".
  const visited = new Set<string>(input.seedMessages.map((m) => m.id))

  // Walk seeds to get depth-0 frontier (= depth-1 precursors, since the seed is 0 hops).
  let frontier: string[] = []
  for (const seed of input.seedMessages) {
    const quotedIds = collectQuoteReplyMessageIds(seed.contentJson)
    for (const quotedId of quotedIds) {
      if (visited.has(quotedId)) {
        logger.debug({ messageId: seed.id, quotedId, reason: "cycle" }, "Quote resolution skipped reference")
        continue
      }
      visited.add(quotedId)
      frontier.push(quotedId)
    }
  }

  let depth = 0
  while (frontier.length > 0 && depth < maxDepth && resolved.size < maxTotalResolved) {
    const remaining = maxTotalResolved - resolved.size
    const toFetch = frontier.length > remaining ? frontier.slice(0, remaining) : frontier
    if (toFetch.length < frontier.length) {
      for (const skipped of frontier.slice(toFetch.length)) {
        logger.debug({ quotedId: skipped, reason: "total_cap", maxTotalResolved }, "Quote resolution skipped reference")
      }
    }

    const fetched = await MessageRepository.findByIdsInStreams(db, workspaceId, toFetch, streamIdsArray)

    for (const requestedId of toFetch) {
      if (!fetched.has(requestedId)) {
        logger.debug(
          { quotedId: requestedId, reason: "not_accessible_or_not_found" },
          "Quote resolution skipped reference"
        )
      }
    }

    const nextFrontier: string[] = []
    for (const [id, message] of fetched) {
      resolved.set(id, message)
      const quotedIds = collectQuoteReplyMessageIds(message.contentJson)
      for (const quotedId of quotedIds) {
        if (visited.has(quotedId)) {
          logger.debug({ messageId: id, quotedId, reason: "cycle" }, "Quote resolution skipped reference")
          continue
        }
        visited.add(quotedId)
        nextFrontier.push(quotedId)
      }
    }

    frontier = nextFrontier
    depth++
  }

  if (frontier.length > 0) {
    const reason = depth >= maxDepth ? "depth_cap" : "total_cap"
    for (const skipped of frontier) {
      logger.debug({ quotedId: skipped, reason, maxDepth, maxTotalResolved }, "Quote resolution skipped reference")
    }
  }

  const authorNames = await resolveAuthorNamesForMessages(db, workspaceId, [...resolved.values()])

  // Pins that name a superseded revision need that revision's body; a pin at
  // the source's current revision has no `message_versions` row and reads off
  // the row we already have. One batched query for the whole walk (INV-56).
  const versionKeys: MessageVersionKey[] = []
  const seenKeys = new Set<string>()
  for (const message of [...input.seedMessages, ...resolved.values()]) {
    for (const quote of collectQuoteReplyRefs(message.contentJson)) {
      const target = resolved.get(quote.messageId)
      if (!target || quote.version === null || quote.version >= target.revision) continue
      const cacheKey = messageVersionKey(quote.messageId, quote.version)
      if (seenKeys.has(cacheKey)) continue
      seenKeys.add(cacheKey)
      versionKeys.push({ messageId: quote.messageId, versionNumber: quote.version })
    }
  }
  const pinnedVersions = await MessageVersionRepository.findByMessageVersions(db, versionKeys)

  return { resolved, authorNames, pinnedVersions }
}

/**
 * Build an expanded markdown string for a message, appending `<quoted-source>`
 * blocks for each `quoteReply` node whose precursor was resolved.
 *
 * The output starts with `message.contentMarkdown` unchanged — including the
 * existing inline blockquote + attribution link that the ProseMirror markdown
 * serializer already emits for `quoteReply` nodes. We then append full-source
 * blocks after it. This way the model sees both "which snippet was quoted"
 * (the inline anchor) and "what the full source message was" (the appended
 * block).
 *
 * Nested quotes are expanded recursively up to `maxDepth` hops from the
 * top-level message. Unresolved references are silently omitted — the inline
 * snippet still appears in the base markdown so the model knows *something*
 * was quoted; the resolver logs why the expansion was skipped.
 */
export function renderMessageWithQuoteContext(
  message: Message,
  resolved: Map<string, Message>,
  authorNames: Map<string, string>,
  depth: number = 0,
  maxDepth: number = DEFAULT_MAX_QUOTE_DEPTH,
  pinnedVersions: PinnedQuoteVersions = new Map()
): string {
  const base = message.contentMarkdown
  if (depth >= maxDepth) return base

  const quotes = collectQuoteReplyRefs(message.contentJson)
  if (quotes.length === 0) return base

  const blocks: string[] = [base]
  const seenAtThisLevel = new Set<string>()
  for (const quote of quotes) {
    // Dedupe per pin: the same source quoted twice at the same revision expands
    // once, but two different pinned revisions are two different bodies.
    const pinKey = messageVersionKey(quote.messageId, quote.version ?? 0)
    if (seenAtThisLevel.has(pinKey)) continue
    seenAtThisLevel.add(pinKey)

    const quotedMessage = resolved.get(quote.messageId)
    if (!quotedMessage) continue

    const pinned =
      quote.version === null ? undefined : pinnedVersions.get(messageVersionKey(quote.messageId, quote.version))
    const body = pinned
      ? { ...quotedMessage, contentJson: pinned.contentJson, contentMarkdown: pinned.contentMarkdown }
      : quotedMessage

    const authorName = authorNames.get(quotedMessage.authorId) ?? "Unknown"
    const nestedContent = renderMessageWithQuoteContext(
      body,
      resolved,
      authorNames,
      depth + 1,
      maxDepth,
      pinnedVersions
    )
    const version = quote.version === null ? "" : ` version="${quote.version}"`

    blocks.push(
      `<quoted-source id="${escapeXmlAttr(quotedMessage.id)}" author="${escapeXmlAttr(authorName)}" streamId="${escapeXmlAttr(quotedMessage.streamId)}" createdAt="${quotedMessage.createdAt.toISOString()}"${version}>\n${nestedContent}\n</quoted-source>`
    )
  }

  return blocks.join("\n\n")
}

/**
 * Extract only the appended `<quoted-source>` blocks from a rendered message,
 * dropping the base `contentMarkdown` prefix. Used by the researcher path,
 * which wants the base content to stay as the single-line snippet it already
 * produces while attaching the quote context as a separate field.
 *
 * Returns an empty string if the renderer did not append anything (i.e. the
 * rendered output equals the base markdown).
 */
export function extractAppendedQuoteContext(rendered: string, base: string): string {
  if (rendered === base) return ""
  if (!rendered.startsWith(base)) {
    // Defensive: should not happen, but fall back to the full rendered output
    return rendered
  }
  // Strip the base prefix and the "\n\n" separator we inserted in the renderer
  const tail = rendered.slice(base.length)
  return tail.startsWith("\n\n") ? tail.slice(2) : tail
}

async function resolveAuthorNamesForMessages(
  db: Querier,
  workspaceId: string,
  messages: Message[]
): Promise<Map<string, string>> {
  if (messages.length === 0) return new Map()

  const userIds = new Set<string>()
  const personaIds = new Set<string>()
  for (const m of messages) {
    if (m.authorType === "user") userIds.add(m.authorId)
    else if (m.authorType === "persona") personaIds.add(m.authorId)
  }

  const [users, personas] = await Promise.all([
    userIds.size > 0 ? UserRepository.findByIds(db, workspaceId, [...userIds]) : Promise.resolve([]),
    personaIds.size > 0 ? PersonaRepository.findByIds(db, [...personaIds], workspaceId) : Promise.resolve([]),
  ])

  const names = new Map<string, string>()
  for (const u of users) names.set(u.id, u.name)
  for (const p of personas) names.set(p.id, p.name)
  return names
}
