/**
 * Bidirectional Markdown ↔ ProseMirror JSON conversion.
 *
 * This module provides consistent conversion between markdown text and
 * ProseMirror JSON format, used by both frontend (TipTap editor) and
 * backend (AI agents, external integrators).
 */

import type { JSONContent, JSONContentMark } from "@threa/types"
import {
  escapeMarkdownLinkText,
  parseAttachmentMetadata,
  serializeAttachmentMetadata,
  unescapeMarkdownLinkText,
} from "./attachment-markdown"
import { buildGiphyHref, buildMemoHref, buildQuoteHref, buildSharedMessageHref, parseGiphyHref } from "./pointer-urls"

// ============================================================================
// Shared Inline Pattern
// ============================================================================

/**
 * Inline markdown pattern - captures each format type in separate groups.
 * Group layout (order matters for matching priority):
 *   1-4:   Attachment  [text](attachment:id "meta") → groups: full, text, id, optional title
 *   5-7:   Memo        [title](memo:id)             → groups: full, title, memoId (before Link)
 *   8-10:  Link        [text](url)     → groups: full, text, url
 *   11-12: BoldItalic  ***text***      → groups: full, text (must come before ** and *)
 *   13-14: Bold        **text**        → groups: full, text
 *   15-16: Italic      *text*          → groups: full, text (with negative lookahead/behind for **)
 *   17-18: Strike      ~~text~~        → groups: full, text
 *   19-20: Code        `text`          → groups: full, text
 *   21-22: Mention     @slug           → groups: full, slug (requires preceding whitespace or ^)
 *   23-24: Channel     #slug           → groups: full, slug (requires preceding whitespace or ^)
 *   25-26: Emoji       :shortcode:     → groups: full, shortcode
 *
 * Exported so both the shared package and the frontend editor can use the same
 * source of truth (use `new RegExp(INLINE_MARKDOWN_PATTERN, "g")`).
 */
export const INLINE_MARKDOWN_PATTERN =
  /(\[((?:\\.|[^\\\]])+)\]\(attachment:([^)\s"]+)(?:\s+"((?:\\"|\\\\|[^"])*)")?\))|(\[((?:\\.|[^\\\]])+)\]\(memo:([\w-]+)\))|(\[([^\]]+)\]\(([^)]+)\))|(\*\*\*(.+?)\*\*\*)|(\*\*(.+?)\*\*)|(?<!\*)(\*([^*]+?)\*)(?!\*)|(\~\~(.+?)\~\~)|(`([^`]+)`)|((?<=\s|^)@([\w-]+))|((?<=\s|^)#([\w-]+))|(:([\w+-]+):)/
    .source

// ============================================================================
// JSON → Markdown Serialization
// ============================================================================

/**
 * Serialize ProseMirror JSON to Markdown string.
 */
export function serializeToMarkdown(content: JSONContent): string {
  if (!content.content) return ""
  // Group consecutive top-level `tableRow` nodes into a synthetic table.
  // ProseMirror's CellSelection serializes to a slice whose top-level children
  // are bare table rows (no enclosing `table`); without this grouping a copy
  // of "two cells across two rows" would round-trip through a non-table fallback.
  const nodes = content.content
  const out: string[] = []
  let i = 0
  while (i < nodes.length) {
    const node = nodes[i]
    if (node.type === "tableRow") {
      const rows: JSONContent[] = []
      while (i < nodes.length && nodes[i].type === "tableRow") {
        rows.push(nodes[i])
        i++
      }
      out.push(serializeTable({ type: "table", content: rows }))
      continue
    }
    out.push(serializeNode(node))
    i++
  }
  return out.join("\n\n")
}

function serializeNode(node: JSONContent, listDepth = 0, listIndex?: number): string {
  if (!node) return ""

  switch (node.type) {
    case "paragraph":
      return serializeInline(node.content)

    case "heading": {
      const level = (node.attrs?.level as number) ?? 1
      return "#".repeat(level) + " " + serializeInline(node.content)
    }

    case "codeBlock": {
      const lang = (node.attrs?.language as string) ?? ""
      const code = node.content?.map((n) => n.text ?? "").join("") ?? ""
      return "```" + lang + "\n" + code + "\n```"
    }

    case "blockquote": {
      const quoted = node.content?.map((n) => serializeNode(n)).join("\n") ?? ""
      return quoted
        .split("\n")
        .map((line) => "> " + line)
        .join("\n")
    }

    case "quoteReply": {
      const { messageId, streamId, authorName, authorId, actorType, snippet } = node.attrs as {
        messageId: string
        streamId: string
        authorName: string
        authorId: string
        actorType: string
        snippet: string
      }
      const quotedLines = snippet
        .split("\n")
        .map((line) => "> " + line)
        .join("\n")
      // Escape ] and \ in author name to prevent breaking the markdown link syntax
      const escapedAuthor = authorName.replace(/\\/g, "\\\\").replace(/\]/g, "\\]")
      // Blank `>` line forces a paragraph break so react-markdown creates separate
      // <p> elements for the snippet and attribution (needed for display extraction).
      const href = buildQuoteHref({ streamId, messageId, authorId, actorType })
      return `${quotedLines}\n>\n> — [${escapedAuthor}](${href})`
    }

    case "sharedMessage": {
      const { messageId, streamId, authorName } = node.attrs as {
        messageId: string
        streamId: string
        authorName?: string
      }
      // Wire-format serialization only — the frontend hydrates live content
      // on render, so this fallback is what external API consumers see and
      // what sidebar/activity previews strip through INV-60 helpers. We use
      // markdown link syntax (not bare parens) so `stripMarkdown` reduces
      // the line to a clean sentence: "Shared a message from Alice".
      const rawName = authorName && authorName.length > 0 ? authorName : "another stream"
      const escapedName = rawName.replace(/\\/g, "\\\\").replace(/\]/g, "\\]")
      return `Shared a message from [${escapedName}](${buildSharedMessageHref({ streamId, messageId })})`
    }

    case "bulletList":
      return (
        node.content
          ?.map((item) => serializeNode(item, listDepth))
          .filter(Boolean)
          .join("\n") ?? ""
      )

    case "orderedList":
      return (
        node.content
          ?.map((item, i) => serializeNode(item, listDepth, i + 1))
          .filter(Boolean)
          .join("\n") ?? ""
      )

    case "listItem": {
      const indent = "  ".repeat(listDepth)
      const marker = typeof listIndex === "number" ? `${listIndex}. ` : "- "
      const content =
        node.content
          ?.map((n) => serializeNode(n, listDepth + 1))
          .filter(Boolean)
          .join("\n") ?? ""
      return indent + marker + content
    }

    case "horizontalRule":
      return "---"

    case "hardBreak":
      return "\n"

    case "table":
      return serializeTable(node)

    default:
      return serializeInline(node.content)
  }
}

