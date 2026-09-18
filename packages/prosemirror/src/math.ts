/**
 * LaTeX extraction for the markdown renderer.
 *
 * Math is lifted out of the source *before* CommonMark parses it and replaced
 * with an opaque token, because a TeX body is not markdown: `\{`, `\\` and `\%`
 * are escapes the parser eats, `a*b*c` is emphasis that splits the run in two,
 * and `\[` is an escaped bracket that disappears entirely. The renderer splits
 * the tokens back out after parsing, so the TeX KaTeX receives is byte-for-byte
 * what the author wrote.
 */

/** Private-use codepoints: never valid in markdown source, inert to CommonMark. */
const TOKEN_OPEN = ""
const TOKEN_CLOSE = ""
/** Base64's alphabet is inert to CommonMark and GFM everywhere a token can land. */
const TOKEN = new RegExp(`${TOKEN_OPEN}([DI])([A-Za-z0-9+/=]*)${TOKEN_CLOSE}`, "g")

export interface MathToken {
  tex: string
  display: boolean
}

export type MathPart = { text: string } | MathToken

interface MathSpan extends MathToken {
  start: number
  end: number
}

/**
 * Math that is nothing but digits and separators is a price or a footnote
 * marker, not an equation: `$5 … $10`, `$1,000` and `\[1\]` are why this exists.
 */
const NUMERIC_ONLY = /^[\s\d.,]+$/

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/

/**
 * Regions whose `$` and `\[` are not delimiters. Code is the obvious one; URLs
 * matter because remark-gfm autolinks bare ones, and `https://x/a$b` next to
 * `https://y/c$d` would otherwise read as one inline equation.
 */
const PROTECTED = /\]\([^)\n]*\)|<[A-Za-z][A-Za-z0-9+.-]*:[^>\s]*>|(?:https?|mailto):\S+/g

interface Segment {
  text: string
  protect: boolean
}

/**
 * Replace every math run outside code and URLs with a token carrying its TeX.
 *
 * Both delimiter families are recognized: `\(…\)` / `\[…\]`, which is what LLMs
 * emit, and `$…$` / `$$…$$`. Single-`$` math is read under deliberately strict
 * rules, because a chat message is far more likely to be about money than about
 * algebra: the delimiters must hug their content, the closer must not run into a
 * digit, and all-numeric content is rejected. `$5 and $10 total`, `$50-$60`,
 * `$PATH` and `price is $5` all stay literal; `$e^{i\pi}+1=0$` does not.
 */
export function extractMath(markdown: string): string {
  if (!markdown.includes("$") && !markdown.includes("\\(") && !markdown.includes("\\[")) return markdown
  return segment(markdown)
    .map((part) => (part.protect ? part.text : tokenize(part.text)))
    .join("")
}

/**
 * Split a parsed text run on math tokens, or null when it holds none. The `tex`
 * that comes back is exactly what `extractMath` took out of the source.
 */
export function splitMathTokens(text: string): MathPart[] | null {
  if (!text.includes(TOKEN_OPEN)) return null
  const parts: MathPart[] = []
  let cursor = 0
  TOKEN.lastIndex = 0
  for (let match = TOKEN.exec(text); match; match = TOKEN.exec(text)) {
    if (match.index > cursor) parts.push({ text: text.slice(cursor, match.index) })
    parts.push({ tex: decode(match[2]), display: match[1] === "D" })
    cursor = match.index + match[0].length
  }
  if (parts.length === 0) return null
  if (cursor < text.length) parts.push({ text: text.slice(cursor) })
  return parts
}

function tokenize(text: string): string {
  const spans = findMathSpans(text)
  if (spans.length === 0) return text
  let out = ""
  let cursor = 0
  for (const span of spans) {
    out += text.slice(cursor, span.start) + encode(span)
    cursor = span.end
  }
  return out + text.slice(cursor)
}

function findMathSpans(text: string): MathSpan[] {
  const spans: MathSpan[] = []
  let i = 0
  while (i < text.length) {
    const span = readMath(text, i)
    if (span) {
      spans.push(span)
      i = span.end
      continue
    }
    i++
  }
  return spans
}

function readMath(text: string, i: number): MathSpan | null {
  if (text[i] === "\\") {
    if (text[i - 1] === "\\") return null
    if (text[i + 1] === "[") return readBackslashMath(text, i, "\\]", true)
    if (text[i + 1] === "(") return readBackslashMath(text, i, "\\)", false)
    return null
  }
  if (text[i] !== "$") return null
  return text[i + 1] === "$" ? readDisplayMath(text, i) : readInlineMath(text, i)
}

function readBackslashMath(text: string, start: number, closer: string, display: boolean): MathSpan | null {
  let from = start + 2
  for (;;) {
    const close = text.indexOf(closer, from)
    if (close < 0) return null
    if (text[close - 1] === "\\") {
      from = close + 2
      continue
    }
    return accept(start, close + 2, text.slice(start + 2, close), display)
  }
}

