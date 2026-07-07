import type { Querier } from "../../db"
import type { Message } from "../../features/messaging"
import type { AttachmentWithExtraction } from "../../features/attachments"
import { UserRepository } from "../../features/workspaces"
import { PersonaRepository } from "../../features/agents"
import { escapeXmlAttr } from "../xml"
import { formatRelativeDate } from "../temporal"

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * Formats messages for use in AI prompts with author names resolved from the database.
 *
 * Methods accept Querier to participate in the caller's transaction rather than
 * managing their own connections.
 */
export class MessageFormatter {
  /**
   * Format messages with author names resolved from the database.
   * Batch-fetches all unique author IDs to minimize queries (2 max: users + personas).
   *
   * @param options.includeIds - Prefix each message with its `id` attribute, so
   *   a model asked to cite source messages (memorizer, suggestion collector) has
   *   real ids to return. Off by default — callers that don't cite stay unchanged.
   *
   * @param options.relativeTo - Anchor date for a human-readable `age` attribute
   *   (e.g. `age="2 days ago"`). Absolute `createdAt` requires the model to reason
   *   about elapsed time; a relative age lets it judge durability directly (is the
   *   captured state still live, or a stale one-off?). Off by default.
   *
   * @example
   * const formatted = await messageFormatter.formatMessages(client, workspaceId, messages)
   * // <messages>
   * // <message authorType="user" authorId="user_123" authorName="Alice" createdAt="2021-01-01T00:00:00Z">Hello!</message>
   * // <message authorType="persona" authorId="persona_456" authorName="Ariadne" createdAt="2021-01-01T00:00:01Z">Hi there!</message>
   * // </messages>
   *
   * @example
   * // With ids + relative age (memorizer / classifier)
   * const formatted = await messageFormatter.formatMessages(client, ws, messages, { includeIds: true, relativeTo: new Date() })
   * // <message id="msg_123" authorType="user" authorId="user_123" authorName="Alice" createdAt="..." age="2 days ago">Hello!</message>
   */
  async formatMessages(
    client: Querier,
    workspaceId: string,
    messages: Message[],
    options?: { includeIds?: boolean; relativeTo?: Date }
  ): Promise<string> {
    if (messages.length === 0) return "<messages></messages>"

    const nameById = await this.resolveAuthorNames(client, workspaceId, messages)

    const formatted = messages.map((m) =>
      this.formatSingleMessage(m, nameById, options?.includeIds ?? false, options?.relativeTo)
    )

    return `<messages>\n${formatted.join("\n")}\n</messages>`
  }

  /** Batch-resolves author names in at most 2 queries (users + personas). */
  private async resolveAuthorNames(
    client: Querier,
    workspaceId: string,
    messages: Message[]
  ): Promise<Map<string, string>> {
    const userIds = new Set<string>()
    const personaIds = new Set<string>()

    for (const m of messages) {
      if (m.authorType === "user") {
        userIds.add(m.authorId)
      } else {
        personaIds.add(m.authorId)
      }
    }

    const [users, personas] = await Promise.all([
      UserRepository.findByIds(client, workspaceId, [...userIds]),
      PersonaRepository.findByIds(client, [...personaIds], workspaceId),
    ])

    const nameById = new Map<string, string>()
    for (const u of users) nameById.set(u.id, u.name)
    for (const p of personas) nameById.set(p.id, p.name)

    return nameById
  }

  private formatSingleMessage(
    m: Message,
    nameById: Map<string, string>,
    includeIds: boolean,
    relativeTo?: Date
  ): string {
    const authorName = nameById.get(m.authorId) ?? "Unknown"
    const idAttr = includeIds ? `id="${m.id}" ` : ""
    // Keep this attribute shape in sync with the eval fixture renderer
    // (apps/backend/evals/fixtures/memo.ts formatEvalMessages) so evals exercise
    // the same prompt the classifier/memorizer see in production (INV-45).
    const ageAttr = relativeTo ? ` age="${escapeXmlAttr(formatRelativeDate(m.createdAt, relativeTo))}"` : ""
    return `<message ${idAttr}authorType="${m.authorType}" authorId="${m.authorId}" authorName="${escapeXmlAttr(authorName)}" createdAt="${m.createdAt.toISOString()}"${ageAttr}>${escapeXml(m.contentMarkdown)}</message>`
  }