/**
 * Serialize a `table` node to GFM-flavoured markdown.
 *
 * Cells are flattened to a single line of inline markdown — pipes are escaped
 * as `\|` and any hard breaks / extra paragraphs are joined with `<br>` so
 * remark-gfm can round-trip them back into multi-line cells. The first row
 * of every table is emitted as a header even when the source row contains
 * `tableCell` nodes; GFM does not have a header-less table form, and the
 * downstream renderer (react-markdown + remark-gfm) treats any table without
 * a header as invalid and drops it. Forcing a header row keeps the table
 * visible.
 */
function serializeTable(node: JSONContent): string {
  const rows = node.content ?? []
  if (rows.length === 0) return ""

  const grid: string[][] = rows.map((row) => {
    const cells = row.content ?? []
    return cells.map((cell) => serializeTableCell(cell))
  })

  const columnCount = grid.reduce((max, row) => Math.max(max, row.length), 0)
  if (columnCount === 0) return ""

  // Pad short rows so the resulting markdown is rectangular.
  for (const row of grid) {
    while (row.length < columnCount) row.push("")
  }

  const headerCells = grid[0]
  const separator = Array.from({ length: columnCount }, () => "---")
  const bodyRows = grid.slice(1)

  const lines: string[] = []
  lines.push(`| ${headerCells.join(" | ")} |`)
  lines.push(`| ${separator.join(" | ")} |`)
  for (const row of bodyRows) {
    lines.push(`| ${row.join(" | ")} |`)
  }
  return lines.join("\n")
}

function serializeTableCell(cell: JSONContent): string {
  const blocks = cell.content ?? []
  if (blocks.length === 0) return ""
  // Cells default to `block+` but the GFM grammar only supports inline content,
  // so flatten any block-level child to its inline serialization. Lists and
  // code blocks would emit newlines that break the row grammar, so we never
  // recurse through `serializeNode`.
  const lines = blocks.map((block) => serializeInline(block.content)).filter((line) => line.length > 0)
  // Escape user-typed `<br>` so it doesn't collide with the literal `<br>` tag
  // we use as a paragraph / hard-break separator. `buildTableCell` reverses
  // this when parsing back.
  const escaped = lines.map((line) => line.replace(/<br\s*\/?>/gi, "&lt;br&gt;"))
  const joined = escaped.join("<br>")
  // Escape pipes so they don't terminate the cell, and collapse hard-break
  // newlines into `<br>` for the same reason. Leading/trailing whitespace
  // inside a cell is meaningless in GFM, so trim.
  return joined.replace(/\|/g, "\\|").replace(/\n/g, "<br>").trim()
}

