/**
 * Shared construction of the `previewContent` every parser hands to the
 * `text-summary` model.
 *
 * Each parser picks its own line budget — 50 for the structured formats where a
 * few rows already show the shape, 100 for prose and code — but a line budget
 * alone does not bound anything. Minified HTML, minified JSON, and single-line
 * log dumps put an entire file on one line, so "the first 100 lines" is "the
 * whole file". Production had four such calls: one 5 MB HTML file produced a
 * 278,480-token prompt, and the four together were $0.249 of that component's
 * $0.253 for the month.
 *
 * The character cap is the real bound; the line budget stays because it is the
 * better shape when lines are lines.
 */

/**
 * Hard ceiling on preview characters, whatever the line budget admits.
 *
 * ~24k characters is roughly 6k tokens: ample for a model asked to write a
 * one-paragraph summary and a section list, and it holds the worst single call
 * to a fraction of a cent instead of eight. Large files store no full text
 * anyway (`fullTextToStore` is null above the LARGE threshold) and expose a
 * `read_attachment` tool for agents that need the body, so the summary is a
 * signpost rather than the payload — truncating it costs very little.
 */
export const PREVIEW_MAX_CHARS = 24_000

const TRUNCATION_MARKER = "\n…[preview truncated]"

/**
 * Take the first `maxLines` lines, then clamp to {@link PREVIEW_MAX_CHARS}.
 * The marker tells the model the text it is summarizing is partial, so it does
 * not report a truncated file as complete.
 */
export function buildPreview(lines: string[], maxLines: number): string {
  const preview = lines.slice(0, maxLines).join("\n")
  if (preview.length <= PREVIEW_MAX_CHARS) return preview
  return preview.slice(0, PREVIEW_MAX_CHARS) + TRUNCATION_MARKER
}
