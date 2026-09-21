/**
 * Slack `mrkdwn` to our markdown. Syntax only — every rule keys off a delimiter or an
 * angle-bracket control sequence, never off the words between them (INV-54).
 *
 * Code spans, fenced blocks and control sequences are rendered once and then held out of the
 * emphasis pass behind a sentinel, so a `_` inside a URL and a `*` inside a link label survive
 * while emphasis spanning a link still works.
 */
const PROTECTED = /(```[\s\S]*?```|`[^`\n]*`|<[^<>]*>)/g
const SENTINEL = /\u0000(\d+)\u0000/g

const BOLD = /(?<![\w*])\*(?=\S)([^*\n]*?)(?<=\S)\*(?![\w*])/g
const ITALIC = /(?<![\w_])_(?=\S)([^_\n]*?)(?<=\S)_(?![\w_])/g
const STRIKE = /(?<![\w~])~(?=\S)([^~\n]*?)(?<=\S)~(?![\w~])/g

const BROADCASTS: Record<string, string> = {
  here: "@here",
  channel: "@channel",
  everyone: "@everyone",
}

function unescapeEntities(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
}

const WEB_TARGET = /^(?:https?:\/\/|mailto:)/i

function escapeLinkLabel(label: string): string {
  return label.replace(/\s+/g, " ").replace(/([\\[\]])/g, "\\$1")
}

function escapeLinkTarget(target: string): string {
  return target.replace(/([()])/g, "\\$1").replace(/\s/g, encodeURIComponent)
}

function translateControlSequence(inner: string): string {
  const pipe = inner.indexOf("|")
  const target = unescapeEntities(pipe === -1 ? inner : inner.slice(0, pipe))
  const label = pipe === -1 ? null : unescapeEntities(inner.slice(pipe + 1))

  if (target.startsWith("!")) {
    return BROADCASTS[target.slice(1)] ?? label ?? target.slice(1)
  }
  if (target.startsWith("@")) {
    return label ? `@${label}` : target
  }
  if (target.startsWith("#")) {
    return label ? `#${label}` : target
  }
  // Any other scheme would reach the markdown parser as one of Threa's own pointer links.
  if (!WEB_TARGET.test(target)) {
    return label ?? target
  }
  return label ? `[${escapeLinkLabel(label)}](${escapeLinkTarget(target)})` : target
}

function applyEmphasis(text: string): string {
  return text.replace(BOLD, "**$1**").replace(ITALIC, "*$1*").replace(STRIKE, "~~$1~~")
}

export function slackTextToMarkdown(text: string): string {
  const rendered: string[] = []
  const masked = text.replace(/\u0000/g, "").replace(PROTECTED, (match) => {
    rendered.push(match.startsWith("<") ? translateControlSequence(match.slice(1, -1)) : unescapeEntities(match))
    return `\u0000${rendered.length - 1}\u0000`
  })
  return unescapeEntities(applyEmphasis(masked)).replace(
    SENTINEL,
    (_match, index: string) => rendered[Number(index)] ?? ""
  )
}

type SlackObject = Record<string, unknown>

function asRecord(value: unknown): SlackObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as SlackObject) : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

function joinParts(parts: Array<string | null>, separator: string): string | null {
  const kept = parts.filter((part): part is string => part !== null && part.length > 0)
  return kept.length > 0 ? kept.join(separator) : null
}

function mrkdwn(value: unknown): string | null {
  const text = asString(value)
  if (text === null) return null
  const rendered = slackTextToMarkdown(text).trim()
  return rendered.length > 0 ? rendered : null
}

function plain(value: unknown): string | null {
  const text = asString(value)
  if (text === null) return null
  const rendered = unescapeEntities(text).trim()
  return rendered.length > 0 ? rendered : null
}

function link(label: string | null, target: string | null): string | null {
  if (target === null) return label
  if (label === null) return target
  return `[${escapeLinkLabel(label)}](${escapeLinkTarget(target)})`
}

function renderTextObject(value: unknown): string | null {
  const object = asRecord(value)
  if (object === null) return plain(value)
  return object.type === "mrkdwn" ? mrkdwn(object.text) : plain(object.text)
}

function renderInlineElement(value: unknown): string | null {
  const element = asRecord(value)
  if (element === null) return null

  switch (element.type) {
    case "text": {
      const text = typeof element.text === "string" ? element.text : ""
      if (text.length === 0) return null
      const style = asRecord(element.style) ?? {}
      let rendered = text
      if (style.code === true) rendered = `\`${rendered}\``
      if (style.strike === true) rendered = `~~${rendered}~~`
      if (style.italic === true) rendered = `*${rendered}*`
      if (style.bold === true) rendered = `**${rendered}**`
      return rendered
    }
    case "link":
      return link(asString(element.text), asString(element.url))
    case "emoji": {
      const name = asString(element.name)
      return name === null ? null : `:${name}:`
    }
    case "user": {
      const id = asString(element.user_id)
      return id === null ? null : `@${id}`
    }
    case "channel": {
      const id = asString(element.channel_id)
      return id === null ? null : `#${id}`
    }
    case "broadcast": {
      const range = asString(element.range)
      return range === null ? null : (BROADCASTS[range] ?? range)
    }
    default:
      return null
  }
}

