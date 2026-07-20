/**
 * Command utilities for slash command detection.
 *
 * A message is treated as a command only when the ProseMirror content contains
 * a dedicated slash command node, mirroring how mentions, channels, and emojis
 * are represented as structural nodes rather than raw text matches. Raw text
 * like "/s" is NOT a command — nodes must be materialized by the editor's
 * slash trigger.
 *
 * As a send-time fallback, the composer also recognizes a message that is
 * *only* raw text matching `/command [args]` (e.g. `/model ` with a trailing
 * space). This recovers when auto-complete or quick typing leaves a command as
 * plain text instead of a `slashCommand` node. The caller is responsible for
 * verifying the extracted name against the commands available in the current
 * context.
 */

import type { JSONContent } from "@threa/types"

export interface ExtractedCommand {
  name: string
  /**
   * Opaque discriminator for client-action commands. When non-null the
   * composer handles the command locally (e.g. `/discuss-with-ariadne`)
   * instead of dispatching to `commandsApi`. Persisted on the node at pick
   * time via `CommandExtension.mapPropsToAttrs` so the composer doesn't
   * have to maintain a list of per-`name` client-action switches.
   */
  clientActionId: string | null
}

export interface RawTextCommand {
  name: string
  args: string
}

export interface ExtractedSteerDirective {
  content: JSONContent
  hasMessageContent: boolean
}

const RAW_STEER_PATTERN = /(^|[^\p{L}\p{N}_/])\/steer(?=$|[^\p{L}\p{N}_/-])/iu
const RAW_STEER_PATTERN_GLOBAL = new RegExp(RAW_STEER_PATTERN.source, "giu")
const INLINE_CONTENT_PLACEHOLDER = "\uFFFC"
const INLINE_CONTENT_CONTAINERS = new Set(["paragraph", "heading", "codeBlock"])

function steerDetectionText(node: JSONContent): string {
  if (node.type === "text") return node.text ?? ""
  if (node.type === "slashCommand") return `/${String(node.attrs?.name ?? "")}`
  if (node.type === "hardBreak") return "\n"
  if (node.content) {
    // Keep adjacent inline nodes contiguous so formatting-split tokens still
    // match, but separate every block container so list/quote boundaries do
    // not glue the preceding word to a following `/steer`.
    const separator = INLINE_CONTENT_CONTAINERS.has(node.type ?? "") ? "" : "\n"
    return node.content.map(steerDetectionText).join(separator)
  }
  return ["doc", "paragraph"].includes(node.type ?? "") ? "" : INLINE_CONTENT_PLACEHOLDER
}

/**
 * Detect `/steer` wherever it appears in a message. The authored document is
 * preserved as the normal message; a separate steer command follows it. A
 * plain-text projection is used only to distinguish a bare command from a
 * message and to match tokens split across formatting marks.
 */
export function extractSteerDirective(content: JSONContent): ExtractedSteerDirective | null {
  const text = steerDetectionText(content)
  if (!RAW_STEER_PATTERN.test(text)) return null
  const withoutSteer = text.replace(RAW_STEER_PATTERN_GLOBAL, "$1")
  return { content, hasMessageContent: withoutSteer.trim().length > 0 }
}

/**
 * Walk the content tree and return the first `slashCommand` node's attrs as
 * `{ name, clientActionId }`, or null when no command node is present.
 * Single traversal — a null result is the complete "no command here"
 * signal, so there's no need for a separate presence check.
 */
export function extractCommandNode(content: JSONContent): ExtractedCommand | null {
  if (content.type === "slashCommand") {
    const name = content.attrs?.name
    if (typeof name !== "string") return null
    const clientActionId = content.attrs?.clientActionId
    return {
      name,
      clientActionId: typeof clientActionId === "string" ? clientActionId : null,
    }
  }
  for (const child of content.content ?? []) {
    const found = extractCommandNode(child)
    if (found !== null) return found
  }
  return null
}

/**
 * Extract a slash command from raw text when the editor did not materialize a
 * `slashCommand` node. Only matches a message that is a single paragraph
 * containing a single text node, so a message like "I tried /model" is not
 * mistaken for a command.
 */
export function extractCommandFromRawText(content: JSONContent): RawTextCommand | null {
  if (content.type !== "doc") return null
  const paragraphs = content.content ?? []
  if (paragraphs.length !== 1) return null
  const paragraph = paragraphs[0]
  if (paragraph.type !== "paragraph") return null
  const nodes = paragraph.content ?? []
  if (nodes.length !== 1) return null
  const textNode = nodes[0]
  if (textNode.type !== "text" || typeof textNode.text !== "string") return null

  const trimmed = textNode.text.trim()
  const match = trimmed.match(/^\/([\w-]+)(?:\s+(.*))?$/s)
  if (!match) return null

  return {
    name: match[1].toLowerCase(),
    args: (match[2] ?? "").trim(),
  }
}
