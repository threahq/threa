import { ensureBlockIds, parseMarkdown } from "@threahq/prosemirror"
import type { DocSection, JSONContent } from "@threahq/types"
import type { DocAgentEditRefusal } from "./agent-types"

export type AgentSection = Pick<DocSection, "blockId" | "markdown" | "contentJson">

/** An unchanged section carries its stored node, which buildContent reuses verbatim. */
export type NextSection =
  | { changed: false; blockId: string; markdown: string; contentJson: JSONContent }
  | { changed: true; blockId: string; markdown: string }

export interface DocAgentEdit {
  blockId?: string
  old: string
  new: string
}

/** `reinserted` names a moved block, which must be written as a delete plus a fresh insert. */
export type DocRewrite =
  | { ok: true; sections: NextSection[]; reinserted?: string }
  | { ok: false; refusal: DocAgentEditRefusal }

const MARKER_PATTERN = /^<!--\s*(blk_[0-9A-HJKMNP-TV-Z]{26})\s*-->[ \t]*\n?/gm

export function renderWithMarkers(sections: readonly Pick<DocSection, "blockId" | "markdown">[]): string {
  return sections.map((section) => `<!-- ${section.blockId} -->\n${section.markdown}`).join("\n\n")
}

export function stripMarkers(text: string): string {
  return text.replace(MARKER_PATTERN, "")
}

/** Also drops `\r`, so CRLF input lines up with stored LF markdown, and NBSP, which `docs read` shows as a space. */
export function normalizeTrailingWs(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\r\u00a0]+$/, ""))
    .join("\n")
}

interface Match {
  index: number
  at: number
  length: number
  replacement: string
}

/** One way to read an edit's `old` against a block, yielding each match and what replaces it. */
interface Reading {
  find: (text: string) => { at: number; length: number; replacement: string }[]
}

/** A newline that isn't part of a blank line or already behind a hard break's backslash. */
const LONE_NEWLINE = /(?<![\\\n])\n(?!\n)/g

const edgeNewlines = (text: string) => ({
  leading: text.length - text.replace(/^\n+/, "").length,
  trailing: text.length - text.replace(/\n+$/, "").length,
})

/** Drops the edge newlines `old` lost, and no more, so a replacement that adds a blank line keeps it. */
function trimLike(old: string, replacement: string): string {
  const dropped = edgeNewlines(old)
  const rest = replacement.slice(Math.min(dropped.leading, edgeNewlines(replacement).leading))
  return rest.slice(0, rest.length - Math.min(dropped.trailing, edgeNewlines(rest).trailing))
}

function literalReading(needle: string, replacement: string): Reading {
  return {
    find: (text) => findOccurrences(text, needle).map((at) => ({ at, length: needle.length, replacement })),
  }
}

/**
 * Each lone newline in `needle` also matches a hard break (stored as a trailing
 * backslash), independently, so a list item's line break can sit beside a hard
 * break. The replacement takes the matched separators positionally when it has
 * as many lone newlines; otherwise it stays literal.
 */
function hardBreakReading(needle: string, replacement: string): Reading {
  const pattern = needle
    .split(LONE_NEWLINE)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("(\\\\?\\n)")
  return {
    find: (text) => {
      const parts = replacement.split(LONE_NEWLINE)
      const regex = new RegExp(pattern, "g")
      const found: { at: number; length: number; replacement: string }[] = []
      for (let m = regex.exec(text); m && found.length < 2; m = regex.exec(text)) {
        const separators = m.slice(1)
        found.push({
          at: m.index,
          length: m[0].length,
          replacement:
            parts.length - 1 === separators.length
              ? parts.reduce((joined, part, i) => joined + separators[i - 1] + part)
              : replacement,
        })
        regex.lastIndex = m.index + 1
      }
      return found
    },
  }
}

function keep({ blockId, markdown, contentJson }: AgentSection): NextSection {
  return { changed: false, blockId, markdown, contentJson }
}

function refuse(
  sections: readonly AgentSection[],
  reason: DocAgentEditRefusal["reason"],
  options: { blockId?: string; editIndex?: number } = {}
): DocRewrite {
  const scoped = options.blockId === undefined ? sections : sections.filter((s) => s.blockId === options.blockId)
  return {
    ok: false,
    refusal: {
      reason,
      ...(options.editIndex === undefined ? {} : { editIndex: options.editIndex }),
      scope: {
        ...(options.blockId === undefined ? {} : { blockId: options.blockId }),
        markdown: renderWithMarkers(scoped),
      },
    },
  }
}

/** Overlapping occurrences, so `aa` in `aaa` is ambiguous; stops counting at two. */
function findOccurrences(text: string, needle: string): number[] {
  const found: number[] = []
  for (let at = text.indexOf(needle); at !== -1 && found.length < 2; at = text.indexOf(needle, at + 1)) {
    found.push(at)
  }
  return found
}

function scopeOf(sections: readonly AgentSection[], blockId: string | undefined): number[] | null {
  if (blockId === undefined) return sections.map((_, index) => index)
  const index = sections.findIndex((s) => s.blockId === blockId)
  return index === -1 ? null : [index]
}