/**
 * Get plain text content from a node (for atom nodes like mentions).
 */
function getNodeText(node: JSONContent): string {
  if (node.type === "hardBreak") return "\n"
  if (node.type === "mention") {
    const slug = node.attrs?.slug as string
    return slug ? `@${slug}` : ""
  }
  if (node.type === "channelLink") {
    const slug = node.attrs?.slug as string
    return slug ? `#${slug}` : ""
  }
  if (node.type === "slashCommand") {
    const name = node.attrs?.name as string
    return name ? `/${name}` : ""
  }
  if (node.type === "attachmentReference") {
    const id = node.attrs?.id as string
    const filename = node.attrs?.filename as string
    const mimeType = node.attrs?.mimeType as string
    const imageIndex = node.attrs?.imageIndex as number | null
    const status = node.attrs?.status as string

    // Skip uploading/error nodes in serialization
    if (status === "uploading" || status === "error") {
      return ""
    }

    // Format: [Image #1](attachment:id) or [filename](attachment:id)
    const isImage = mimeType?.startsWith("image/")
    const displayText = isImage && imageIndex ? `Image #${imageIndex}` : filename
    const escapedDisplayText = escapeMarkdownLinkText(displayText)
    const metadata = serializeAttachmentMetadata(node.attrs)
    return `[${escapedDisplayText}](attachment:${id}${metadata})`
  }
  if (node.type === "emoji") {
    const shortcode = node.attrs?.shortcode as string
    return shortcode ? `:${shortcode}:` : ""
  }
  if (node.type === "memoEmbed") {
    const memoId = node.attrs?.memoId as string
    if (!memoId) return ""
    // Wire-format only — the frontend hydrates the live memo card on render.
    // Markdown link syntax keeps INV-60 strip helpers reducing it to a clean
    // title; the cached title is the fallback external consumers see.
    const title = node.attrs?.title as string | undefined
    const rawTitle = title && title.length > 0 ? title : "Memo"
    const escapedTitle = rawTitle.replace(/\\/g, "\\\\").replace(/\]/g, "\\]")
    return `[${escapedTitle}](${buildMemoHref({ memoId })})`
  }
  if (node.type === "giphyEmbed") {
    const giphyUrl = node.attrs?.giphyUrl as string
    if (!giphyUrl) return ""
    // Render-from-CDN pointer (no byte copy). The label is a cosmetic fallback
    // for markdown/preview consumers; strip bracket/backslash chars so it parses
    // cleanly through the generic link branch (which isn't escape-aware).
    const title = node.attrs?.title as string | undefined
    const rawTitle = title && title.length > 0 ? title : "GIF"
    const safeTitle = rawTitle.replace(/[[\]\\\n]/g, " ").trim() || "GIF"
    const width = node.attrs?.width as number | undefined
    const height = node.attrs?.height as number | undefined
    return `[${safeTitle}](${buildGiphyHref({ giphyUrl, width, height })})`
  }
  if (node.type === "text") return node.text ?? ""
  return ""
}

/**
 * Check if a node is an atom (mention, channel, command, attachment, emoji).
 */
function isAtomNode(node: JSONContent): boolean {
  return (
    node.type === "mention" ||
    node.type === "channelLink" ||
    node.type === "slashCommand" ||
    node.type === "command" ||
    node.type === "attachmentReference" ||
    node.type === "emoji" ||
    node.type === "memoEmbed" ||
    node.type === "giphyEmbed"
  )
}

/**
 * Get marks from a node, with atom nodes inheriting from adjacent text.
 */
function getEffectiveMarks(nodes: JSONContent[], index: number): JSONContentMark[] {
  const node = nodes[index]

  // Text nodes have their own marks
  if (node.type === "text") {
    return node.marks ?? []
  }

  // Atom nodes inherit marks from adjacent text nodes
  if (isAtomNode(node)) {
    // Look for marks from next text node (preferred for "@here hello" case)
    for (let i = index + 1; i < nodes.length; i++) {
      if (nodes[i].type === "text" && nodes[i].marks?.length) {
        return nodes[i].marks!
      }
      if (!isAtomNode(nodes[i])) break
    }
    // Fall back to previous text node
    for (let i = index - 1; i >= 0; i--) {
      if (nodes[i].type === "text" && nodes[i].marks?.length) {
        return nodes[i].marks!
      }
      if (!isAtomNode(nodes[i])) break
    }
  }

  return []
}

