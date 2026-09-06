import { normalizeRange, resolveSelectionRange, serializeToMarkdown, sliceContent } from "@threahq/prosemirror"
import type { ContentRange, JSONContent } from "@threahq/types"

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
  // Positions only mean something inside a known revision, and the wire form
  // refuses a range without one — a row cached before revisions shipped has the
  // body but not the number, so it takes the lenient path instead.
  if (input.revision === null) return null

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

/** What a share trigger needs from a selection: the pin, and what it will show. */
export interface SharePin {
  version: number | null
  range: ContentRange | null
  /** Markdown of exactly what the share will render, or null when out of reach. */
  previewMarkdown: string | null
}

/**
 * The pin a selection-driven share sends. Same three outcomes as
 * {@link resolveQuoteSelection}, except a share stores no body: an unlocatable
 * selection falls back to the whole message rather than to a snippet the server
 * would have to locate, and the preview markdown is what the picker shows so the
 * fallback is never silent. A range needs a revision to mean anything, so a row
 * whose revision is unknown shares whole.
 */
export function resolveShareSelection(source: QuoteSource | null, selection: QuoteSelection): SharePin {
  const contentJson = source?.contentJson
  const revision = source?.revision ?? null
  const whole: SharePin = { version: revision, range: null, previewMarkdown: source?.contentMarkdown ?? null }
  if (!contentJson || revision === null) return whole

  const partial = buildPartialQuote({
    contentJson,
    revision,
    selectionText: selection.text,
    prefixText: selection.prefixText,
  })
  if (!partial || !partial.range) return whole
  return { version: revision, range: partial.range, previewMarkdown: partial.snippet }
}