/** Replaces `[at, at + length)` of `text`'s normalized form; lines outside the match keep their trailing whitespace. */
function spliceNormalized(text: string, at: number, length: number, replacement: string): string {
  const normalized = normalizeTrailingWs(text)
  const end = at + length
  const first = normalized.slice(0, at).split("\n").length - 1
  const last = first + normalized.slice(at, end).split("\n").length - 1
  const prefix = normalized.slice(normalized.lastIndexOf("\n", at - 1) + 1, at)
  const lineEnd = normalized.indexOf("\n", end)
  const suffix = normalized.slice(end, lineEnd === -1 ? undefined : lineEnd)
  const lines = text.split("\n")
  lines.splice(first, last - first + 1, ...(prefix + replacement + suffix).split("\n"))
  return lines.join("\n")
}

/**
 * Applies `edits` in order against `sections` (the doc's current state). Each
 * `old` must occur exactly once in its scope, the named block or else any one
 * block; a match never spans two blocks. Matching ignores trailing whitespace,
 * then surrounding newlines, then a hard break's backslash, each tier tried only
 * when the stricter ones found nothing.
 * The first failing edit refuses the whole call with the scope's current
 * markdown.
 */
export function resolveEdits(sections: readonly AgentSection[], edits: readonly DocAgentEdit[]): DocRewrite {
  const working = sections.map((section) => section.markdown)
  for (const [editIndex, edit] of edits.entries()) {
    const scope = scopeOf(sections, edit.blockId)
    if (!scope) return refuse(sections, "unknown_block", { editIndex })

    const exact = normalizeTrailingWs(stripMarkers(edit.old))
    const replacement = normalizeTrailingWs(stripMarkers(edit.new))
    const trimmed = exact.replace(/^\n+|\n+$/g, "")
    const trimmedReplacement = trimLike(exact, replacement)
    // Each looser reading runs only when the stricter ones found nothing, so a unique match never turns ambiguous.
    const readings = [
      literalReading(exact, replacement),
      ...(trimmed === exact ? [] : [literalReading(trimmed, trimmedReplacement)]),
      ...(trimmed.split(LONE_NEWLINE).length > 1 ? [hardBreakReading(trimmed, trimmedReplacement)] : []),
    ]
    let matches: Match[] = []
    for (const reading of trimmed === "" ? [] : readings) {
      matches = scope.flatMap((index) =>
        reading.find(normalizeTrailingWs(working[index])).map((match) => ({ index, ...match }))
      )
      if (matches.length > 0) break
    }
    if (matches.length !== 1) {
      return refuse(sections, matches.length === 0 ? "not_found" : "ambiguous", { blockId: edit.blockId, editIndex })
    }
    const [{ index, at, length, replacement: next }] = matches
    working[index] = spliceNormalized(working[index], at, length, next)
  }
  return {
    ok: true,
    sections: sections.map((section, index) =>
      normalizeTrailingWs(working[index]) === normalizeTrailingWs(section.markdown)
        ? keep(section)
        : { changed: true, blockId: section.blockId, markdown: working[index] }
    ),
  }
}

export function insertSection(
  sections: readonly AgentSection[],
  params: { after: string; markdown: string },
  mintId: () => string
): DocRewrite {
  const position = params.after === "start" ? 0 : sections.findIndex((s) => s.blockId === params.after) + 1
  if (position === 0 && params.after !== "start") return refuse(sections, "unknown_block")
  const next = sections.map(keep)
  next.splice(position, 0, { changed: true, blockId: mintId(), markdown: stripMarkers(params.markdown) })
  return { ok: true, sections: next }
}

export function moveSection(sections: readonly AgentSection[], params: { blockId: string; after: string }): DocRewrite {
  const from = sections.findIndex((s) => s.blockId === params.blockId)
  const knownAfter = params.after === "start" || sections.some((s) => s.blockId === params.after)
  if (from === -1 || !knownAfter) return refuse(sections, "unknown_block")
  const next = sections.map(keep)
  if (params.after === params.blockId) return { ok: true, sections: next }
  const [moved] = next.splice(from, 1)
  next.splice(params.after === "start" ? 0 : next.findIndex((s) => s.blockId === params.after) + 1, 0, moved)
  const reordered = next.some((section, index) => section.blockId !== sections[index].blockId)
  return reordered ? { ok: true, sections: next, reinserted: params.blockId } : { ok: true, sections: next }
}

export function deleteSection(sections: readonly AgentSection[], params: { blockId: string }): DocRewrite {
  if (!sections.some((s) => s.blockId === params.blockId)) return refuse(sections, "unknown_block")
  return { ok: true, sections: sections.filter((s) => s.blockId !== params.blockId).map(keep) }
}

/**
 * Unchanged sections reuse their stored node, so the Yjs diff leaves them
 * alone. A changed section is reparsed: its first block keeps the section's
 * id, further blocks are new, and a blank section is deleted.
 */
export function buildContent(
  next: readonly NextSection[],
  previousBody: JSONContent,
  mintId: () => string
): JSONContent {
  const content = next.flatMap((section): JSONContent[] => {
    if (!section.changed) return [section.contentJson]
    if (!section.markdown.trim()) return []
    const [first, ...rest] = parseMarkdown(section.markdown).content ?? []
    if (!first) return []
    return [{ ...first, attrs: { ...first.attrs, blockId: section.blockId } }, ...rest]
  })
  return ensureBlockIds({ type: "doc", content }, mintId, previousBody)
}
