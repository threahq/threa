import { normalizeRange, resolveSelectionRange, serializeToMarkdown, sliceContent } from "@threa/prosemirror"
import type { ContentRange, JSONContent } from "@threa/types"

/** A rendered text selection, as the DOM reports it. */
export interface QuoteSelection {
  text: string
  /** Rendered text between the message body's start and the selection's start. */
  prefixText: string
}

/** The reference fields a quote trigger sends alongside the author metadata. */
export interface QuotePin {
  version: number | null
  range: ContentRange | null
  snippet: string
}

/** The rendered message a selection was made in, as the timeline holds it. */
export interface QuoteSource {
  contentJson?: JSONContent | null
  revision?: number | null
  contentMarkdown?: string | null
}

export interface PartialQuoteInput {
  contentJson: JSONContent
  revision: number | null
  selectionText: string
  prefixText?: string
}

/**
 * Map a selection back to a span of the message it was rendered from, or `null`
 * when it can't be located. The snippet is derived the same way the server
 * derives the one it stores, so the composer chip shows what will be sent.
 */
export function buildPartialQuote(input: PartialQuoteInput): QuotePin | null {
  const located = resolveSelectionRange(input.contentJson, {
    text: input.selectionText,
    prefixText: input.prefixText,
  })
  if (!located) return null

  const range = normalizeRange(input.contentJson, located)
  const slice = range ? sliceContent(input.contentJson, range.from, range.to) : input.contentJson
  return { version: input.revision, range, snippet: serializeToMarkdown(slice) }
}

/**
 * The pin every selection-driven quote trigger sends. Three outcomes, all valid
 * to the server: the located span; the whole pinned message when the selection
 * can't be mapped (the chip shows the fallback, so it isn't silent); and the
 * lenient unpinned form when the row's content isn't in reach — the server then
 * locates the snippet itself or rejects the send.
 */
export function resolveQuoteSelection(source: QuoteSource | null, selection: QuoteSelection): QuotePin {
  const contentJson = source?.contentJson
  if (!contentJson) return { version: null, range: null, snippet: selection.text }

  const revision = source?.revision ?? null
  const partial = buildPartialQuote({
    contentJson,
    revision,
    selectionText: selection.text,
    prefixText: selection.prefixText,
  })
  if (partial) return partial

  return { version: revision, range: null, snippet: source?.contentMarkdown ?? selection.text }
}
