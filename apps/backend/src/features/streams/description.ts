import { parseMarkdown, serializeToMarkdown } from "@threa/prosemirror"
import { type JSONContent, type ThreaDocument, validateContent } from "@threa/types"
import { normalizeMessage, toEmoji } from "../emoji"

export interface StreamDescriptionInput {
  /** Markdown description (external/public-API wire); parsed to ProseMirror. */
  description?: string
  /** Rich-text description (ProseMirror); the canonical internal input. */
  descriptionJson?: JSONContent
}

export interface NormalizedStreamDescription {
  /** Markdown projection for the `description` column (search + wire). */
  description: string | null
  /** Canonical ProseMirror for the `description_json` column. */
  descriptionJson: ThreaDocument | null
}

/**
 * Resolve a description create/update into the canonical pair stored on a
 * stream: `descriptionJson` (ProseMirror) plus its derived markdown projection.
 * Mirrors the message content pipeline (INV-58) — the markdown is always derived
 * from the JSON, never trusted from the client, so the two columns can't diverge
 * and the markdown-only readers (search, public-API wire) stay consistent.
 *
 * Returns `undefined` when the caller supplied neither field — the description
 * is left untouched. An empty document (or empty markdown) resolves to
 * `{ description: null, descriptionJson: null }`, clearing the description.
 */
export function normalizeStreamDescription(input: StreamDescriptionInput): NormalizedStreamDescription | undefined {
  let json: JSONContent
  if (input.descriptionJson !== undefined) {
    json = input.descriptionJson
  } else if (input.description !== undefined) {
    json = parseMarkdown(normalizeMessage(input.description), undefined, toEmoji)
  } else {
    return undefined
  }

  const markdown = normalizeMessage(serializeToMarkdown(json))
  if (!markdown.trim()) {
    return { description: null, descriptionJson: null }
  }
  return { description: markdown, descriptionJson: validateContent(json) }
}
