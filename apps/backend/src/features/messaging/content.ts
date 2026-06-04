import { serializeToMarkdown } from "@threa/prosemirror"
import type { JSONContent } from "@threa/types"
import { normalizeMessage } from "../emoji"

/**
 * Derive the canonical markdown projection from `contentJson`.
 *
 * `contentJson` is the canonical message content (INV-58); markdown is a
 * serialization of it. For any path where a client authored `contentJson`, the
 * backend derives the markdown itself rather than trusting a client-supplied
 * markdown string. Trusting client markdown lets it diverge from the JSON:
 * humans render `contentJson`, but agents, mention-gating, search indexing, and
 * the public-API wire all read the stored markdown, so a divergent markdown
 * body is a content-spoofing / prompt-injection vector. The markdown-only
 * inbound paths (public API, AI integrations) are unaffected — there markdown
 * is the sole input and JSON is parsed from it.
 *
 * `normalizeMessage` folds raw emoji (👍) to canonical shortcodes (:+1:) so the
 * stored markdown matches what the markdown-only paths produce.
 */
export function deriveContentMarkdown(contentJson: JSONContent): string {
  return normalizeMessage(serializeToMarkdown(contentJson))
}
