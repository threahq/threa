import { ExtractionContentTypes, type ExtractionContentType } from "@threahq/types"

/**
 * Content types whose AI-generated summary is too generic to make embedding
 * worthwhile. A casual photo's summary ("a sunset over mountains") doesn't
 * disambiguate one photo from the next, so semantic recall is no better than
 * filename FTS — and we'd be paying per-attachment embedding cost for no gain.
 *
 * Charts, tables, diagrams, screenshots, and documents (the typical PDF/Word
 * extraction shape) all carry domain-specific summaries and stay eligible.
 */
const INELIGIBLE_CONTENT_TYPES = new Set<ExtractionContentType>([
  ExtractionContentTypes.PHOTO,
  ExtractionContentTypes.OTHER,
])

/**
 * Whether an extraction's `content_type` warrants generating a summary
 * embedding. Used by both the outbox handler (short-circuit before enqueue)
 * and the worker (defensive — content_type can change between enqueue and
 * execution if an extraction is reprocessed).
 */
export function isContentTypeEmbeddable(contentType: ExtractionContentType): boolean {
  return !INELIGIBLE_CONTENT_TYPES.has(contentType)
}

/**
 * Minimum summary length to bother embedding. Anything shorter is almost
 * always a stub like "Image" or "Document" and produces near-zero-info
 * vectors. Mirrors the message embedding worker's threshold.
 */
export const MIN_SUMMARY_LENGTH = 10
