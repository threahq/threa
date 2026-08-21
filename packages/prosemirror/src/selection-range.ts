/**
 * Mapping a rendered text selection back to a position range in the document
 * it was rendered from.
 *
 * The browser hands us a string, not positions: marks split one word across
 * several text nodes, mentions and other atoms render a label that exists
 * nowhere in the JSON, and the timeline renderer is free to add whitespace.
 * So we project the document to a word sequence that remembers where every
 * character lives, tokenize the selection the same way, and match the two as a
 * word sequence. Matching is deliberately forgiving at the edges (a selection
 * may start mid-word and end mid-word) and around atoms (their label is
 * consumed as up to a handful of unmatched words).
 */

import type { ContentRange, JSONContent } from "@threa/types"

import { LEAF_NODE_TYPES, nodeSize } from "./positions"

export interface SelectionRangeInput {
  /** The selected text as the DOM reports it. */
  text: string
  /** The rendered text before the selection, used to choose between repeated matches. */
  prefixText?: string
}

/** Longest run of selected words an atom's rendered label may account for. */
const MAX_ATOM_LABEL_WORDS = 5

/**
 * The position range covering `text` inside `doc`, or `null` when the selection
 * can't be located (the caller then falls back to referencing the whole
 * message). Pure and deterministic.
 */
export function resolveSelectionRange(doc: JSONContent, input: SelectionRangeInput): ContentRange | null {
  const selected = toWords(input.text)
  if (selected.length === 0) return null

  const tokens = project(doc)
  if (tokens.length === 0) return null

  const memo = new Map<string, number | null>()

  const matchTail = (tokenIndex: number, wordIndex: number): number | null => {
    const key = `${tokenIndex}:${wordIndex}`
    const cached = memo.get(key)
    if (cached !== undefined) return cached
    const result = computeTail(tokenIndex, wordIndex)
    memo.set(key, result)
    return result
  }

  const computeTail = (tokenIndex: number, wordIndex: number): number | null => {
    const token = tokens[tokenIndex]
    if (!token) return null
    if (token.kind === "atom") {
      const maxConsumed = Math.min(MAX_ATOM_LABEL_WORDS, selected.length - wordIndex)
      for (let consumed = 0; consumed <= maxConsumed; consumed++) {
        if (wordIndex + consumed === selected.length) return token.to
        const end = matchTail(tokenIndex + 1, wordIndex + consumed)
        if (end !== null) return end
      }
      return null
    }
    const word = selected[wordIndex]
    if (wordIndex === selected.length - 1) {
      return token.text.startsWith(word) ? token.positions[word.length - 1] + 1 : null
    }
    if (token.text !== word) return null
    return matchTail(tokenIndex + 1, wordIndex + 1)
  }

  const matchAt = (tokenIndex: number): ContentRange | null => {
    const token = tokens[tokenIndex]
    if (token.kind === "atom") {
      const maxConsumed = Math.min(MAX_ATOM_LABEL_WORDS, selected.length)
      for (let consumed = 1; consumed <= maxConsumed; consumed++) {
        if (consumed === selected.length) return { from: token.from, to: token.to }
        const end = matchTail(tokenIndex + 1, consumed)
        if (end !== null) return { from: token.from, to: end }
      }
      return null
    }
    const first = selected[0]
    if (selected.length === 1) {
      const at = token.text.indexOf(first)
      if (at < 0) return null
      return { from: token.positions[at], to: token.positions[at + first.length - 1] + 1 }
    }
    if (!token.text.endsWith(first)) return null
    const end = matchTail(tokenIndex + 1, 1)
    if (end === null) return null
    return { from: token.positions[token.text.length - first.length], to: end }
  }

  const targetWordsBefore = input.prefixText === undefined ? null : toWords(input.prefixText).length
  let best: ContentRange | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  let wordsBefore = 0
  for (let i = 0; i < tokens.length; i++) {
    const range = matchAt(i)
    if (range) {
      if (targetWordsBefore === null) return range
      const distance = Math.abs(wordsBefore - targetWordsBefore)
      if (distance < bestDistance) {
        best = range
        bestDistance = distance
      }
    }
    // An atom renders as one label the prefix text counts as a word too.
    wordsBefore++
  }
  return best
}

interface WordToken {
  kind: "word"
  text: string
  /** Document position of each character in `text`. */
  positions: number[]
}

interface AtomToken {
  kind: "atom"
  from: number
  to: number
}

type ProjectionToken = WordToken | AtomToken

function project(doc: JSONContent): ProjectionToken[] {
  const tokens: ProjectionToken[] = []
  let chars: string[] = []
  let positions: number[] = []

  const flush = (): void => {
    if (chars.length === 0) return
    tokens.push({ kind: "word", text: chars.join(""), positions })
    chars = []
    positions = []
  }

  const walk = (node: JSONContent, contentStart: number): void => {
    let pos = contentStart
    for (const child of node.content ?? []) {
      const size = nodeSize(child)
      const type = child.type ?? ""
      if (type === "text") {
        const text = child.text ?? ""
        for (let i = 0; i < text.length; i++) {
          const ch = normalizeChar(text[i])
          if (ch === " ") {
            flush()
          } else {
            chars.push(ch)
            positions.push(pos + i)
          }
        }
      } else if (LEAF_NODE_TYPES.has(type)) {
        flush()
        if (type !== "hardBreak") tokens.push({ kind: "atom", from: pos, to: pos + 1 })
      } else {
        flush()
        walk(child, pos + 1)
        flush()
      }
      pos += size
    }
  }

  walk(doc, 0)
  flush()
  return tokens
}

// Non-breaking and zero-width characters are invisible word separators in the
// rendered text; folding them to a space keeps projection and selection aligned
// without shifting any character's position.
const SPACE_LIKE = /[\s\u200B\u200C\u200D]/

function normalizeChar(ch: string): string {
  if (SPACE_LIKE.test(ch)) return " "
  const composed = ch.normalize("NFC")
  return composed.length === 1 ? composed : ch
}

function toWords(text: string): string[] {
  const words: string[] = []
  let current = ""
  for (let i = 0; i < text.length; i++) {
    const ch = normalizeChar(text[i])
    if (ch === " ") {
      if (current.length > 0) words.push(current)
      current = ""
    } else {
      current += ch
    }
  }
  if (current.length > 0) words.push(current)
  return words
}
