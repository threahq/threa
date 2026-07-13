import type { PersonaAttachmentContextMode } from "@threa/types"
import { PERSONA_ATTACHMENT_BLOCK_MAX_CHARS, PERSONA_ATTACHMENT_INLINE_FULLTEXT_MAX_CHARS } from "../../config"

/**
 * The literal body rendered when a file has no usable extracted content yet
 * (extraction pending or produced nothing) and the block budget is still open.
 */
export const PERSONA_KNOWLEDGE_PROCESSING_NOTE = "(processing — content not yet available)"

/** Marks a body cut short by the block budget — a file is degraded, never silently dropped. */
export const PERSONA_KNOWLEDGE_TRUNCATION_MARKER = "…[truncated]"

/**
 * Content lengths for one attachment, in the counting units the RENDER path uses
 * (JS string `.length` — UTF-16 code units). `null` (or `0`) for a column the
 * extraction hasn't produced. This is the ONLY input to the planner: it never
 * sees the text itself, so the same logic drives the prompt renderer (which has
 * the content) and the config payload (which must not carry it — decision 6/7).
 */
export interface PersonaKnowledgeLengths {
  fullTextChars: number | null
  summaryChars: number | null
}

/** Which extracted source the renderer should draw a file's body from. */
export type PersonaKnowledgeSource = "fullText" | "summary" | "processingNote" | "marker"

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
}

/** A column counts as present only when it has at least one character (an empty extraction is "absent"). */
function hasContent(chars: number | null): boolean {
  return chars != null && chars > 0
}

/**
 * The single source of truth for how a persona's context attachments map to
 * prompt bodies (INV-29/43): the selection rules (decision 6) and the cumulative
 * block-budget walk, expressed over content LENGTHS only. Both callers feed it
 * lengths — the prompt renderer from the content it is about to render, the
 * config service from `LENGTH(...)` columns — so the mode label the editor shows
 * is derived by the exact logic that builds the prompt and cannot drift from it.
 *
 * Per file, in `position` (array) order:
 * - Full extracted text when present and within
 *   {@link PERSONA_ATTACHMENT_INLINE_FULLTEXT_MAX_CHARS}; else the short summary;
 *   else a processing note.
 * - The chosen body spends the cumulative {@link PERSONA_ATTACHMENT_BLOCK_MAX_CHARS}
 *   budget. The file that crosses it is truncated with an explicit marker, and
 *   every later file degrades to its summary-only (or the marker when it has none)
 *   — a file is never silently dropped.
 */
export function planPersonaKnowledge(items: PersonaKnowledgeLengths[]): PersonaKnowledgePlan[] {
  const plans: PersonaKnowledgePlan[] = []
  let usedChars = 0
  let budgetCrossed = false

  for (const item of items) {
    if (budgetCrossed) {
      // Budget already spent by an earlier file: degrade to the short summary so
      // this file's gist still lands; the marker stands in when it has none.
      if (hasContent(item.summaryChars)) {
        plans.push({ mode: "summary", truncated: false, source: "summary", truncateAt: null })
      } else {
        plans.push({ mode: "name_only", truncated: false, source: "marker", truncateAt: null })
      }
      continue
    }

    let source: Exclude<PersonaKnowledgeSource, "marker">
    let bodyLen: number
    if (hasContent(item.fullTextChars) && item.fullTextChars! <= PERSONA_ATTACHMENT_INLINE_FULLTEXT_MAX_CHARS) {
      source = "fullText"
      bodyLen = item.fullTextChars!
    } else if (hasContent(item.summaryChars)) {
      source = "summary"
      bodyLen = item.summaryChars!
    } else {
      source = "processingNote"
      bodyLen = PERSONA_KNOWLEDGE_PROCESSING_NOTE.length
    }

    const remaining = PERSONA_ATTACHMENT_BLOCK_MAX_CHARS - usedChars
    const mode = MODE_BY_SOURCE[source]
    if (bodyLen > remaining) {
      budgetCrossed = true
      plans.push({ mode, truncated: true, source, truncateAt: remaining })
    } else {
      usedChars += bodyLen
      plans.push({ mode, truncated: false, source, truncateAt: null })
    }
  }

  return plans
}
