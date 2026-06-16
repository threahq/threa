/**
 * Heuristics for deciding when a pasted blob is "too large to reasonably live
 * inside a message" and should become a snippet attachment instead of inline
 * text. Kept as a pure module (no React) so the rich-editor paste handler and
 * the unit tests share one source of truth (INV-33).
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

/** Default filename for the Nth snippet pasted into a given editor session. */
export function defaultSnippetFilename(index: number): string {
  return `snippet-${index}.txt`
}

/** Filename used when the snippet's name field is left blank on save. */
export const SNIPPET_FALLBACK_FILENAME = "snippet.txt"
