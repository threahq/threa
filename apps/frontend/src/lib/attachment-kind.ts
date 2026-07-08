/** Discriminators for attachment kinds that have first-class preview support
 *  in the media gallery. Used by both the inline attachment chips and the
 *  markdown-link openAttachment dispatcher so a single source of truth decides
 *  whether a file opens in the gallery or downloads. */

interface AttachmentTypeShape {
  mimeType: string
  filename: string
}

export function isImageAttachment(a: AttachmentTypeShape): boolean {
  return a.mimeType.split(";")[0].trim().toLowerCase().startsWith("image/")
}

// Video extensions we can play from raw bytes in a <video> element. Excludes the
// ambiguous `.ts` — browsers map it to `video/mp2t`, but in this product a `.ts`
// upload is far more often a TypeScript source file, so we let the text viewer
// claim it (see the mp2t guard below).
const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|webm|mkv|avi|ogv|mpe?g|3gp|wmv|flv)$/i

/**
 * Video attachments the gallery plays in a `<video>` element. Detection is by
 * `video/*` mime with an extension fallback for files uploaded as
 * `application/octet-stream`. Unlike the timeline (which keys off the backend's
 * `processingStatus`), a freshly-picked file in the composer has no server
 * processing state yet, so classification is mime/extension-only here.
 *
 * `video/mp2t` is deliberately not treated as video: it's the mime browsers hand
 * to a `.ts` file, which is almost always TypeScript source in this codebase —
 * letting it fall through to the text viewer beats rendering a text file's bytes
 * as a broken `<video>`.
 */
export function isVideoAttachment(a: AttachmentTypeShape): boolean {
  const mime = a.mimeType.split(";")[0].trim().toLowerCase()
  if (mime === "video/mp2t") return false
  if (mime.startsWith("video/")) return true
  return VIDEO_EXTENSIONS.test(a.filename)
}

export function isMarkdownAttachment(a: AttachmentTypeShape): boolean {
  if (a.mimeType.startsWith("text/markdown") || a.mimeType === "text/x-markdown") return true
  return /\.(md|mdx|markdown)$/i.test(a.filename)
}

export function isHtmlAttachment(a: AttachmentTypeShape): boolean {
  if (a.mimeType === "text/html" || a.mimeType === "application/xhtml+xml") return true
  return /\.x?html?$/i.test(a.filename)
}

export function isPdfAttachment(a: AttachmentTypeShape): boolean {
  if (a.mimeType === "application/pdf" || a.mimeType === "application/x-pdf") return true
  return /\.pdf$/i.test(a.filename)
}

const TEXT_APPLICATION_MIMES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/x-sh",
  "application/javascript",
  "application/typescript",
  "application/x-typescript",
  "application/sql",
  "application/toml",
])

// Text/code/data extensions we can render as plain text. Kept as an explicit
// allow-list (not "any non-binary mime") so an octet-stream binary or an Office
// doc never gets fed to the text viewer as garbage.
const TEXT_PREVIEW_EXTENSIONS =
  /\.(txt|text|log|csv|tsv|json|jsonc|ndjson|ya?ml|toml|ini|cfg|conf|env|xml|sql|sh|bash|zsh|fish|ps1|bat|py|rb|go|rs|java|kt|kts|c|h|cpp|cc|cxx|hpp|hh|cs|js|jsx|mjs|cjs|ts|tsx|css|scss|sass|less|php|pl|pm|lua|r|swift|dart|scala|clj|cljs|ex|exs|erl|hs|ml|vue|svelte|astro|graphql|gql|proto|gradle|properties|diff|patch)$/i

/**
 * Text/code/data attachments that render as a plain-text preview in the gallery.
 * Excludes markdown/html/pdf, which have their own first-class viewers. Detection
 * is by mime (`text/*` plus known text-based application types) with an extension
 * fallback for files uploaded as `application/octet-stream`.
 */
export function isTextPreviewableAttachment(a: AttachmentTypeShape): boolean {
  if (isMarkdownAttachment(a) || isHtmlAttachment(a) || isPdfAttachment(a)) return false
  const mime = a.mimeType.split(";")[0].trim().toLowerCase()
  if (mime.startsWith("text/")) return true
  if (TEXT_APPLICATION_MIMES.has(mime)) return true
  return TEXT_PREVIEW_EXTENSIONS.test(a.filename)
}
