/**
 * Markdown → plain-text stripping for preview surfaces, shared between the
 * frontend (sidebar, activity feed, Saved list) and the backend (push
 * notification bodies). Notification text is built backend-side and rendered
 * by the service worker verbatim, so the strip has to happen before it ships
 * — there is no frontend render step to lean on (INV-60). Pure string work,
 * no runtime deps, so it lives in `@threa/types` where both sides import it.
 */

/**
 * Strip markdown formatting and collapse newlines to spaces.
 * Use for single-line preview surfaces (sidebar, activity feed) where the
 * source text is markdown but the surface only shows a flattened snippet.
 *
 * Pass `toEmoji` (from `useWorkspaceEmoji`) to also resolve `:shortcode:`
 * sequences into their emoji characters; unresolved shortcodes stay as text.
 */
export function stripMarkdownToInline(md: string, toEmoji?: (shortcode: string) => string | null): string {
  return resolveEmojiShortcodes(stripMarkdown(md).replace(/\n+/g, " "), toEmoji)
}

/**
 * The inline finishing pass of {@link stripMarkdownToInline}, without the
 * markdown strip. Callers that already stripped the document (and must not
 * re-interpret the result as markdown — fence-extracted code would lose its
 * `#` and `>` prefixes) use this instead of a second `stripMarkdownToInline`.
 */
export function resolveEmojiShortcodes(text: string, toEmoji?: (shortcode: string) => string | null): string {
  if (!toEmoji) return text
  return text.replace(/:([a-z0-9_+-]+):/g, (match, shortcode) => toEmoji(shortcode) ?? match)
}

const FENCE_RE = /```[\s\S]*?```/g

/** The inner lines of a fenced block, without the fence markers. */
function fenceBody(fence: string): string {
  return fence.split("\n").slice(1, -1).join("\n")
}

/** Strip markdown formatting, returning plain text content. */
export function stripMarkdown(md: string): string {
  return stripBlocks(md.replace(FENCE_RE, fenceBody)).trim()
}

/**
 * Like {@link stripMarkdown}, but code inside fenced blocks is kept verbatim —
 * a `# comment` or a `> redirect` line is code, not a heading or a blockquote.
 * Text outside the fences is stripped exactly as {@link stripMarkdown} does.
 */
export function stripMarkdownKeepingCode(md: string): string {
  let out = ""
  let last = 0
  for (const match of md.matchAll(FENCE_RE)) {
    out += stripBlocks(md.slice(last, match.index)) + fenceBody(match[0])
    last = match.index + match[0].length
  }
  return (out + stripBlocks(md.slice(last))).trim()
}

function stripBlocks(md: string): string {
  return (
    md
      // Remove headers
      .replace(/^#{1,6}\s+/gm, "")
      // Remove bold/italic
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
      // Underscores only act as emphasis when not adjacent to word characters
      // (CommonMark intra-word underscores rule). Without this guard, identifiers
      // like `:white_check_mark:` get mangled into `:whitecheckmark:`.
      .replace(/(^|[^A-Za-z0-9_])_{1,3}([^_\n]+?)_{1,3}(?![A-Za-z0-9_])/g, "$1$2")
      // Remove inline code
      .replace(/`([^`]+)`/g, "$1")
      // Remove images (before links — images use ![])
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      // Remove links but keep text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Remove blockquotes, including nested ones (`> > quoted`)
      .replace(/^(?:>[ \t]?)+/gm, "")
      // Remove horizontal rules
      .replace(/^---+$/gm, "")
      // Clean up extra whitespace
      .replace(/\n{3,}/g, "\n\n")
  )
}
