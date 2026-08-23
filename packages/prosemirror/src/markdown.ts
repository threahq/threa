/**
 * Bidirectional Markdown ↔ ProseMirror JSON conversion.
 *
 * This module provides consistent conversion between markdown text and
 * ProseMirror JSON format, used by both frontend (TipTap editor) and
 * backend (AI agents, external integrators).
 */

import type { ContentRange, JSONContent, JSONContentMark } from "@threa/types"
import { actorTypeFromMentionId, isResolvedChannelLinkId } from "@threa/types"
import {
  escapeMarkdownLinkText,
  parseAttachmentMetadata,
  serializeAttachmentMetadata,
  unescapeMarkdownLinkText,
} from "./attachment-markdown"
import {
  buildAgentBlockHref,
  buildGiphyHref,
  buildMemoHref,
  buildQuoteHref,
  buildSharedMessageHref,
  parseAgentBlockHref,
  parseGiphyHref,
  parseMentionPointerHref,
  parseQuoteHref,
  parseSharedMessageHref,
  type ReferencePin,
} from "./pointer-urls"

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
 * Resolved mentions/channels also serialize to the pointer form
 * `[@slug](user:usr_x)` / `[#slug](channel:stream_x)` / `[@here](broadcast:here)`
 * (INV-64); those match the generic Link group (8-10) and are routed by scheme in
 * `parseInlineMarkdown` like `giphy:`/`attachment:`, so no dedicated group is
 * needed. The bare `@slug`/`#slug` groups (21-24) remain as lenient input for
 * unresolved or markdown-authored mentions.
 *
 * Exported so both the shared package and the frontend editor can use the same
 * source of truth (use `new RegExp(INLINE_MARKDOWN_PATTERN, "g")`).
 */
export const INLINE_MARKDOWN_PATTERN =
  /(\[((?:\\.|[^\\\]])+)\]\(attachment:([^)\s"]+)(?:\s+"((?:\\"|\\\\|[^"])*)")?\))|(\[((?:\\.|[^\\\]])+)\]\(memo:([\w-]+)\))|(\[([^\]]+)\]\(([^)]+)\))|(\*\*\*(.+?)\*\*\*)|(\*\*(.+?)\*\*)|(?<!\*)(\*([^*]+?)\*)(?!\*)|(\~\~(.+?)\~\~)|(`([^`]+)`)|((?<=\s|^)@([\w-]+))|((?<=\s|^)#([\w-]+))|(:([\w+-]+):)/
    .source

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
      // Bare `>` for empty lines: trailing whitespace is stripped by many
      // markdown tools, which would break the empty-paragraph roundtrip.
      return quoted
        .split("\n")
        .map((line) => (line ? "> " + line : ">"))
        .join("\n")
    }

    case "quoteReply": {
      const { messageId, streamId, authorName, authorId, actorType, snippet, version, range } = node.attrs as {
        messageId: string
        streamId: string
        authorName: string
        authorId: string
        actorType: string
        snippet: string
        version?: number | null
        range?: ContentRange | null
      }
      const quotedLines = snippet
        .split("\n")
        .map((line) => "> " + line)
        .join("\n")
      // Escape ] and \ in author name to prevent breaking the markdown link syntax
      const escapedAuthor = authorName.replace(/\\/g, "\\\\").replace(/\]/g, "\\]")
      // Blank `>` line forces a paragraph break so react-markdown creates separate
      // <p> elements for the snippet and attribution (needed for display extraction).
      const href = buildQuoteHref({ streamId, messageId, authorId, actorType, version, range })
      return `${quotedLines}\n>\n> — [${escapedAuthor}](${href})`
    }

    case "agentBlock": {
      const { authorId, authorName } = node.attrs as { authorId: string; authorName: string }
      const escapedAuthor = authorName.replace(/\\/g, "\\\\").replace(/\]/g, "\\]")
      const href = buildAgentBlockHref({ authorId })
      // Attribution leads (the quoteReply block puts it last), so the two
      // blockquote-shaped nodes stay unambiguous on parse and the body below
      // it is ordinary markdown — lists and code blocks included.
      const body = serializeToMarkdown({ type: "doc", content: node.content ?? [] })
      const lines = [`— [${escapedAuthor}](${href})`, "", ...body.split("\n")]
      return lines.map((line) => (line ? "> " + line : ">")).join("\n")
    }

    case "sharedMessage": {
      const { messageId, streamId, authorName, conversationId, version, range } = node.attrs as {
        messageId: string
        streamId: string
        authorName?: string
        conversationId?: string
        version?: number | null
        range?: ContentRange | null
      }
      // Wire-format serialization only — the frontend hydrates live content
      // on render, so this fallback is what external API consumers see and
      // what sidebar/activity previews strip through INV-60 helpers. We use
      // markdown link syntax (not bare parens) so `stripMarkdown` reduces
      // the line to a clean sentence: "Shared a message from Alice".
      const rawName = authorName && authorName.length > 0 ? authorName : "another stream"
      const escapedName = rawName.replace(/\\/g, "\\\\").replace(/\]/g, "\\]")
      return `Shared a message from [${escapedName}](${buildSharedMessageHref({ streamId, messageId, conversationId, version, range })})`
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
 * Wire scheme for a resolved mention id: `user:`/`persona:`/`bot:` prefix for
 * actor ids, or the broadcast sentinel verbatim (`broadcast:here`). null for an
 * unresolved (bare-slug) id, which the caller serializes as `@slug` instead.
 */
