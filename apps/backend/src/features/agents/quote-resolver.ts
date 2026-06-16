import type { Querier } from "../../db"
import type { JSONContent } from "@threa/types"
import { MessageRepository, type Message } from "../messaging"
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
    const quotedIds = extractQuoteReplyMessageIds(seed.contentJson)
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

    const fetched = await MessageRepository.findByIdsInStreams(db, toFetch, streamIdsArray)

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
      const quotedIds = extractQuoteReplyMessageIds(message.contentJson)
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

  return { resolved, authorNames }
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
  maxDepth: number = DEFAULT_MAX_QUOTE_DEPTH
): string {
  const base = message.contentMarkdown
  if (depth >= maxDepth) return base

  const quotedIds = extractQuoteReplyMessageIds(message.contentJson)
  if (quotedIds.length === 0) return base

  const blocks: string[] = [base]
  const seenAtThisLevel = new Set<string>()
  for (const quotedId of quotedIds) {
    // Dedupe: if the same message is quoted twice in one parent, only expand once
    if (seenAtThisLevel.has(quotedId)) continue
    seenAtThisLevel.add(quotedId)

    const quotedMessage = resolved.get(quotedId)
    if (!quotedMessage) continue

    const authorName = authorNames.get(quotedMessage.authorId) ?? "Unknown"
    const nestedContent = renderMessageWithQuoteContext(quotedMessage, resolved, authorNames, depth + 1, maxDepth)

    blocks.push(
      `<quoted-source id="${escapeXmlAttr(quotedMessage.id)}" author="${escapeXmlAttr(authorName)}" streamId="${escapeXmlAttr(quotedMessage.streamId)}" createdAt="${quotedMessage.createdAt.toISOString()}">\n${nestedContent}\n</quoted-source>`
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

function extractQuoteReplyMessageIds(content: JSONContent): string[] {
  const ids: string[] = []
  walkJsonNodes(content, (node) => {
    if (node.type === "quoteReply") {
      const messageId = node.attrs?.messageId
      if (typeof messageId === "string" && messageId.length > 0) {
        ids.push(messageId)
      }
    }
  })
  return ids
}

function walkJsonNodes(node: JSONContent, visit: (node: JSONContent) => void): void {
  visit(node)
  if (!node.content) return
  for (const child of node.content) {
    walkJsonNodes(child, visit)
  }
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
