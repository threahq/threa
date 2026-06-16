import { serializeToMarkdown } from "@threa/prosemirror"
import type { JSONContent } from "@threa/types"
import { normalizeMessage } from "../emoji"

/**
 * Derive the canonical markdown projection from `contentJson` (INV-58).
 *
 * The backend derives markdown rather than trusting a client-supplied string:
 * agents, mention-gating, search indexing, and the public-API wire all read the
 * stored markdown, so a markdown body divergent from the JSON is a content-
 * spoofing / prompt-injection vector.
 *
 * `normalizeMessage` folds raw emoji (👍) to canonical shortcodes (:+1:) so the
 * stored markdown matches what the markdown-only paths produce.
 */
export function deriveContentMarkdown(contentJson: JSONContent): string {
  return normalizeMessage(serializeToMarkdown(contentJson))
}
