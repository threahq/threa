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

import { ENQUEUE_COMMAND, type JSONContent } from "@threahq/types"

export interface ExtractedCommand {
  name: string
  /**
   * Opaque discriminator for client-action commands. When non-null the
   * composer handles the command locally (e.g. `/aside`)
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

/**
 * `/enqueue` found in a message: the message without it, to wait for the
 * session's next turn, or nothing left to send.
 */
export type EnqueueDirective = { kind: "enqueue-message"; content: JSONContent } | { kind: "empty-enqueue" }

// Group 1 is the whitespace before the token, group 2 the whitespace after it,
// so a token mid-sentence collapses to one space and one at either edge leaves none.
const ENQUEUE_TOKEN = new RegExp(`(^|\\s+)/${ENQUEUE_COMMAND}(?=\\s|$)(\\s*)`, "giu")
// Stands in for a neighbour that isn't whitespace, so a token glued to it
// (a mention, inline code, a formatting-split word) is not matched.
const NOT_A_BOUNDARY = "\uFFFC"

const isCode = (node: JSONContent) => node.marks?.some((mark) => mark.type === "code") === true
const isEnqueueNode = (node: JSONContent) =>
  node.type === "slashCommand" && String(node.attrs?.name ?? "").toLowerCase() === ENQUEUE_COMMAND
// Blocks that hold nothing once the directive is gone are dropped with it. Table
// parts are not: removing a cell or row would reshape the table.
const PRUNABLE_WHEN_EMPTIED = new Set(["paragraph", "heading", "listItem", "bulletList", "orderedList", "blockquote"])

function hasBoundaryAt(node: JSONContent | undefined, edge: "start" | "end"): boolean {
  if (!node || node.type === "hardBreak") return true
  if (node.type !== "text" || isCode(node)) return false
  return (edge === "end" ? /\s$/u : /^\s/u).test(node.text ?? "")
}

function stripTextTokens(text: string, before: JSONContent | undefined, after: JSONContent | undefined): string {
  const lead = hasBoundaryAt(before, "end") ? "" : NOT_A_BOUNDARY
  const trail = hasBoundaryAt(after, "start") ? "" : NOT_A_BOUNDARY
  let source = `${lead}${text}${trail}`
  // Adjacent tokens share the whitespace between them, so one pass leaves every other one.
  for (;;) {
    const stripped = source.replace(ENQUEUE_TOKEN, (_, pre: string, post: string) => (pre && post ? " " : ""))
    if (stripped === source) return stripped.slice(lead.length, stripped.length - trail.length)
    source = stripped
  }
}

/** Returns `node` itself when it holds no directive, so identity says whether anything was removed. */
function stripEnqueueTokens(node: JSONContent, typed: boolean): JSONContent {
  const children = node.content
  if (!children || node.type === "codeBlock") return node
  let changed = false
  let afterRemovedNode = false
  const kept: JSONContent[] = []
  children.forEach((child, index) => {
    if (isEnqueueNode(child)) {
      changed = true
      afterRemovedNode = true
      return
    }
    let next = child
    if (child.type === "text" && !isCode(child)) {
      if (typed) {
        const text = stripTextTokens(child.text ?? "", children[index - 1], children[index + 1])
        if (text !== child.text) next = { ...child, text }
      }
    } else if (child.content) {
      next = stripEnqueueTokens(child, typed)
      if (next !== child && !next.content?.length && PRUNABLE_WHEN_EMPTIED.has(next.type ?? "")) {
        changed = true
        return
      }
    }
    changed ||= next !== child
    // A formatted text node that was only the token goes like a picked node.
    if (next.type === "text" && !next.text) {
      afterRemovedNode = true
      return
    }
    // A removed node sat between two spaces (or an edge): keep one. Between two words, keep them apart.
    if (afterRemovedNode && next.type === "text") {
      const text = next.text ?? ""
      if (hasBoundaryAt(kept.at(-1), "end")) next = { ...next, text: text.replace(/^\s+/u, "") }
      else if (!isCode(next) && !/^\s/u.test(text)) next = { ...next, text: ` ${text}` }
    }
    afterRemovedNode = false
    if (next.type !== "text" || next.text) kept.push(next)
  })
  const last = kept.at(-1)
  if (afterRemovedNode && last?.type === "text") {
    const text = (last.text ?? "").replace(/\s+$/u, "")
    if (text) kept[kept.length - 1] = { ...last, text }
    else kept.pop()
  }
  return changed ? { ...node, content: kept } : node
}

function hasContent(node: JSONContent): boolean {
  if (node.type === "text") return (node.text ?? "").trim().length > 0
  if (node.type === "hardBreak") return false
  if (!node.content?.length) return !["doc", "paragraph", "heading"].includes(node.type ?? "")
  return node.content.some(hasContent)
}

/** Whether a typed `/enqueue` counts: only where the stream advertises it. */
export function offersEnqueue(commands: readonly { name: string }[]): boolean {
  return commands.some((command) => command.name.toLowerCase() === ENQUEUE_COMMAND)
}

/**
 * Find `/enqueue` wherever it sits in a message: a picked command node, or,
 * when `typed` is set, the token typed standing alone between whitespace
 * (never in code). Enqueue is a send mode, not a command, so every occurrence
 * is removed from the content the session receives and the send carries the
 * flag instead. A picked node always counts: dispatched as a command it could
 * only be refused.
 */
export function extractEnqueueDirective(content: JSONContent, { typed }: { typed: boolean }): EnqueueDirective | null {
  const stripped = stripEnqueueTokens(content, typed)
  if (stripped === content) return null
  return hasContent(stripped) ? { kind: "enqueue-message", content: stripped } : { kind: "empty-enqueue" }
}

/**
 * The inverse of {@link extractEnqueueDirective}: the message with a picked
 * `/enqueue` leading it, so editing a queued message shows how it was sent.
 */
export function withEnqueueDirective(content: JSONContent): JSONContent {
  const directive: JSONContent = { type: "slashCommand", attrs: { name: ENQUEUE_COMMAND } }
  const [first, ...rest] = content.content ?? []
  if (first?.type === "paragraph") {
    const lead = first.content?.length ? [directive, { type: "text", text: " " }] : [directive]
    return { ...content, content: [{ ...first, content: [...lead, ...(first.content ?? [])] }, ...rest] }
  }
  return { ...content, content: [{ type: "paragraph", content: [directive] }, ...(content.content ?? [])] }
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

/**
 * Rebuild a dispatched command as composer content: the `slashCommand` node
 * the editor materializes, followed by its args as text. The inverse of
 * {@link extractCommandNode}, so the rebuilt doc dispatches the same command
 * when sent again.
 */
export function commandDoc(name: string, args: string): JSONContent {
  const trimmed = args.trim()
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "slashCommand", attrs: { name } },
          ...(trimmed.length > 0 ? [{ type: "text", text: ` ${trimmed}` }] : []),
        ],
      },
    ],
  }
}