function readDisplayMath(text: string, start: number): MathSpan | null {
  const close = text.indexOf("$$", start + 2)
  if (close < 0) return null
  return accept(start, close + 2, text.slice(start + 2, close), true)
}

function readInlineMath(text: string, start: number): MathSpan | null {
  const before = start > 0 ? text[start - 1] : ""
  // An opener glued to a word is part of that word, not a delimiter.
  if (before && /[\w$\\]/.test(before)) return null
  const after = text[start + 1]
  if (!after || /\s/.test(after)) return null

  for (let j = start + 1; j < text.length; j++) {
    if (text[j] !== "$") continue
    // A closer preceded by whitespace is the *next* price, not the end of math.
    if (/\s/.test(text[j - 1])) continue
    const next = text[j + 1]
    // `$50-$60`: a digit right after the closer means both were amounts.
    if (next && /[\d$]/.test(next)) continue
    const tex = text.slice(start + 1, j)
    // A second `$` inside the body means the opener was a price: in
    // `costs $5 and $x$ here` the real equation starts at the third `$`.
    if (tex.includes("$") || tex.includes("\n\n")) return null
    return accept(start, j + 1, tex, false)
  }
  return null
}

function accept(start: number, end: number, raw: string, display: boolean): MathSpan | null {
  const tex = raw.trim()
  if (!tex || NUMERIC_ONLY.test(tex)) return null
  return { start, end, tex, display }
}

function encode({ tex, display }: MathToken): string {
  const bytes = new TextEncoder().encode(tex)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `${TOKEN_OPEN}${display ? "D" : "I"}${btoa(binary)}${TOKEN_CLOSE}`
}

function decode(payload: string): string {
  const binary = atob(payload)
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
}

function segment(markdown: string): Segment[] {
  const segments: Segment[] = []
  let plainStart = 0
  let i = 0
  PROTECTED.lastIndex = 0
  let protectedMatch = PROTECTED.exec(markdown)

  const pushProtected = (start: number, end: number) => {
    if (start > plainStart) segments.push({ text: markdown.slice(plainStart, start), protect: false })
    segments.push({ text: markdown.slice(start, end), protect: true })
    plainStart = end
  }

  while (i < markdown.length) {
    if (i === 0 || markdown[i - 1] === "\n") {
      const end = fenceEnd(markdown, i)
      if (end !== null) {
        pushProtected(i, end)
        i = end
        continue
      }
    }
    if (markdown[i] === "`") {
      const end = codeSpanEnd(markdown, i)
      if (end !== null) {
        pushProtected(i, end)
        i = end
        continue
      }
    }
    // One forward pass over the protected matches: re-running exec per character
    // would rescan the rest of the message every time.
    while (protectedMatch && protectedMatch.index < i) protectedMatch = PROTECTED.exec(markdown)
    if (protectedMatch?.index === i) {
      const end = i + protectedMatch[0].length
      pushProtected(i, end)
      i = end
      continue
    }
    i++
  }

  if (plainStart < markdown.length) segments.push({ text: markdown.slice(plainStart), protect: false })
  return segments
}

/** Index just past a fenced block opening at `start`, or null if none opens there. */
function fenceEnd(markdown: string, start: number): number | null {
  const lineEnd = lineEndAt(markdown, start)
  const open = FENCE_OPEN.exec(markdown.slice(start, lineEnd))
  if (!open) return null
  const marker = open[1][0]
  const closer = new RegExp(`^ {0,3}\\${marker}{${open[1].length},}\\s*$`)

  let cursor = lineEnd
  while (cursor < markdown.length) {
    cursor += 1 // step over the newline that ended the previous line
    const end = lineEndAt(markdown, cursor)
    if (closer.test(markdown.slice(cursor, end))) return end
    cursor = end
  }
  return markdown.length
}

/**
 * Index just past a code span opening at `start`, or null if it never closes.
 * A blank line ends it unclosed: CommonMark code spans cannot cross one, so a
 * stray backtick must not swallow the paragraphs after it.
 */
function codeSpanEnd(markdown: string, start: number): number | null {
  let open = start
  while (markdown[open] === "`") open++
  const ticks = open - start
  for (let i = open; i < markdown.length; i++) {
    if (markdown[i] === "\n" && /^[ \t]*\n/.test(markdown.slice(i + 1))) return null
    if (markdown[i] !== "`") continue
    let close = i
    while (markdown[close] === "`") close++
    if (close - i === ticks) return close
    i = close - 1
  }
  return null
}

function lineEndAt(markdown: string, start: number): number {
  const next = markdown.indexOf("\n", start)
  return next < 0 ? markdown.length : next
}
