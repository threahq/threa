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
  const stripped = stripMarkdown(md).replace(/\n+/g, " ")
  if (!toEmoji) return stripped
  return stripped.replace(/:([a-z0-9_+-]+):/g, (match, shortcode) => toEmoji(shortcode) ?? match)
}

/** Strip markdown formatting, returning plain text content. */
export function stripMarkdown(md: string): string {
  return (
    md
      // Remove code blocks (fenced) — extract inner content
      .replace(/```[\s\S]*?```/g, (match) => {
        const lines = match.split("\n")
        return lines.slice(1, -1).join("\n")
      })
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
      // Remove blockquotes
      .replace(/^>\s?/gm, "")
      // Remove horizontal rules
      .replace(/^---+$/gm, "")
      // Clean up extra whitespace
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  )
}