function renderInlineElements(element: SlackObject): string | null {
  const rendered = asArray(element.elements)
    .map(renderInlineElement)
    .filter((part): part is string => part !== null)
    .join("")
  return rendered.length > 0 ? rendered : null
}

// Wide enough to nest under both "- " and "1. " markers.
const LIST_INDENT_WIDTH = 4

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0
}

function renderRichTextElement(value: unknown): string | null {
  const element = asRecord(value)
  if (element === null) return null

  switch (element.type) {
    case "rich_text_section":
      return renderInlineElements(element)
    case "rich_text_list": {
      const ordered = element.style === "ordered"
      const pad = " ".repeat(LIST_INDENT_WIDTH * nonNegativeInt(element.indent))
      const first = nonNegativeInt(element.offset) + 1
      const lines: string[] = []
      for (const item of asArray(element.elements)) {
        const section = asRecord(item)
        const rendered = section === null ? null : renderInlineElements(section)
        if (rendered !== null) lines.push(`${pad}${ordered ? `${first + lines.length}. ` : "- "}${rendered}`)
      }
      return joinParts(lines, "\n")
    }
    case "rich_text_preformatted": {
      const body = renderInlineElements(element)
      return body === null ? null : `\`\`\`\n${body}\n\`\`\``
    }
    case "rich_text_quote": {
      const body = renderInlineElements(element)
      return body === null
        ? null
        : body
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n")
    }
    default:
      return null
  }
}

function renderBlock(value: unknown): string | null {
  const block = asRecord(value)
  if (block === null) return null

  switch (block.type) {
    case "header": {
      const heading = renderTextObject(block.text)
      return heading === null ? null : `**${heading}**`
    }
    case "section":
      return joinParts(
        [renderTextObject(block.text), joinParts(asArray(block.fields).map(renderTextObject), "\n")],
        "\n"
      )
    case "context":
      return joinParts(
        asArray(block.elements).map((element) =>
          asRecord(element)?.type === "image" ? null : renderTextObject(element)
        ),
        " "
      )
    case "divider":
      return "---"
    case "image": {
      const url = asString(block.image_url)
      return url === null ? null : link(plain(block.alt_text) ?? renderTextObject(block.title), url)
    }
    case "actions":
      return joinParts(
        asArray(block.elements).map((candidate) => {
          const element = asRecord(candidate)
          const url = element === null ? null : asString(element.url)
          return url === null || element === null ? null : link(renderTextObject(element.text), url)
        }),
        " · "
      )
    case "rich_text":
      return joinParts(asArray(block.elements).map(renderRichTextElement), "\n")
    default:
      return null
  }
}

function renderBlocks(value: unknown): string | null {
  return joinParts(asArray(value).map(renderBlock), "\n\n")
}

function renderField(value: unknown): string | null {
  const field = asRecord(value)
  if (field === null) return null
  const title = plain(field.title)
  return joinParts([title === null ? null : `**${title}:**`, mrkdwn(field.value)], " ")
}

function renderAttachment(value: unknown): string | null {
  const attachment = asRecord(value)
  if (attachment === null) return null

  const title = plain(attachment.title)
  const rendered = joinParts(
    [
      mrkdwn(attachment.pretext),
      link(plain(attachment.author_name), asString(attachment.author_link)),
      title === null ? null : `**${link(title, asString(attachment.title_link))}**`,
      mrkdwn(attachment.text),
      joinParts(asArray(attachment.fields).map(renderField), "\n"),
      renderBlocks(attachment.blocks),
      asString(attachment.image_url),
      mrkdwn(attachment.footer),
    ],
    "\n"
  )
  return rendered ?? mrkdwn(attachment.fallback)
}

export type SlackPayloadResult = { markdown: string } | { error: "invalid_payload" | "no_text" }

/**
 * The markdown a Slack-shaped payload carries: top-level `text`, top-level `blocks`, then each
 * attachment, joined by a blank line. Rendered top-level blocks suppress `text`, which Slack
 * treats as the notification fallback for them.
 */
export function slackPayloadToMarkdown(payload: unknown): SlackPayloadResult {
  const body = asRecord(payload)
  if (body === null) return { error: "invalid_payload" }

  const text = body.text
  if (text !== undefined && text !== null && typeof text !== "string") return { error: "invalid_payload" }

  const blocks = renderBlocks(body.blocks)
  const markdown = joinParts([blocks ?? mrkdwn(text), ...asArray(body.attachments).map(renderAttachment)], "\n\n")
  return markdown === null ? { error: "no_text" } : { markdown }
}
