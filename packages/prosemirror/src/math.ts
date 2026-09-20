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

interface MathToken {
  tex: string
  display: boolean
}

export type MathPart = { text: string } | MathToken

/** A math run located in a plain-text string: `[from, to)` with its TeX body. */
export interface MathSpanRange extends MathToken {
  from: number
  to: number
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
 * `https://y/c$d` would otherwise read as one inline equation. A link is
 * protected from its opening bracket, not just its destination: an escaped
 * bracket in the label — `[report\[final\].pdf](attachment:att_1)` — is a
 * `\[…\]` pair, and reading it as display math ate the whole reference.
 */
const PROTECTED =
  /(?<!\\)\[(?:\\.|[^\]\n])*\]\([^)\n]*\)|\]\([^)\n]*\)|<[A-Za-z][A-Za-z0-9+.-]*:[^>\s]*>|(?:https?|mailto):\S+/g

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

  let out = ""
  let plainStart = 0
  let i = 0
  PROTECTED.lastIndex = 0
  let protectedMatch = PROTECTED.exec(markdown)

  const keepVerbatim = (start: number, end: number) => {
    out += tokenize(markdown.slice(plainStart, start)) + markdown.slice(start, end)
    plainStart = end
  }

  while (i < markdown.length) {
    if (i === 0 || markdown[i - 1] === "\n") {
      const end = fenceEnd(markdown, i)
      if (end !== null) {
        keepVerbatim(i, end)
        i = end
        continue
      }
    }
    if (markdown[i] === "`") {
      const end = codeSpanEnd(markdown, i)
      if (end !== null) {
        keepVerbatim(i, end)
        i = end
        continue
      }
    }
    // One forward pass over the protected matches: re-running exec per character
    // would rescan the rest of the message every time.
    while (protectedMatch && protectedMatch.index < i) protectedMatch = PROTECTED.exec(markdown)
    if (protectedMatch?.index === i) {
      const end = i + protectedMatch[0].length
      keepVerbatim(i, end)
      i = end
      continue
    }
    i++
  }

  return out + tokenize(markdown.slice(plainStart))
}

/**
 * Split a parsed text run on math tokens, or null when it holds none. The `tex`
 * that comes back is exactly what `extractMath` took out of the source.
 */
/**
 * A table cell escapes every `|` so the pipe cannot end the cell, and that
 * reaches into the TeX: the source is tokenized before the row is split. Undone
 * here, or `a|b` draws as a norm and gains a backslash on every edit.
 */
export function unescapeTableCellTex(tex: string): string {
  return tex.replace(/\\\|/g, "|")
}

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
  let out = ""
  let cursor = 0
  for (const span of scanMathSpans(text)) {
    out += text.slice(cursor, span.from) + encode(span)
    cursor = span.to
  }
  return out + text.slice(cursor)
}

/**
 * Every math run in a plain-text string, in order and non-overlapping. This is
 * the definition `extractMath` tokenizes with, exported so a live preview draws
 * exactly the spans the message will render: one rule for what counts as math,
 * rather than two that drift.
 *
 * The input is text, not markdown - a caller that can hold code or URLs is
 * responsible for excluding them, the way `extractMath` does before tokenizing.
 */
export function scanMathSpans(text: string): MathSpanRange[] {
  const closers = inlineClosers(text)
  const spans: MathSpanRange[] = []
  let closerIndex = 0
  let i = 0
  while (i < text.length) {
    while (closerIndex < closers.length && closers[closerIndex] <= i) closerIndex++
    const span = readMath(text, i, closers[closerIndex] ?? -1)
    if (!span) {
      i++
      continue
    }
    spans.push(span)
    i = span.to
  }
  return spans
}

/**
 * Every `$` that can close inline math. The test is local to the position, so
 * one pass up front keeps a failed opener from rescanning the rest of the
 * message: prose full of prices is otherwise quadratic (58 kB took 590 ms).
 */
function inlineClosers(text: string): number[] {
  const closers: number[] = []
  for (let i = 1; i < text.length; i++) {
    // A closer preceded by whitespace is the *next* price, not the end of math,
    // and `$50-$60` means both were amounts.
    if (text[i] !== "$" || /\s/.test(text[i - 1])) continue
    const next = text[i + 1]
    if (next && /[\d$]/.test(next)) continue
    closers.push(i)
  }
  return closers
}

function readMath(text: string, i: number, closer: number): MathSpanRange | null {
  if (text[i] === "\\") {
    if (text[i - 1] === "\\") return null
    if (text[i + 1] === "[") return readBackslashMath(text, i, "\\]", true)
    if (text[i + 1] === "(") return readBackslashMath(text, i, "\\)", false)
    return null
  }
  if (text[i] !== "$") return null
  return text[i + 1] === "$" ? readDisplayMath(text, i) : readInlineMath(text, i, closer)
}

function readBackslashMath(text: string, start: number, closer: string, display: boolean): MathSpanRange | null {
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

function readDisplayMath(text: string, start: number): MathSpanRange | null {
  const close = text.indexOf("$$", start + 2)
  if (close < 0) return null
  return accept(start, close + 2, text.slice(start + 2, close), true)
}

function readInlineMath(text: string, start: number, closer: number): MathSpanRange | null {
  const before = start > 0 ? text[start - 1] : ""
  // An opener glued to a word is part of that word, not a delimiter.
  if (before && /[\w$\\]/.test(before)) return null
  const after = text[start + 1]
  if (!after || /\s/.test(after) || closer < 0) return null

  const tex = text.slice(start + 1, closer)
  // A `$` inside the body means the opener was a price: in `costs $5 and $x$
  // here` the real equation starts at the third `$`.
  if (tex.includes("$") || tex.includes("\n\n")) return null
  return accept(start, closer + 1, tex, false)
}

function accept(from: number, to: number, raw: string, display: boolean): MathSpanRange | null {
  const tex = raw.trim()
  if (!tex || NUMERIC_ONLY.test(tex)) return null
  return { from, to, tex, display }
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