function mentionPointerUrl(id: string): string | null {
  const actorType = actorTypeFromMentionId(id)
  if (actorType === "broadcast") return id
  if (actorType === "user" || actorType === "persona" || actorType === "bot") return `${actorType}:${id}`
  return null
}

function getNodeText(node: JSONContent): string {
  if (node.type === "hardBreak") return "\n"
  if (node.type === "mention") {
    const slug = node.attrs?.slug as string
    if (!slug) return ""
    const id = node.attrs?.id
    // Encode the resolved actor id on the wire so markdown round-trips
    // losslessly (INV-64), mirroring attachment/memo pointer links. An
    // unresolved id (a bare slug from a not-yet-resolved markdown mention)
    // has no scheme, so it falls back to `@slug`.
    const url = typeof id === "string" ? mentionPointerUrl(id) : null
    return url ? `[@${escapeMarkdownLinkText(slug)}](${url})` : `@${slug}`
  }
  if (node.type === "channelLink") {
    const slug = node.attrs?.slug as string
    if (!slug) return ""
    const id = node.attrs?.id
    return typeof id === "string" && isResolvedChannelLinkId(id)
      ? `[#${escapeMarkdownLinkText(slug)}](channel:${id})`
      : `#${slug}`
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
  if (node.type === "inAppLink") {
    const url = node.attrs?.url as string
    if (!url) return ""
    // Wire-format stays a normal markdown link so external/API consumers get a
    // real navigable URL and the timeline re-derives the chip from the link
    // alone. The cached name is the label; fall back to the URL when absent.
    const name = node.attrs?.name as string | undefined
    const rawLabel = name && name.length > 0 ? name : url
    return `[${escapeMarkdownLinkText(rawLabel)}](${url})`
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

function isAtomNode(node: JSONContent): boolean {
  return (
    node.type === "mention" ||
    node.type === "channelLink" ||
    node.type === "slashCommand" ||
    node.type === "command" ||
    node.type === "attachmentReference" ||
    node.type === "emoji" ||
    node.type === "memoEmbed" ||
    node.type === "inAppLink" ||
    node.type === "giphyEmbed"
  )
}

function getEffectiveMarks(nodes: JSONContent[], index: number): JSONContentMark[] {
  const node = nodes[index]

  if (node.type === "text") {
    return node.marks ?? []
  }

  // Atom nodes inherit marks from adjacent text nodes.
  if (isAtomNode(node)) {
    // Prefer the next text node (the "@here hello" case).
    for (let i = index + 1; i < nodes.length; i++) {
      if (nodes[i].type === "text" && nodes[i].marks?.length) {
        return nodes[i].marks!
      }
      if (!isAtomNode(nodes[i])) break
    }
    for (let i = index - 1; i >= 0; i--) {
      if (nodes[i].type === "text" && nodes[i].marks?.length) {
        return nodes[i].marks!
      }
      if (!isAtomNode(nodes[i])) break
    }
  }

  return []
}

function marksEqual(a: JSONContentMark[], b: JSONContentMark[]): boolean {
  if (a.length !== b.length) return false
  const aTypes = a.map((m) => m.type).sort()
  const bTypes = b.map((m) => m.type).sort()
  return aTypes.every((t, i) => t === bTypes[i])
}

/** Preserves leading/trailing whitespace outside the marks. */
function wrapWithMarks(text: string, marks: JSONContentMark[]): string {
  if (marks.length === 0) return text

  const leadingMatch = text.match(/^(\s*)/)
  const trailingMatch = text.match(/(\s*)$/)
  const leading = leadingMatch?.[1] ?? ""
  const trailing = trailingMatch?.[1] ?? ""
  const trimmed = text.slice(leading.length, text.length - trailing.length)

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

  // Group consecutive nodes with the same effective marks.
  const groups: Array<{ text: string; marks: JSONContentMark[] }> = []

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const text = getNodeText(node)
    if (!text) continue

    const marks = getEffectiveMarks(nodes, i)

    if (groups.length > 0 && marksEqual(groups[groups.length - 1].marks, marks)) {
      groups[groups.length - 1].text += text
    } else {
      groups.push({ text, marks })
    }
  }

  return groups.map((group) => wrapWithMarks(group.text, group.marks)).join("")
}

/** "me" is a special type for the current user's own mentions. */
export type MentionTypeLookup = (slug: string) => "user" | "persona" | "bot" | "broadcast" | "me"

/** Returns null if shortcode is not a valid emoji. */
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
   * Only materialize a `slashCommand` node when the name is an actual command.
   * Supplied by composer surfaces (the editor's known command set) so a pasted
   * `/User` isn't claimed as a command. Absent → any well-formed `/cmd` is
   * accepted, matching the prior behavior for backend ingestion and tests.
   */
  isKnownCommand?: (name: string) => boolean
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
  balancedLinkHrefs?: Map<string, string>
}

const LIST_LINE_PATTERN = /^(\s*)([-*]|\d+\.)\s(.*)$/

interface ListLine {
  indent: number
  ordered: boolean
  text: string
}

/**
 * Build one list node starting at `startIndex`, consuming every line indented
 * at least `baseIndent`. A line indented deeper than the current level becomes
 * a nested list inside the preceding item; a marker-type switch at the same
 * level ends the list so bullet and ordered runs stay separate nodes.
 */
function buildListNode(
  listLines: ListLine[],
  startIndex: number,
  baseIndent: number,
  options: ParseOptions
): { node: JSONContent; nextIndex: number } {
  const ordered = listLines[startIndex].ordered
  const items: JSONContent[] = []
  let i = startIndex

  while (i < listLines.length && listLines[i].indent >= baseIndent) {
    const listLine = listLines[i]

    if (listLine.indent > baseIndent) {
      const nested = buildListNode(listLines, i, listLine.indent, options)
      const lastItem = items[items.length - 1]
      if (lastItem) {
        lastItem.content = [...(lastItem.content ?? []), nested.node]
      } else {
        items.push({ type: "listItem", content: [{ type: "paragraph" }, nested.node] })
      }
      i = nested.nextIndex
      continue
    }

    if (listLine.ordered !== ordered) break

    items.push({
      type: "listItem",
      content: [{ type: "paragraph", content: parseInlineMarkdown(listLine.text, options) }],
    })
    i++
  }

  return {
    node: { type: ordered ? "orderedList" : "bulletList", content: items },
    nextIndex: i,
  }
}

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

      // Agent block: attribution on the FIRST line, body below it.
      const agentMatch = quoteLines[0]?.match(/^—\s*\[((?:\\.|[^\]])+)\]\((agent:[\w-]+)\)$/)
      const agentHref = agentMatch ? parseAgentBlockHref(agentMatch[2]) : null
      if (agentMatch && agentHref) {
        const bodyLines = quoteLines.slice(1)
        while (bodyLines.length > 0 && bodyLines[0] === "") bodyLines.shift()
        const body = parseMarkdown(bodyLines.join("\n"), options.getMentionType, options.getEmoji, options)
        content.push({
          type: "agentBlock",
          attrs: {
            authorId: agentHref.authorId,
            authorName: agentMatch[1].replace(/\\([\]\\])/g, "$1"),
          },
          content: body.content ?? [{ type: "paragraph" }],
        })
        continue
      }

      // Check if last line is a quote-reply attribution: — [Author](quote:streamId/messageId/authorId/actorType[?v=n&r=from-to])
      // Author name may contain escaped brackets: \] and \\
      // The href itself is decoded by `parseQuoteHref`, which owns the optional
      // segments and the pin suffix; an href it rejects falls back to a plain
      // blockquote.
      const lastLine = quoteLines[quoteLines.length - 1]
      const quoteReplyMatch = lastLine?.match(/^—\s*\[((?:\\.|[^\]])+)\]\((quote:[\w\-/]+(?:\?[\w=&-]+)?)\)$/)
      const quoteHref = quoteReplyMatch ? parseQuoteHref(quoteReplyMatch[2]) : null

      if (quoteReplyMatch && quoteHref) {
        // Unescape \] and \\ in author name
        const authorName = quoteReplyMatch[1].replace(/\\([\]\\])/g, "$1")
        // Strip the attribution line and any blank separator line before it
        const snippetLines = quoteLines.slice(0, -1)
        while (snippetLines.length > 0 && snippetLines[snippetLines.length - 1] === "") {
          snippetLines.pop()
        }
        const snippet = snippetLines.join("\n")
        content.push({
          type: "quoteReply",
          attrs: {
            messageId: quoteHref.messageId,
            streamId: quoteHref.streamId,
            authorName,
            authorId: quoteHref.authorId,
            actorType: quoteHref.actorType,
            snippet,
            ...referencePinAttrs(quoteHref),
          },
        })
      } else {
        // One paragraph per quoted line — the inverse of the serializer, which
        // emits each blockquote paragraph as its own `> ` line, including a
        // bare `>` for an empty paragraph, so blank lines stay as paragraphs.
        const quoteParagraphs = quoteLines.map((quoteLine): JSONContent => {
          const inlineContent = parseInlineMarkdown(quoteLine, options)
          return inlineContent.length > 0 ? { type: "paragraph", content: inlineContent } : { type: "paragraph" }
        })
        content.push({
          type: "blockquote",
          content: quoteParagraphs.length > 0 ? quoteParagraphs : [{ type: "paragraph" }],
        })
      }
      continue
    }

    // Bullet / ordered list, including nested items indented under a parent
    // item (the serializer emits two spaces per nesting level).
    if (LIST_LINE_PATTERN.test(line)) {
      const listLines: ListLine[] = []
      while (i < lines.length) {
        const match = lines[i].match(LIST_LINE_PATTERN)
        if (!match) break
        listLines.push({
          indent: match[1].length,
          ordered: match[2] !== "-" && match[2] !== "*",
          text: match[3],
        })
        i++
      }

      let itemIndex = 0
      while (itemIndex < listLines.length) {
        const built = buildListNode(listLines, itemIndex, listLines[itemIndex].indent, options)
        content.push(built.node)
        itemIndex = built.nextIndex
      }
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
          ...(sharedMessageMatch.conversationId && { conversationId: sharedMessageMatch.conversationId }),
          authorId: "",
          actorType: "user",
          ...referencePinAttrs(sharedMessageMatch),
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
 *   `Shared a message from [Author](shared-message:streamId/messageId[/conversationId])`
 *
 * Returns the parsed metadata or `null` when the line is anything else. The
 * optional trailing `/conversationId` segment round-trips a conversation-origin
 * pointer; a two-segment (legacy / in-stream) link parses with it undefined.
 * Author names containing `]` are escaped as `\]` per the serializer.
 */
function parseSharedMessageLine(
  line: string
): ({ authorName: string; streamId: string; messageId: string; conversationId?: string } & ReferencePin) | null {
  const match = line.match(
    /^Shared a message from \[((?:\\.|[^\]])+)\]\((shared-message:[\w\-/]+(?:\?[\w=&-]+)?)\)\s*$/
  )
  if (!match) return null
  const href = parseSharedMessageHref(match[2])
  if (!href) return null
  const authorName = match[1].replace(/\\([\]\\])/g, "$1")
  return { authorName, ...href }
}