/**
 * Check if two mark arrays are equivalent.
 */
function marksEqual(a: JSONContentMark[], b: JSONContentMark[]): boolean {
  if (a.length !== b.length) return false
  const aTypes = a.map((m) => m.type).sort()
  const bTypes = b.map((m) => m.type).sort()
  return aTypes.every((t, i) => t === bTypes[i])
}

/**
 * Wrap text with markdown mark syntax.
 * Preserves leading/trailing whitespace outside the marks.
 */
function wrapWithMarks(text: string, marks: JSONContentMark[]): string {
  if (marks.length === 0) return text

  // Extract leading and trailing whitespace
  const leadingMatch = text.match(/^(\s*)/)
  const trailingMatch = text.match(/(\s*)$/)
  const leading = leadingMatch?.[1] ?? ""
  const trailing = trailingMatch?.[1] ?? ""
  const trimmed = text.slice(leading.length, text.length - trailing.length)

  // Don't wrap pure whitespace
  if (!trimmed) return text

  let result = trimmed
  for (const mark of marks) {
    switch (mark.type) {
      case "bold":
        result = `**${result}**`
        break
      case "italic":
        result = `*${result}*`
        break
      case "strike":
        result = `~~${result}~~`
        break
      case "code":
        result = "`" + result + "`"
        break
      case "link":
        result = `[${result}](${resolveSerializedLinkHref(result, (mark.attrs?.href as string) ?? "")})`
        break
    }
  }
  return leading + result + trailing
}

function resolveSerializedLinkHref(displayText: string, href: string): string {
  if (!href) return href

  try {
    const displayUrl = new URL(displayText)
    const hrefUrl = new URL(href)

    if (
      !hrefUrl.hash &&
      displayUrl.hash &&
      displayUrl.origin === hrefUrl.origin &&
      displayUrl.pathname === hrefUrl.pathname &&
      displayUrl.search === hrefUrl.search
    ) {
      return displayText
    }
  } catch {
    return href
  }

  return href
}

function serializeInline(nodes: JSONContent[] | undefined): string {
  if (!nodes) return ""

  // Group consecutive nodes with same effective marks
  const groups: Array<{ text: string; marks: JSONContentMark[] }> = []

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const text = getNodeText(node)
    if (!text) continue

    const marks = getEffectiveMarks(nodes, i)

    // Check if we can append to the last group
    if (groups.length > 0 && marksEqual(groups[groups.length - 1].marks, marks)) {
      groups[groups.length - 1].text += text
    } else {
      groups.push({ text, marks })
    }
  }

  // Serialize each group with its marks
  return groups.map((group) => wrapWithMarks(group.text, group.marks)).join("")
}

// ============================================================================
// Markdown → JSON Parsing
// ============================================================================

/**
 * Lookup function to determine mention type from slug.
 * "me" is a special type for the current user's own mentions.
 */
export type MentionTypeLookup = (slug: string) => "user" | "persona" | "bot" | "broadcast" | "me"

/**
 * Lookup function to get emoji character from shortcode.
 * Returns null if shortcode is not a valid emoji.
 */
export type EmojiLookup = (shortcode: string) => string | null

/**
 * Per-call gates for the structured-token conversions. Defaults for every
 * flag are `true`, so callers that don't care (the AI/external API path,
 * for instance) get the full conversion. The frontend composer flips
 * specific flags off when sending a slash-command (no `@mention` parsing
 * for `/invite alice` body) or any other place where one of these tokens
 * should remain literal text.
 */
export interface ParseMarkdownOptions {
  enableMentions?: boolean
  enableChannels?: boolean
  enableSlashCommands?: boolean
  enableEmoji?: boolean
  /**
   * Keep resolved emoji shortcodes as editable text instead of atom nodes.
   * Useful for composer surfaces where mobile browsers struggle with deleting
   * adjacent contenteditable=false emoji atoms.
   */
  emojiAsText?: boolean
}

interface ParseOptions extends ParseMarkdownOptions {
  getMentionType?: MentionTypeLookup
  getEmoji?: EmojiLookup
}

/**
 * Parse Markdown string to ProseMirror JSON.
 */
