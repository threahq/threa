import { normalizeRange, parseMarkdown, resolveSelectionRange } from "@threahq/prosemirror"
import type { ContentRange, JSONContent } from "@threahq/types"

/** Text a reader would see, with atoms reduced to a separator. */
export function docToPlainText(node: JSONContent): string {
  const parts: string[] = []
  const walk = (n: JSONContent): void => {
    if (n.type === "text") {
      parts.push(n.text ?? "")
      return
    }
    if (n.content) {
      for (const child of n.content) walk(child)
    }
    parts.push(" ")
  }
  walk(node)
  return parts.join("")
}

export function normalizeText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[\u00A0\u200B-\u200D\uFEFF]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * The span of `pinnedDoc` a rangeless quote is talking about, located from the
 * snippet the client stored. `null` means the snippet is not in this document;
 * `{ range: null }` means the whole document.
 *
 * The resolver turns a miss into `REFERENCE_RANGE_NOT_FOUND`; the pin backfill
 * treats it as "this is not the version that was quoted" and tries the next
 * candidate, so the decision of what a miss means stays with the caller.
 */
export function locateSnippetRange(pinnedDoc: JSONContent, snippet: unknown): { range: ContentRange | null } | null {
  if (typeof snippet !== "string") return { range: null }
  const wanted = normalizeText(docToPlainText(parseMarkdown(snippet)))
  if (wanted.length === 0) return { range: null }
  if (wanted === normalizeText(docToPlainText(pinnedDoc))) return { range: null }

  const located = resolveSelectionRange(pinnedDoc, { text: wanted })
  if (!located) return null
  return { range: normalizeRange(pinnedDoc, located) }
}
