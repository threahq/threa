import { collectInlineAttachmentIds, parseMarkdown } from "@threahq/prosemirror"
import type { JSONContent } from "@threahq/types"

const NONE: ReadonlySet<string> = new Set()

/** Attachments the message body renders inline, so the strip below it doesn't repeat them. */
export function inlineAttachmentIdSet(contentMarkdown: string, contentJson?: JSONContent): ReadonlySet<string> {
  if (!contentJson && !contentMarkdown.includes("display=inline")) return NONE
  const ids = collectInlineAttachmentIds(contentJson ?? parseMarkdown(contentMarkdown))
  return ids.length > 0 ? new Set(ids) : NONE
}
