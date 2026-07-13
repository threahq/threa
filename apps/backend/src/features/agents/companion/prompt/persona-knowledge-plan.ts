import type { PersonaAttachmentContextMode } from "@threa/types"
import { PERSONA_ATTACHMENT_BLOCK_MAX_CHARS, PERSONA_ATTACHMENT_INLINE_FULLTEXT_MAX_CHARS } from "../../config"

/**
 * The literal body rendered when a file has no usable extracted content yet
 * (extraction still in flight) and the block budget is still open.
 */
export const PERSONA_KNOWLEDGE_PROCESSING_NOTE = "(processing — content not yet available)"

/**
 * The literal body rendered when a file's extraction pipeline gave up
 * (terminal failed/skipped, no extraction row) — the persona is told the file
 * exists but its content is unavailable, never silently dropped (INV-11).
 */
export const PERSONA_KNOWLEDGE_FAILURE_NOTE = "(extraction failed — content unavailable)"

/** Marks a body cut short by the block budget — a file is degraded, never silently dropped. */
export const PERSONA_KNOWLEDGE_TRUNCATION_MARKER = "…[truncated]"

/**
 * Content lengths for one attachment, in the counting units the RENDER path uses
 * (JS string `.length` — UTF-16 code units). `null` (or `0`) for a column the
 * extraction hasn't produced. This is the ONLY input to the planner: it never
 * sees the text itself, so the same logic drives the prompt renderer (which has
 * the content) and the config payload (which must not carry it — decision 6/7).
 * `extractionFailed` distinguishes a content-less file whose pipeline gave up
 * (renders the failure note) from one still processing (the processing note).
 */
export interface PersonaKnowledgeLengths {
  fullTextChars: number | null
  summaryChars: number | null
  extractionFailed?: boolean
}

/** Which extracted source the renderer should draw a file's body from. */
export type PersonaKnowledgeSource = "fullText" | "summary" | "processingNote" | "failureNote" | "marker"

/**
 * The plan for rendering one attachment's body. `mode` is the user-facing context
 * mode (what reaches the model); `source`/`truncateAt` are the render directive
 * the prompt builder follows to produce byte-identical output. `truncateAt`:
 * `null` = render the whole source; a number = slice the source to that many
 * chars and append the truncation marker (marker only when `<= 0`).
 */
export interface PersonaKnowledgePlan {
  mode: PersonaAttachmentContextMode
  truncated: boolean
  source: PersonaKnowledgeSource
  truncateAt: number | null
}

const MODE_BY_SOURCE: Record<Exclude<PersonaKnowledgeSource, "marker">, PersonaAttachmentContextMode> = {
  fullText: "full",
  summary: "summary",
  processingNote: "name_only",
  failureNote: "name_only",
}

/** A column counts as present only when it has at least one character (an empty extraction is "absent"). */
function hasContent(chars: number | null): boolean {
  return chars != null && chars > 0
}

interface Candidate {
  source: Exclude<PersonaKnowledgeSource, "marker">
  len: number
}

/**
 * The body sources one file could render, in descending priority: the inline
 * full text (only when present and within the per-file cap), then the short
 * summary, then — only when there is no extracted content at all — a one-line
 * note (the failure note when the pipeline gave up, else the processing note).
 */
function candidatesFor(item: PersonaKnowledgeLengths): Candidate[] {
  const candidates: Candidate[] = []
  if (hasContent(item.fullTextChars) && item.fullTextChars! <= PERSONA_ATTACHMENT_INLINE_FULLTEXT_MAX_CHARS) {
    candidates.push({ source: "fullText", len: item.fullTextChars! })
  }
  if (hasContent(item.summaryChars)) {
    candidates.push({ source: "summary", len: item.summaryChars! })
  }
  if (candidates.length === 0) {
    candidates.push(
      item.extractionFailed
        ? { source: "failureNote", len: PERSONA_KNOWLEDGE_FAILURE_NOTE.length }
        : { source: "processingNote", len: PERSONA_KNOWLEDGE_PROCESSING_NOTE.length }
    )
  }
  return candidates
}

/**
 * The single source of truth for how a persona's context attachments map to
 * prompt bodies (INV-29/43): the selection rules (decision 6) and the block
 * budget, expressed over content LENGTHS only. Both callers feed it lengths —
 * the prompt renderer from the content it is about to render, the config service
 * from `LENGTH(...)` columns — so the mode label the editor shows is derived by
 * the exact logic that builds the prompt and cannot drift from it.
 *
 * ONE continuous budget walk over the files in `position` (array) order. The
 * chosen body of each file spends the cumulative
 * {@link PERSONA_ATTACHMENT_BLOCK_MAX_CHARS} budget:
 * - Emit the highest-priority candidate that fits the remaining budget WHOLE and
 *   spend its length. A too-big full text degrades to a whole summary rather than
 *   being truncated — a complete gist beats a cut-off body.
 * - If no candidate fits whole (but budget remains), truncate the SMALLEST
 *   candidate to what's left with an explicit marker and spend the rest of the
 *   budget.
 * - Once the budget is exhausted, later files render a marker-only row (their
 *   heading still appears) — a file is never silently dropped, and the total
 *   rendered content stays within the cap (only one file is ever truncated).
 */
export function planPersonaKnowledge(items: PersonaKnowledgeLengths[]): PersonaKnowledgePlan[] {
  const plans: PersonaKnowledgePlan[] = []
  let usedChars = 0

  for (const item of items) {
    const remaining = PERSONA_ATTACHMENT_BLOCK_MAX_CHARS - usedChars
    if (remaining <= 0) {
      plans.push({ mode: "name_only", truncated: false, source: "marker", truncateAt: null })
      continue
    }

    const candidates = candidatesFor(item)
    const whole = candidates.find((candidate) => candidate.len <= remaining)
    if (whole) {
      usedChars += whole.len
      plans.push({ mode: MODE_BY_SOURCE[whole.source], truncated: false, source: whole.source, truncateAt: null })
      continue
    }

    // Nothing fits whole: truncate the smallest candidate to what's left and
    // spend the rest of the budget (every later file becomes marker-only).
    const smallest = candidates.reduce((a, b) => (b.len < a.len ? b : a))
    usedChars = PERSONA_ATTACHMENT_BLOCK_MAX_CHARS
    plans.push({
      mode: MODE_BY_SOURCE[smallest.source],
      truncated: true,
      source: smallest.source,
      truncateAt: remaining,
    })
  }

  return plans
}
