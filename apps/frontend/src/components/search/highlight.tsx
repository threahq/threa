import { Fragment } from "react"
import { stripMarkdownToInline } from "@/lib/markdown/strip"

/**
 * Extract highlightable terms from the free-text part of a search query.
 * Quoted phrases become a single term; bare words are individual terms.
 * Single-character terms are dropped — marking every "a" is noise, not signal.
 */
export function extractSearchTerms(searchText: string): string[] {
  const terms: string[] = []
  const phraseRegex = /"([^"]+)"|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = phraseRegex.exec(searchText)) !== null) {
    const term = (match[1] ?? match[2]).trim()
    if (term.length >= 2) terms.push(term)
  }
  return terms
}

const SNIPPET_LEAD_CHARS = 32
const SNIPPET_MAX_CHARS = 220

export interface Snippet {
  text: string
  /** True when the snippet starts mid-content (render a leading ellipsis). */
  truncatedStart: boolean
}

/**
 * Strip markdown (INV-60) and window the content around the first term match,
 * VS Code-style: a short lead-in before the match, then as much trailing
 * context as fits. Semantic-only hits (no literal term in the content) fall
 * back to the start of the message.
 */
export function buildSnippet(contentMarkdown: string, terms: string[]): Snippet {
  const text = stripMarkdownToInline(contentMarkdown)
  const firstMatch = findFirstMatch(text, terms)

  let start = 0
  if (firstMatch !== null && firstMatch > SNIPPET_LEAD_CHARS) {
    // Snap the window start to a word boundary so the lead-in reads naturally
    const rough = firstMatch - SNIPPET_LEAD_CHARS
    const boundary = text.indexOf(" ", rough)
    start = boundary !== -1 && boundary < firstMatch ? boundary + 1 : rough
  }

  return {
    text: text.slice(start, start + SNIPPET_MAX_CHARS),
    truncatedStart: start > 0,
  }
}

function findFirstMatch(text: string, terms: string[]): number | null {
  const lower = text.toLowerCase()
  let first: number | null = null
  for (const term of terms) {
    const index = lower.indexOf(term.toLowerCase())
    if (index !== -1 && (first === null || index < first)) {
      first = index
    }
  }
  return first
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Render text with `<mark>` around case-insensitive term matches.
 * Plain text in, styled spans out — markdown must already be stripped.
 */
export function HighlightedText({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0 || !text) {
    return <>{text}</>
  }

  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi")
  const segments = text.split(pattern)

  return (
    <>
      {segments.map((segment, index) =>
        // Odd indices are capture-group matches by String.split contract
        index % 2 === 1 ? (
          <mark key={index} className="rounded-[2px] bg-primary/20 px-px text-foreground">
            {segment}
          </mark>
        ) : (
          <Fragment key={index}>{segment}</Fragment>
        )
      )}
    </>
  )
}