export function parseMarkdown(
  markdown: string,
  getMentionType?: MentionTypeLookup,
  getEmoji?: EmojiLookup,
  parseOptions: ParseMarkdownOptions = {}
): JSONContent {
  const options: ParseOptions = { getMentionType, getEmoji, ...parseOptions }
  if (!markdown.trim()) {
    return { type: "doc", content: [{ type: "paragraph" }] }
  }

  const lines = normalizeMarkdownTables(markdown).split("\n")
  const content: JSONContent[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i])
        i++
      }
      content.push({
        type: "codeBlock",
        attrs: { language: lang || null },
        content: codeLines.length ? [{ type: "text", text: codeLines.join("\n") }] : undefined,
      })
      i++
      continue
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      content.push({
        type: "heading",
        attrs: { level: headingMatch[1].length },
        content: parseInlineMarkdown(headingMatch[2], options),
      })
      i++
      continue
    }

    // Blockquote (or quoteReply if last line has quote: attribution)
    if (line.startsWith("> ") || line === ">") {
      const quoteLines: string[] = []
      while (i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">")) {
        quoteLines.push(lines[i] === ">" ? "" : lines[i].slice(2))
        i++
      }

      // Check if last line is a quote-reply attribution: — [Author](quote:streamId/messageId/authorId/actorType)
      // Author name may contain escaped brackets: \] and \\
      // authorId and actorType are optional for backward compat with old messages.
      const lastLine = quoteLines[quoteLines.length - 1]
      const quoteReplyMatch = lastLine?.match(
        /^—\s*\[((?:\\.|[^\]])+)\]\(quote:([\w-]+)\/([\w-]+)(?:\/([\w-]+)\/([\w-]+))?\)$/
      )

      if (quoteReplyMatch) {
        // Unescape \] and \\ in author name
        const authorName = quoteReplyMatch[1].replace(/\\([\]\\])/g, "$1")
        const streamId = quoteReplyMatch[2]
        const messageId = quoteReplyMatch[3]
        const authorId = quoteReplyMatch[4] ?? ""
        const actorType = quoteReplyMatch[5] ?? "user"
        // Strip the attribution line and any blank separator line before it
        const snippetLines = quoteLines.slice(0, -1)
        while (snippetLines.length > 0 && snippetLines[snippetLines.length - 1] === "") {
          snippetLines.pop()
        }
        const snippet = snippetLines.join("\n")
        content.push({
          type: "quoteReply",
          attrs: { messageId, streamId, authorName, authorId, actorType, snippet },
        })
      } else {
        content.push({
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: parseInlineMarkdown(quoteLines.join("\n"), options),
            },
          ],
        })
      }
      continue
    }

    // Unordered list
    if (line.match(/^[-*]\s/)) {
      const listItems: JSONContent[] = []
      while (i < lines.length && lines[i].match(/^[-*]\s/)) {
        listItems.push({
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: parseInlineMarkdown(lines[i].replace(/^[-*]\s/, ""), options),
            },
          ],
        })
        i++
      }
      content.push({ type: "bulletList", content: listItems })
      continue
    }

    // Ordered list
    if (line.match(/^\d+\.\s/)) {
      const listItems: JSONContent[] = []
      while (i < lines.length && lines[i].match(/^\d+\.\s/)) {
        listItems.push({
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: parseInlineMarkdown(lines[i].replace(/^\d+\.\s/, ""), options),
            },
          ],
        })
        i++
      }
      content.push({ type: "orderedList", content: listItems })
      continue
    }

    // GFM table — header row + separator row + zero or more body rows.
    // Detected by peeking at the next line for the dashes-and-pipes
    // separator; without that peek a normal paragraph that happens to
    // contain pipes (`foo | bar`) would be misclassified as a table.
    if (isTableSeparatorLine(lines[i + 1]) && isTableRowLine(line)) {
      const table = parseTableBlock(lines, i, options)
      if (table) {
        content.push(table.node)
        i = table.nextIndex
        continue
      }
    }

    // Horizontal rule
    if (line.match(/^---+$/) || line.match(/^\*\*\*+$/)) {
      content.push({ type: "horizontalRule" })
      i++
      continue
    }

    // Empty line - skip
    if (!line.trim()) {
      i++
      continue
    }

    // Shared message pointer line — inverse of the `sharedMessage`
    // serializer above. Letting paste roundtrip into a `sharedMessage` node
    // (instead of a generic paragraph + link) means re-sending a copied
    // message keeps the cross-stream pointer; the backend share-recording
    // step then re-validates and records the share grant.
    const sharedMessageMatch = parseSharedMessageLine(line)
    if (sharedMessageMatch) {
      content.push({
        type: "sharedMessage",
        attrs: {
          messageId: sharedMessageMatch.messageId,
          streamId: sharedMessageMatch.streamId,
          authorName: sharedMessageMatch.authorName,
          authorId: "",
          actorType: "user",
        },
      })
      i++
      continue
    }

    // Regular paragraph
    content.push({
      type: "paragraph",
      content: parseInlineMarkdown(line, options),
    })
    i++
  }

  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] }
}

