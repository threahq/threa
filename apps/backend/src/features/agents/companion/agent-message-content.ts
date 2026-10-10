import type { Pool } from "pg"
import { collectAttachmentReferenceIds, parseMarkdown } from "@threahq/prosemirror"
import type { JSONContent } from "@threahq/types"
import { normalizeMessage, toEmoji } from "../../emoji"
import { stripInaccessibleAgentRefs } from "./strip-inaccessible-refs"

export interface AgentMessageContent {
  contentJson: JSONContent
  contentMarkdown: string
  attachmentIds?: string[]
}

export async function buildAgentMessageContent(params: {
  pool: Pool
  workspaceId: string
  streamId: string
  content: string
  /** Omit to skip ref stripping; event-service then rejects the message on any ref the author cannot reach. */
  accessibleStreamIds?: string[]
}): Promise<AgentMessageContent> {
  const initialMarkdown = normalizeMessage(params.content)
  const initialJson = parseMarkdown(initialMarkdown, undefined, toEmoji)
  let contentJson = initialJson
  let contentMarkdown = initialMarkdown
  if (params.accessibleStreamIds) {
    const stripped = await stripInaccessibleAgentRefs({
      pool: params.pool,
      workspaceId: params.workspaceId,
      targetStreamId: params.streamId,
      accessibleStreamIds: params.accessibleStreamIds,
      contentJson: initialJson,
    })
    contentJson = stripped.contentJson
    contentMarkdown = stripped.contentMarkdown
  }
  // Read from the cleaned tree: event-service gates access on these ids and
  // refreshes the `attachment_references` projection from them (INV-7).
  const attachmentIds = collectAttachmentReferenceIds(contentJson)
  return {
    contentJson,
    contentMarkdown,
    attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
  }
}
