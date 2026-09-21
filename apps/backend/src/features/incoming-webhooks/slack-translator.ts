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

function escapeLinkLabel(label: string): string {
  return label.replace(/([\\[\]])/g, "\\$1")
}

function escapeLinkTarget(target: string): string {
  return target.replace(/([()])/g, "\\$1")
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
  if (target === "") {
    return label ?? ""
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

export type SlackPayloadResult = { markdown: string } | { error: "invalid_payload" | "no_text" }

/** The markdown a Slack-shaped payload carries. `blocks` and `attachments` are ignored. */
export function slackPayloadToMarkdown(payload: unknown): SlackPayloadResult {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return { error: "invalid_payload" }

  const text = (payload as { text?: unknown }).text
  if (text === undefined || text === null) return { error: "no_text" }
  if (typeof text !== "string") return { error: "invalid_payload" }

  const markdown = slackTextToMarkdown(text).trim()
  return markdown.length > 0 ? { markdown } : { error: "no_text" }
}