/**
 * Match the canonical shared-message pointer line:
 *   `Shared a message from [Author](shared-message:streamId/messageId)`
 *
 * Returns the parsed metadata or `null` when the line is anything else.
 * Author names containing `]` are escaped as `\]` per the serializer.
 */
function parseSharedMessageLine(line: string): { authorName: string; streamId: string; messageId: string } | null {
  const match = line.match(/^Shared a message from \[((?:\\.|[^\]])+)\]\(shared-message:([\w-]+)\/([\w-]+)\)\s*$/)
  if (!match) return null
  const authorName = match[1].replace(/\\([\]\\])/g, "$1")
  return { authorName, streamId: match[2], messageId: match[3] }
}

/**
 * Collapse blank lines that sit between two pipe-bearing rows so that GFM
 * tables emitted with extra spacing for readability still parse as tables.
 * LLMs and some hand-written markdown produce:
 *
 *   | a | b |
 *
 *   | --- | --- |
 *
 *   | c | d |
 *
 * which remark-gfm and our own parser both reject. The collapse is restricted
 * to blank lines flanked by lines our table grammar recognises as rows or
 * separators (with or without outer pipes) so that ordinary paragraphs
 * containing a stray pipe aren't merged. Fenced code blocks are passed through
 * unchanged so example markdown inside a snippet isn't rewritten.
 */
export function normalizeMarkdownTables(markdown: string): string {
  const lines = markdown.split("\n")
  const out: string[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith("```")) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    if (
      line.trim() === "" &&
      out.length > 0 &&
      isCollapsibleTableLine(out[out.length - 1]) &&
      i + 1 < lines.length &&
      isCollapsibleTableLine(lines[i + 1])
    ) {
      continue
    }
    out.push(line)
  }
  return out.join("\n")
}

function isCollapsibleTableLine(line: string): boolean {
  return isTableRowLine(line) || isTableSeparatorLine(line)
}

function isTableRowLine(line: string | undefined): boolean {
  if (!line) return false
  const trimmed = line.trim()
  if (!trimmed.includes("|")) return false
  if (isTableSeparatorLine(trimmed)) return false
  // Single-column tables ride on the outer pipes (`| col |`) since there
  // are no internal separators. Multi-column rows can drop the outer pipes
  // (`Name | Role`), but in that case we need at least one internal pipe to
  // avoid misclassifying a sentence that happens to contain one.
  const hasOuterPipes = trimmed.startsWith("|") && trimmed.endsWith("|")
  const cells = splitTableRow(trimmed)
  const minCells = hasOuterPipes ? 1 : 2
  return cells.length >= minCells && cells.some((cell) => cell.length > 0)
}

function isTableSeparatorLine(line: string | undefined): boolean {
  if (!line) return false
  const trimmed = line.trim()
  if (!trimmed.startsWith("|") && !trimmed.startsWith("-") && !trimmed.startsWith(":")) return false
  // Strip optional leading/trailing pipes, then verify every column is just
  // dashes (with optional `:` alignment markers and surrounding whitespace).
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "")
  const cells = body.split("|")
  if (cells.length < 1) return false
  return cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell))
}

/**
 * Split a GFM table row into its cells. Handles escaped pipes (`\|`).
 * Leading and trailing pipes are optional.
 */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim()
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "")
  const cells: string[] = []
  let current = ""
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === "\\" && body[i + 1] === "|") {
      current += "|"
      i++
      continue
    }
    if (ch === "|") {
      cells.push(current.trim())
      current = ""
      continue
    }
    current += ch
  }
  cells.push(current.trim())
  return cells
}

/**
 * Parse a GFM table starting at `lines[startIndex]`. The caller is responsible
 * for verifying the header + separator look like a table — we re-check here
 * and bail (returning `null`) if the structure breaks, which lets the
 * surrounding loop fall back to treating the line as a regular paragraph.
 */
