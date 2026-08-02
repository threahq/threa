// The strip implementation moved to `@threa/types` so the backend push path
// can reuse it (INV-60 — notification bodies are stripped before they ship,
// the SW renders them verbatim). Re-exported here so existing frontend
// imports keep their `@/lib/markdown/strip` path and there's one impl, not two.
export { stripMarkdown, stripMarkdownToInline } from "@threa/types"

/**
 * Truncate stripped inline text to `maxChars` code POINTS — a `.slice()` on
 * UTF-16 units cuts an emoji in half and leaves a lone surrogate before the
 * ellipsis.
 */
export function truncateInline(text: string, maxChars: number, ellipsis = "…"): string {
  const points = [...text]
  return points.length > maxChars ? points.slice(0, maxChars).join("") + ellipsis : text
}
