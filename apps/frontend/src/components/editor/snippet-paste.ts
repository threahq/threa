/**
 * Heuristics for deciding when a pasted blob is "too large to reasonably live
 * inside a message" and should become a snippet attachment instead of inline
 * text, plus conservative format sniffing so the attachment gets a meaningful
 * extension/mime rather than always `.txt`. Kept as a pure module (no React) so
 * the rich-editor paste handler, the dialog, and the unit tests share one
 * source of truth (INV-33).
 */

/** A paste this long (characters) converts to a snippet, regardless of shape. */
export const SNIPPET_PASTE_CHAR_THRESHOLD = 1500

/** ...or a paste with at least this many lines, whichever trips first. */
export const SNIPPET_PASTE_LINE_THRESHOLD = 12

/**
 * True when a pasted plain-text blob should open the snippet editor rather than
 * being inserted inline. Either a long single blob (char count) or a tall one
 * (line count) qualifies, so both a 2000-char paragraph and a 20-line script
 * are caught.
 */
export function shouldConvertPasteToSnippet(text: string): boolean {
  if (!text) return false
  if (text.length >= SNIPPET_PASTE_CHAR_THRESHOLD) return true
  // `\n` is present in both LF and CRLF, so counting it covers either newline
  // style; a lone trailing `\r` (classic Mac) is rare enough to ignore.
  const lineCount = (text.match(/\n/g)?.length ?? 0) + 1
  return lineCount >= SNIPPET_PASTE_LINE_THRESHOLD
}

export type SnippetFormatKey = "text" | "json" | "xml" | "html" | "csv" | "markdown" | "yaml"

export interface SnippetFormat {
  key: SnippetFormatKey
  /** Filename extension without the dot, e.g. `json`. */
  extension: string
  /** Mime aligned with `categoryFromMime` so non-E2E uploads bucket correctly. */
  mimeType: string
  /** Short human label for the dialog badge. */
  label: string
}

const SNIPPET_FORMATS: Record<SnippetFormatKey, SnippetFormat> = {
  text: { key: "text", extension: "txt", mimeType: "text/plain", label: "Plain text" },
  json: { key: "json", extension: "json", mimeType: "application/json", label: "JSON" },
  xml: { key: "xml", extension: "xml", mimeType: "application/xml", label: "XML" },
  html: { key: "html", extension: "html", mimeType: "text/html", label: "HTML" },
  csv: { key: "csv", extension: "csv", mimeType: "text/csv", label: "CSV" },
  markdown: { key: "markdown", extension: "md", mimeType: "text/markdown", label: "Markdown" },
  yaml: { key: "yaml", extension: "yaml", mimeType: "application/x-yaml", label: "YAML" },
}

const EXTENSION_TO_FORMAT: Record<string, SnippetFormat> = {
  txt: SNIPPET_FORMATS.text,
  json: SNIPPET_FORMATS.json,
  xml: SNIPPET_FORMATS.xml,
  html: SNIPPET_FORMATS.html,
  htm: SNIPPET_FORMATS.html,
  csv: SNIPPET_FORMATS.csv,
  md: SNIPPET_FORMATS.markdown,
  markdown: SNIPPET_FORMATS.markdown,
  yaml: SNIPPET_FORMATS.yaml,
  yml: SNIPPET_FORMATS.yaml,
}

function extensionOf(filename: string): string {
  const base = filename.trim().toLowerCase()
  const dot = base.lastIndexOf(".")
  // A leading dot (dotfile) or trailing dot carries no usable extension.
  if (dot <= 0 || dot === base.length - 1) return ""
  return base.slice(dot + 1)
}

/**
 * Resolve the snippet format from a filename's extension. The (possibly
 * renamed) filename is the single source of truth for both the dialog badge and
 * the attachment's mime, so a user rename to `.csv` is honoured over whatever
 * was originally sniffed. Unknown extensions fall back to plain text.
 */
export function snippetFormatForFilename(filename: string): SnippetFormat {
  return EXTENSION_TO_FORMAT[extensionOf(filename)] ?? SNIPPET_FORMATS.text
}

/** Mime type for the attachment, derived from the final filename's extension. */
export function snippetMimeForFilename(filename: string): string {
  return snippetFormatForFilename(filename).mimeType
}