function parseTableBlock(
  lines: string[],
  startIndex: number,
  options: ParseOptions
): { node: JSONContent; nextIndex: number } | null {
  const headerLine = lines[startIndex]
  const separatorLine = lines[startIndex + 1]
  if (!isTableRowLine(headerLine) || !isTableSeparatorLine(separatorLine)) {
    return null
  }
  const headerCells = splitTableRow(headerLine)
  const columnCount = headerCells.length
  if (columnCount === 0) return null
  // Reject tables whose separator column count doesn't match the header.
  // GFM treats those as plain paragraphs, and accepting them anyway would
  // bind ragged-shape pasted markdown into broken tables.
  const separatorCells = splitTableRow(separatorLine)
  if (separatorCells.length !== columnCount) return null

  const bodyRows: string[][] = []
  let i = startIndex + 2
  while (i < lines.length && isTableRowLine(lines[i])) {
    const cells = splitTableRow(lines[i])
    // Normalize ragged rows to the header width so the resulting table is
    // rectangular — extra cells are dropped, missing cells become empty.
    while (cells.length < columnCount) cells.push("")
    if (cells.length > columnCount) cells.length = columnCount
    bodyRows.push(cells)
    i++
  }

  const tableRows: JSONContent[] = []
  tableRows.push({
    type: "tableRow",
    content: headerCells.map((cellText) => buildTableCell("tableHeader", cellText, options)),
  })
  for (const row of bodyRows) {
    tableRows.push({
      type: "tableRow",
      content: row.map((cellText) => buildTableCell("tableCell", cellText, options)),
    })
  }

  return {
    node: { type: "table", content: tableRows },
    nextIndex: i,
  }
}

function buildTableCell(type: "tableHeader" | "tableCell", text: string, options: ParseOptions): JSONContent {
  // `<br>` (and the self-closing variants) inside a cell encode a hard line
  // break — the only way GFM tables can express multi-line cell content.
  // Split on these and emit one paragraph per segment so the resulting
  // ProseMirror tree matches what tiptap's table cell schema expects
  // (paragraph block*). User-typed `<br>` is escaped by `serializeTableCell`
  // to `&lt;br&gt;`; restore it after splitting so round-trip is lossless.
  const segments = text.split(/<br\s*\/?>/i)
  const paragraphs: JSONContent[] = segments.map((segment) => {
    const restored = segment.replace(/&lt;br\s*\/?&gt;/gi, "<br>")
    const inline = parseInlineMarkdown(restored, options)
    return inline.length > 0 ? { type: "paragraph", content: inline } : { type: "paragraph" }
  })
  return {
    type,
    attrs: { colspan: 1, rowspan: 1, colwidth: null },
    content: paragraphs.length > 0 ? paragraphs : [{ type: "paragraph" }],
  }
}

