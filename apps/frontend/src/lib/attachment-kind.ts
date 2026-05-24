/** Discriminators for attachment kinds that have first-class preview support
 *  in the media gallery. Used by both the inline attachment chips and the
 *  markdown-link openAttachment dispatcher so a single source of truth decides
 *  whether a file opens in the gallery or downloads. */

interface AttachmentTypeShape {
  mimeType: string
  filename: string
}

export function isMarkdownAttachment(a: AttachmentTypeShape): boolean {
  if (a.mimeType.startsWith("text/markdown") || a.mimeType === "text/x-markdown") return true
  return /\.(md|mdx|markdown)$/i.test(a.filename)
}

export function isHtmlAttachment(a: AttachmentTypeShape): boolean {
  if (a.mimeType === "text/html" || a.mimeType === "application/xhtml+xml") return true
  return /\.x?html?$/i.test(a.filename)
}
