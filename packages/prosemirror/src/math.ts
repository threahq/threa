/**
 * LaTeX delimiter handling for the markdown renderer.
 *
 * Two halves, deliberately split by when they can run:
 *
 *   - `normalizeMathDelimiters` rewrites the backslash forms `\(…\)` / `\[…\]`
 *     into `$` / `$$`. It has to run on the raw source, because CommonMark
 *     treats `\[` as an escaped bracket — by the time there is a syntax tree the
 *     delimiter is an ordinary `[` and is indistinguishable from a literal one.
 *   - `findMathSpans` locates math inside one plain-text run, after parsing,
 *     where fenced code, code spans, and link destinations are already separate
 *     nodes and can no longer be mistaken for prose.
 */

export interface MathSpan {
  /** Index of the opening delimiter within the scanned text. */
  start: number
  /** Index just past the closing delimiter. */
  end: number
  /** Delimiter-free TeX source. */
  tex: string
  display: boolean
}

/**
 * Math that is nothing but digits and separators is a price, not an equation:
 * `$5 … $10` and `$1,000 … $2,000` are the reason this check exists.
 */
const NUMERIC_ONLY = /^[\s\d.,]+$/

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/

interface Segment {
  text: string
  code: boolean
}

/**
 * Scan a plain-text run for `$…$` and `$$…$$` math.
 *
 * Single-`$` math is recognized under deliberately strict rules, because a chat
 * message is far more likely to be talking about money than about algebra:
 * the delimiters must hug their content, the closer must not run into a digit,
 * and all-numeric content is rejected. `$5 and $10 total`, `$50-$60`, `$PATH`
 * and `price is $5` all stay literal; `$e^{i\pi}+1=0$` does not.
 */
export function findMathSpans(text: string): MathSpan[] {
  const spans: MathSpan[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] !== "$") {
      i++
      continue
    }
    const span = text[i + 1] === "$" ? readDisplayMath(text, i) : readInlineMath(text, i)
    if (span) {
      spans.push(span)
      i = span.end
      continue
    }
    i++
  }
  return spans
}

function readDisplayMath(text: string, start: number): MathSpan | null {
  const close = text.indexOf("$$", start + 2)
  if (close < 0) return null
  const tex = text.slice(start + 2, close).trim()
  if (!tex || NUMERIC_ONLY.test(tex)) return null
  return { start, end: close + 2, tex, display: true }
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
    if (NUMERIC_ONLY.test(tex) || tex.includes("\n\n")) return null
    return { start, end: j + 1, tex, display: false }
  }
  return null
}

/**
 * Rewrite `\(…\)` to `$…$` and `\[…\]` to `$$…$$` outside code, so the rest of
 * the pipeline only has to understand dollar delimiters. This is the form LLMs
 * emit, which is how the math arrives in Threa in the first place.
 *
 * The content is trimmed on the way in: `\( x \)` becomes `$x$`, which
 * `findMathSpans` accepts, rather than `$ x $`, which it rejects.
 */
export function normalizeMathDelimiters(markdown: string): string {
  if (!markdown.includes("\\(") && !markdown.includes("\\[")) return markdown
  return segmentCode(markdown)
    .map((segment) => (segment.code ? segment.text : rewriteBackslashDelimiters(segment.text)))
    .join("")
}

function rewriteBackslashDelimiters(text: string): string {
  return text
    .replace(/(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g, (match, tex: string) => wrap(match, tex, "$$"))
    .replace(/(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)/g, (match, tex: string) => wrap(match, tex, "$"))
}

function wrap(match: string, tex: string, delimiter: string): string {
  const trimmed = tex.trim()
  return trimmed ? delimiter + trimmed + delimiter : match
}

function segmentCode(markdown: string): Segment[] {
  const segments: Segment[] = []
  let plainStart = 0
  let i = 0

  const pushCode = (start: number, end: number) => {
    if (start > plainStart) segments.push({ text: markdown.slice(plainStart, start), code: false })
    segments.push({ text: markdown.slice(start, end), code: true })
    plainStart = end
  }

  while (i < markdown.length) {
    if (i === 0 || markdown[i - 1] === "\n") {
      const end = fenceEnd(markdown, i)
      if (end !== null) {
        pushCode(i, end)
        i = end
        continue
      }
    }
    if (markdown[i] === "`") {
      const end = codeSpanEnd(markdown, i)
      if (end !== null) {
        pushCode(i, end)
        i = end
        continue
      }
    }
    i++
  }

  if (plainStart < markdown.length) segments.push({ text: markdown.slice(plainStart), code: false })
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

/** Index just past a code span opening at `start`, or null if it never closes. */
function codeSpanEnd(markdown: string, start: number): number | null {
  let open = start
  while (markdown[open] === "`") open++
  const ticks = open - start
  for (let i = open; i < markdown.length; i++) {
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