/** Default filename for the Nth snippet pasted into a given editor session. */
export function defaultSnippetFilename(index: number, extension: string = SNIPPET_FORMATS.text.extension): string {
  return `snippet-${index}.${extension}`
}

/** Filename used when the snippet's name field is left blank on save. */
export const SNIPPET_FALLBACK_FILENAME = "snippet.txt"

/**
 * Best-effort structural format sniff for a pasted blob. Deliberately
 * conservative: every detector demands a hard structural signal and anything
 * ambiguous falls through to plain text — a wrong rename is worse than a `.txt`
 * (the chosen posture). Detection is structural only (JSON parse, markup tags,
 * delimiter consistency, markdown/yaml shape); it never guesses a programming
 * language from keywords, which would be the English-only semantic heuristic
 * INV-54 forbids. Order runs most-definitive first.
 */
export function detectSnippetFormat(text: string): SnippetFormat {
  const trimmed = text.trim()
  if (!trimmed) return SNIPPET_FORMATS.text
  if (looksLikeJson(trimmed)) return SNIPPET_FORMATS.json
  const markup = detectMarkup(trimmed)
  if (markup) return markup
  if (looksLikeCsv(text)) return SNIPPET_FORMATS.csv
  if (looksLikeMarkdown(text)) return SNIPPET_FORMATS.markdown
  if (looksLikeYaml(text)) return SNIPPET_FORMATS.yaml
  return SNIPPET_FORMATS.text
}

function looksLikeJson(trimmed: string): boolean {
  const first = trimmed[0]
  if (first !== "{" && first !== "[") return false
  try {
    const parsed = JSON.parse(trimmed)
    return typeof parsed === "object" && parsed !== null
  } catch {
    return false
  }
}

function detectMarkup(trimmed: string): SnippetFormat | null {
  if (trimmed[0] !== "<") return null
  const head = trimmed.slice(0, 100).toLowerCase()
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return SNIPPET_FORMATS.html
  if (head.startsWith("<?xml")) return SNIPPET_FORMATS.xml
  // Generic markup: opens with a real tag that also has a matching close tag.
  const open = trimmed.match(/^<([a-zA-Z][\w:-]*)(?:\s[^>]*)?>/)
  if (open) {
    const tag = open[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (new RegExp(`</${tag}\\s*>`).test(trimmed)) return SNIPPET_FORMATS.xml
  }
  return null
}

function looksLikeCsv(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length < 2) return false
  // A real CSV has the same number of a single delimiter on every row; prose
  // with stray commas won't hold a constant count across many lines.
  for (const delimiter of [",", "\t", ";"]) {
    const counts = lines.map((line) => line.split(delimiter).length - 1)
    if (counts[0] >= 1 && counts.every((count) => count === counts[0])) return true
  }
  return false
}

function looksLikeMarkdown(text: string): boolean {
  const lines = text.split(/\r?\n/)
  let hasHeading = false
  let hasFence = false
  let hasList = false
  for (const line of lines) {
    if (/^#{1,6}\s+\S/.test(line)) hasHeading = true
    else if (/^\s*(```|~~~)/.test(line)) hasFence = true
    else if (/^\s*([-*+]\s+\S|\d+\.\s+\S)/.test(line)) hasList = true
  }
  // Require two distinct structural signals: a single `#` comment or one dash in
  // otherwise-plain text shouldn't tip a paste into `.md`.
  return Number(hasHeading) + Number(hasFence) + Number(hasList) >= 2
}

function looksLikeYaml(text: string): boolean {
  const lines = text.split(/\r?\n/)
  const content = lines.filter((line) => line.trim() && !line.trim().startsWith("#"))
  if (content.length < 2) return false
  const keyLike = content.filter((line) => /^[ \t]*[\w.-]+:(\s|$)/.test(line) || /^[ \t]*-\s+\S/.test(line))
  // A `---` document marker is a hard YAML signal; without one, demand that the
  // blob is overwhelmingly `key:`/list lines so prose can't slip through.
  if (lines.some((line) => line.trim() === "---")) return keyLike.length >= 1
  return keyLike.length >= 3 && keyLike.length / content.length >= 0.8
}
