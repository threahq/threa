/**
 * Shared attachment category definitions.
 *
 * Maps the open-ended `mime_type` column on attachments to a small,
 * user-meaningful set of buckets. Used by:
 *   - the backend `attachments.search` repo to translate a `type:image,pdf`
 *     filter into a list of mime prefixes
 *   - the frontend explorer to render category icons / accent colors and
 *     to expose `type:` chips with stable labels
 *
 * The mapping is intentionally coarse — Office variants and OpenDocument
 * variants collapse into one category each. Anything we don't recognise
 * falls into "other".
 */

export const ATTACHMENT_CATEGORIES = [
  "image",
  "video",
  "audio",
  "pdf",
  "doc",
  "sheet",
  "slide",
  "code",
  "archive",
  "other",
] as const

export type AttachmentCategory = (typeof ATTACHMENT_CATEGORIES)[number]

const EXACT_MIME_TO_CATEGORY: Record<string, AttachmentCategory> = {
  "application/pdf": "pdf",

  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "doc",
  "application/vnd.oasis.opendocument.text": "doc",
  "application/rtf": "doc",
  "text/rtf": "doc",

  "application/vnd.ms-excel": "sheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "sheet",
  "application/vnd.oasis.opendocument.spreadsheet": "sheet",
  "text/csv": "sheet",
  "text/tab-separated-values": "sheet",

  "application/vnd.ms-powerpoint": "slide",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "slide",
  "application/vnd.oasis.opendocument.presentation": "slide",

  "application/zip": "archive",
  "application/x-zip-compressed": "archive",
  "application/x-tar": "archive",
  "application/gzip": "archive",
  "application/x-gzip": "archive",
  "application/x-bzip2": "archive",
  "application/x-7z-compressed": "archive",
  "application/x-rar-compressed": "archive",
  "application/vnd.rar": "archive",

  "application/json": "code",
  "application/xml": "code",
  "application/x-yaml": "code",
  "application/x-sh": "code",
  "application/javascript": "code",
  "application/typescript": "code",
}

const CODE_TEXT_SUFFIXES = [
  "javascript",
  "typescript",
  "x-typescript",
  "x-python",
  "x-java",
  "x-c",
  "x-c++",
  "x-csharp",
  "x-go",
  "x-rust",
  "x-ruby",
  "x-shellscript",
  "x-sql",
  "yaml",
  "x-yaml",
  "xml",
  "html",
  "css",
  "markdown",
]

/**
 * Resolve a mime type string to an attachment category.
 * Comparison is case-insensitive on the type + subtype; parameters
 * (e.g. `; charset=utf-8`) are ignored.
 */
export function categoryFromMime(mime: string | null | undefined): AttachmentCategory {
  if (!mime) return "other"
  const normalized = mime.split(";")[0].trim().toLowerCase()
  if (!normalized) return "other"

  const exact = EXACT_MIME_TO_CATEGORY[normalized]
  if (exact) return exact

  if (normalized.startsWith("image/")) return "image"
  if (normalized.startsWith("video/")) return "video"
  if (normalized.startsWith("audio/")) return "audio"

  if (normalized.startsWith("text/")) {
    const subtype = normalized.slice("text/".length)
    if (CODE_TEXT_SUFFIXES.includes(subtype)) return "code"
    return "doc"
  }

  return "other"
}

/**
 * Mime prefixes used by SQL LIKE queries to match a category. Built once
 * from `EXACT_MIME_TO_CATEGORY` plus a small per-category set of "extras"
 * — wildcard prefixes for media (`image/%`, etc.) and the `text/*` mimes
 * that `categoryFromMime` resolves via fallback rules. Single source of
 * truth keeps SQL filtering aligned with frontend categorisation.
 */
const CATEGORY_PREFIX_EXTRAS: Record<AttachmentCategory, string[]> = {
  image: ["image/%"],
  video: ["video/%"],
  audio: ["audio/%"],
  pdf: [],
  doc: ["text/plain"],
  sheet: [],
  slide: [],
  code: CODE_TEXT_SUFFIXES.map((suffix) => `text/${suffix}`),
  archive: [],
  other: [],
}

const CATEGORY_TO_PREFIXES: Record<AttachmentCategory, string[]> = (() => {
  const map = Object.fromEntries(ATTACHMENT_CATEGORIES.map((c) => [c, [...CATEGORY_PREFIX_EXTRAS[c]]])) as Record<
    AttachmentCategory,
    string[]
  >
  for (const [mime, category] of Object.entries(EXACT_MIME_TO_CATEGORY)) {
    map[category].push(mime)
  }
  return map
})()

export function mimePrefixesForCategory(category: AttachmentCategory): string[] {
  return CATEGORY_TO_PREFIXES[category]
}

const AUDIO_EXTENSIONS = [
  "mp3",
  "m4a",
  "m4b",
  "aac",
  "wav",
  "flac",
  "ogg",
  "oga",
  "opus",
  "aif",
  "aiff",
  "aifc",
  "wma",
  "amr",
  "caf",
  "weba",
  "mka",
]

/**
 * Mime wins when it names audio; an empty or generic octet-stream mime falls
 * back to the extension, since some clients upload audio without a type.
 */
export function isAudioAttachment(mimeType: string | null | undefined, filename: string): boolean {
  const normalized = (mimeType ?? "").split(";")[0].trim().toLowerCase()
  if (normalized.startsWith("audio/")) return true
  if (normalized !== "" && normalized !== "application/octet-stream") return false
  const ext = filename.toLowerCase().split(".").pop()
  return ext !== undefined && filename.includes(".") && AUDIO_EXTENSIONS.includes(ext)
}