function parseInlineMarkdown(text: string, options: ParseOptions = {}): JSONContent[] {
  if (!text) return []

  const result: JSONContent[] = []
  const { getMentionType, getEmoji } = options
  const allowMentions = options.enableMentions ?? true
  const allowChannels = options.enableChannels ?? true
  const allowSlashCommands = options.enableSlashCommands ?? true
  const allowEmoji = options.enableEmoji ?? true
  const emojiAsText = options.emojiAsText ?? false

  // Default lookup for mention types (without context, can't determine "me")
  const lookupMentionType: MentionTypeLookup =
    getMentionType ??
    ((slug): "user" | "persona" | "bot" | "broadcast" | "me" => {
      if (slug === "here" || slug === "channel") return "broadcast"
      return "user"
    })

  // Check for slash command at start of text
  const commandMatch = allowSlashCommands ? text.match(/^(\s*)(\/)([\w-]+)/) : null
  let processText = text
  if (commandMatch) {
    // Preserve leading whitespace
    if (commandMatch[1]) {
      result.push({ type: "text", text: commandMatch[1] })
    }
    result.push({
      type: "slashCommand",
      attrs: { name: commandMatch[3] },
    })
    processText = text.slice(commandMatch[0].length)
  }

  const inlinePattern = new RegExp(INLINE_MARKDOWN_PATTERN, "g")

  let lastIndex = 0
  let match

  while ((match = inlinePattern.exec(processText)) !== null) {
    // Add plain text before this match
    if (match.index > lastIndex) {
      result.push({ type: "text", text: processText.slice(lastIndex, match.index) })
    }

    if (match[1]) {
      // Attachment: [text](attachment:id)
      const displayText = unescapeMarkdownLinkText(match[2])
      const attachmentId = match[3]
      const metadata = parseAttachmentMetadata(match[4])
      const imageMatch = displayText.match(/^Image #(\d+)$/)
      const imageIndex = imageMatch ? parseInt(imageMatch[1], 10) : null
      const isImage = imageIndex !== null
      result.push({
        type: "attachmentReference",
        attrs: {
          id: attachmentId,
          filename: metadata.filename ?? (isImage ? "" : displayText),
          mimeType: metadata.mimeType ?? (isImage ? "image/unknown" : "application/octet-stream"),
          sizeBytes: metadata.sizeBytes,
          status: "uploaded",
          imageIndex,
          error: null,
        },
      })
    } else if (match[5]) {
      // Memo embed: [title](memo:memoId) — inline chip (matched before Link
      // so a memo link isn't swallowed by the generic link branch).
      const title = match[6].replace(/\\([\]\\])/g, "$1")
      const memoId = match[7]
      result.push({ type: "memoEmbed", attrs: { memoId, title } })
    } else if (match[8]) {
      // Link: [text](url)
      const linkText = match[9]
      const linkUrl = match[10]
      // `giphy:` pointer links round-trip back to an inline GIF embed rather
      // than a plain link. Detected here (inside the generic link branch) so no
      // dedicated regex group is needed; the encoded URL never contains a `)`.
      const giphyHref = parseGiphyHref(linkUrl)
      if (giphyHref) {
        const attrs: { giphyUrl: string; title: string; width?: number; height?: number } = {
          giphyUrl: giphyHref.giphyUrl,
          title: linkText,
        }
        if (giphyHref.width && giphyHref.height) {
          attrs.width = giphyHref.width
          attrs.height = giphyHref.height
        }
        result.push({ type: "giphyEmbed", attrs })
        lastIndex = match.index + match[0].length
        continue
      }
      const innerContent = parseInlineMarkdown(linkText, options)
      for (const node of innerContent) {
        result.push({
          ...node,
          marks: [...(node.marks || []), { type: "link", attrs: { href: linkUrl } }],
        })
      }
    } else if (match[11]) {
      // BoldItalic: ***text***
      const boldItalicText = match[12]
      const innerContent = parseInlineMarkdown(boldItalicText, options)
      for (const node of innerContent) {
        result.push({
          ...node,
          marks: [...(node.marks || []), { type: "bold" }, { type: "italic" }],
        })
      }
    } else if (match[13]) {
      // Bold: **text**
      const boldText = match[14]
      const innerContent = parseInlineMarkdown(boldText, options)
      for (const node of innerContent) {
        result.push({
          ...node,
          marks: [...(node.marks || []), { type: "bold" }],
        })
      }
    } else if (match[15]) {
      // Italic: *text*
      const italicText = match[16]
      const innerContent = parseInlineMarkdown(italicText, options)
      for (const node of innerContent) {
        result.push({
          ...node,
          marks: [...(node.marks || []), { type: "italic" }],
        })
      }
    } else if (match[17]) {
      // Strike: ~~text~~
      const strikeText = match[18]
      const innerContent = parseInlineMarkdown(strikeText, options)
      for (const node of innerContent) {
        result.push({
          ...node,
          marks: [...(node.marks || []), { type: "strike" }],
        })
      }
    } else if (match[19]) {
      // Code: `text` (no nesting for code)
      result.push({
        type: "text",
        text: match[20],
        marks: [{ type: "code" }],
      })
    } else if (match[21]) {
      // Mention: @slug
      const slug = match[22]
      if (allowMentions) {
        result.push({
          type: "mention",
          attrs: { id: slug, slug, mentionType: lookupMentionType(slug) },
        })
      } else {
        result.push({ type: "text", text: match[0] })
      }
    } else if (match[23]) {
      // Channel: #slug
      const slug = match[24]
      if (allowChannels) {
        result.push({
          type: "channelLink",
          attrs: { id: slug, slug },
        })
      } else {
        result.push({ type: "text", text: match[0] })
      }
    } else if (match[25]) {
      // Emoji: :shortcode:
      const shortcode = match[26]
      const emoji = allowEmoji ? getEmoji?.(shortcode) : null
      if (allowEmoji && emoji) {
        if (emojiAsText) {
          result.push({ type: "text", text: emoji })
          lastIndex = match.index + match[0].length
          continue
        }

        // Store both `shortcode` (the wire-format id) and `emoji` (the
        // resolved character). The TipTap `EmojiExtension` reads
        // `attrs.emoji` for `renderHTML`, so omitting it would render an
        // empty chip.
        result.push({
          type: "emoji",
          attrs: { shortcode, emoji },
        })
      } else {
        // Unknown shortcode (or emoji parsing disabled) — keep as text
        result.push({ type: "text", text: match[0] })
      }
    }

    lastIndex = match.index + match[0].length
  }

  // Add remaining plain text
  if (lastIndex < processText.length) {
    result.push({ type: "text", text: processText.slice(lastIndex) })
  }

  return result.length ? result : [{ type: "text", text }]
}
