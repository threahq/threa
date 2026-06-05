// The strip implementation moved to `@threa/types` so the backend push path
// can reuse it (INV-60 — notification bodies are stripped before they ship,
// the SW renders them verbatim). Re-exported here so existing frontend
// imports keep their `@/lib/markdown/strip` path and there's one impl, not two.
export { stripMarkdown, stripMarkdownToInline } from "@threa/types"
