import { sliceContent } from "@threa/prosemirror"
import type { ContentRange, JSONContent } from "@threa/types"

import { deriveContentMarkdown } from "../content"

export interface ReferenceContent {
  contentJson: JSONContent
  contentMarkdown: string
}

/**
 * The body a reference points at: the whole pinned version, or the span of it
 * the reference names. Pure — the resolver derives a quote's stored snippet
 * with it, hydration serves a share's card body with it, and the pin backfill
 * re-derives legacy snippets with it, so all three agree byte for byte.
 */
export function sliceReferenceContent(contentJson: JSONContent, range: ContentRange | null): ReferenceContent {
  const sliced = range ? sliceContent(contentJson, range.from, range.to) : contentJson
  return { contentJson: sliced, contentMarkdown: deriveContentMarkdown(sliced) }
}