/**
 * Spread the pin onto node attrs only when the href carried one: an unpinned
 * legacy link must round-trip to exactly the attrs it parsed from before.
 */
function referencePinAttrs(pin: ReferencePin): ReferencePin {
  return {
    ...(pin.version != null && { version: pin.version }),
    ...(pin.range != null && { range: pin.range }),
  }
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

/**
 * Parse an actor/channel pointer link — `[@slug](user:usr_x)`,
 * `[@here](broadcast:here)`, `[#slug](channel:stream_x)` — into its node, or
 * null when the url isn't one of these reserved schemes (so the caller falls
 * back to a normal link). The id rides on the wire (INV-64), so no DB lookup is
 * needed here; `parseMentionPointerHref` is the shared decoder the react-markdown
 * renderer uses too. Gated by the same enableMentions/enableChannels options as
 * the bare `@slug`/`#slug` forms.
 */
function parseActorPointer(
  url: string,
  label: string,
  allowMentions: boolean,
  allowChannels: boolean
): JSONContent | null {
  const pointer = parseMentionPointerHref(url)
  if (!pointer) return null
  // An all-sigil label (`[@](user:usr_x)`) strips to an empty slug; reject it
  // so an empty-slug node — which serializes to nothing — never persists.
  if (pointer.kind === "channel") {
    const slug = stripMentionSigil(label, "#")
    return allowChannels && slug ? { type: "channelLink", attrs: { id: pointer.id, slug } } : null
  }
  const slug = stripMentionSigil(label, "@")
  return allowMentions && slug
    ? { type: "mention", attrs: { id: pointer.id, slug, mentionType: pointer.mentionType } }
    : null
}

function stripMentionSigil(label: string, sigil: string): string {
  const text = unescapeMarkdownLinkText(label)
  return text.startsWith(sigil) ? text.slice(sigil.length) : text
}

function tokenizeBalancedLinkDestinations(
  text: string,
  hrefByToken: Map<string, string>
): {
  text: string
  hrefByToken: Map<string, string>
} {
  const linkStart = /\[([^\]]+)\]\(/g
  const replacements: Array<{ start: number; end: number; label: string; href: string; token: string }> = []
  const reservedTokens = new Set(hrefByToken.keys())
  let match: RegExpExecArray | null

  while ((match = linkStart.exec(text)) !== null) {
    const hrefStart = match.index + match[0].length
    let depth = 0
    let hrefEnd = -1

    for (let i = hrefStart; i < text.length; i++) {
      if (text[i] === "(") {
        depth++
      } else if (text[i] === ")") {
        if (depth === 0) {
          hrefEnd = i
          break
        }
        depth--
      }
    }

    if (hrefEnd === -1) break
    const href = text.slice(hrefStart, hrefEnd)
    if (href.startsWith("attachment:") || href.startsWith("memo:") || hrefByToken.has(href)) {
      linkStart.lastIndex = hrefEnd + 1
      continue
    }

    let tokenIndex = hrefByToken.size + replacements.length
    let token = `\uE000${tokenIndex}\uE001`
    while (text.includes(token) || reservedTokens.has(token)) {
      tokenIndex++
      token = `\uE000${tokenIndex}\uE001`
    }
    reservedTokens.add(token)
    replacements.push({
      start: match.index,
      end: hrefEnd + 1,
      label: match[1],
      href,
      token,
    })
    linkStart.lastIndex = hrefEnd + 1
  }

  if (replacements.length === 0) return { text, hrefByToken }

  let cursor = 0
  let tokenized = ""
  for (const replacement of replacements) {
    tokenized += text.slice(cursor, replacement.start)
    tokenized += `[${replacement.label}](${replacement.token})`
    hrefByToken.set(replacement.token, replacement.href)
    cursor = replacement.end
  }
  tokenized += text.slice(cursor)

  return { text: tokenized, hrefByToken }
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

  // Two gates before a leading `/word` becomes a command node:
  //  1. the `(?=\s|$)` boundary keeps the name a whole token, so a pasted
  //     filepath like `/User/kristofferremback/dev` isn't claimed as `/User`;
  //  2. `isKnownCommand` (when supplied) rejects a lone `/User` that clears the
  //     boundary but isn't a registered command. Absent the predicate, any
  //     well-formed `/cmd` is accepted (backend ingestion, tests).
  const commandMatch = allowSlashCommands ? text.match(/^(\s*)(\/)([\w-]+)(?=\s|$)/) : null
  const commandIsKnown = commandMatch ? (options.isKnownCommand?.(commandMatch[3]) ?? true) : false
  let processText = text
  if (commandMatch && commandIsKnown) {
    if (commandMatch[1]) {
      result.push({ type: "text", text: commandMatch[1] })
    }
    result.push({
      type: "slashCommand",
      attrs: { name: commandMatch[3] },
    })
    processText = text.slice(commandMatch[0].length)
  }

  const tokenizedLinks = tokenizeBalancedLinkDestinations(processText, options.balancedLinkHrefs ?? new Map())
  processText = tokenizedLinks.text
  options = { ...options, balancedLinkHrefs: tokenizedLinks.hrefByToken }
  const inlinePattern = new RegExp(INLINE_MARKDOWN_PATTERN, "g")

  let lastIndex = 0
  let match

  while ((match = inlinePattern.exec(processText)) !== null) {
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
      const linkUrl = tokenizedLinks.hrefByToken.get(match[10]) ?? match[10]
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
      // `user:`/`persona:`/`bot:`/`broadcast:`/`channel:` pointer links round-trip
      // back to a mention/channelLink node (INV-64), detected here like `giphy:`
      // so no dedicated regex group is needed.
      const actorNode = parseActorPointer(linkUrl, linkText, allowMentions, allowChannels)
      if (actorNode) {
        result.push(actorNode)
        lastIndex = match.index + match[0].length
        continue
      }
      // Link text is a display label: `[#1358](https://github…/pull/1358)` is a
      // titled external link, not a channel reference — materializing a
      // mention/channelLink node here would bury the href in a mark that
      // consumers of the node tree (collectLinkUrls, the resolver) don't treat
      // as the link it is. Pointer forms (`user:`/`channel:`) were handled above.
      const innerContent = parseInlineMarkdown(linkText, {
        ...options,
        enableMentions: false,
        enableChannels: false,
      })
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

  if (lastIndex < processText.length) {
    result.push({ type: "text", text: processText.slice(lastIndex) })
  }

  return result.length ? result : [{ type: "text", text }]
}