  /**
   * Format messages in a simple inline format for prompts.
   * Batch-fetches all unique author IDs to minimize queries.
   *
   * @param options.includeIds - Include message IDs in the output (for memorizer)
   *
   * @example
   * // Without IDs (classifier)
   * const formatted = await messageFormatter.formatMessagesInline(client, messages)
   * // [2024-01-01T10:00:00.000Z] [user] Alice: Hello!
   * // [2024-01-01T10:00:01.000Z] [persona] Ariadne: Hi there!
   *
   * @example
   * // With IDs (memorizer)
   * const formatted = await messageFormatter.formatMessagesInline(client, messages, { includeIds: true })
   * // [ID:msg_123] [2024-01-01T10:00:00.000Z] [user] Alice: Hello!
   * // [ID:msg_456] [2024-01-01T10:00:01.000Z] [persona] Ariadne: Hi there!
   */
  async formatMessagesInline(
    client: Querier,
    workspaceId: string,
    messages: Message[],
    options?: { includeIds?: boolean }
  ): Promise<string> {
    if (messages.length === 0) return ""

    const nameById = await this.resolveAuthorNames(client, workspaceId, messages)

    const formatted = messages.map((m) => {
      const authorName = nameById.get(m.authorId) ?? "Unknown"
      const idPrefix = options?.includeIds ? `[ID:${m.id}] ` : ""
      const timestamp = m.createdAt.toISOString()
      return `${idPrefix}[${timestamp}] [${m.authorType}] ${authorName}: ${m.contentMarkdown}`
    })

    return formatted.join("\n\n")
  }

  /**
   * Format messages with attachment extraction summaries included.
   * Batch-fetches all unique author IDs to minimize queries.
   *
   * Attachments are pre-fetched and passed in (already awaited for processing).
   * This allows the caller to await image processing before formatting.
   *
   * @param client Database client (for author name resolution)
   * @param messages Messages to format
   * @param attachmentsByMessageId Map of message ID to attachments with their extractions
   *
   * @example
   * const formatted = await messageFormatter.formatMessagesWithAttachments(client, messages, attachmentsMap)
   * // <messages>
   * // <message authorType="user" authorId="user_123" authorName="Alice" createdAt="...">
   * // What's in this image?
   * // <attachment filename="photo.jpg" contentType="photo">A colorful tropical fish swimming in a coral reef</attachment>
   * // </message>
   * // </messages>
   */
  async formatMessagesWithAttachments(
    client: Querier,
    workspaceId: string,
    messages: Message[],
    attachmentsByMessageId: Map<string, AttachmentWithExtraction[]>
  ): Promise<string> {
    if (messages.length === 0) return "<messages></messages>"

    const nameById = await this.resolveAuthorNames(client, workspaceId, messages)

    const formatted = messages.map((m) => {
      const authorName = nameById.get(m.authorId) ?? "Unknown"
      const attachments = attachmentsByMessageId.get(m.id) ?? []

      const attachmentTags = attachments
        .filter((a) => a.extraction !== null)
        .map((a) => {
          const ext = a.extraction!
          return `<attachment filename="${escapeXmlAttr(a.filename)}" contentType="${escapeXmlAttr(ext.contentType)}">${escapeXml(ext.summary)}</attachment>`
        })
        .join("\n")

      const content = attachmentTags
        ? `${escapeXml(m.contentMarkdown)}\n${attachmentTags}`
        : escapeXml(m.contentMarkdown)

      return `<message authorType="${m.authorType}" authorId="${m.authorId}" authorName="${escapeXmlAttr(authorName)}" createdAt="${m.createdAt.toISOString()}">\n${content}\n</message>`
    })

    return `<messages>\n${formatted.join("\n")}\n</messages>`
  }
}
