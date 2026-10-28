const ATTACHMENT_METADATA_PREFIX = "threa-attachment:"
const NON_NEGATIVE_INTEGER_PATTERN = /^\d+$/

export interface ParsedAttachmentMetadata {
  filename?: string
  mimeType?: string
  sizeBytes: number | null
  display?: "inline"
}

function parseNonNegativeSafeInteger(rawValue: string | null): number | null {
  if (!rawValue || !NON_NEGATIVE_INTEGER_PATTERN.test(rawValue)) {
    return null
  }

  const parsed = Number(rawValue)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export function escapeMarkdownLinkText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]")
}

export function unescapeMarkdownLinkText(value: string): string {
  return value.replace(/\\([\[\]\\])/g, "$1")
}

export function escapeMarkdownLinkTitle(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

export function unescapeMarkdownLinkTitle(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\")
}

export function serializeAttachmentMetadata(attrs: Record<string, unknown> | undefined): string {
  if (!attrs) return ""

  const params = new URLSearchParams()
  if (typeof attrs.filename === "string" && attrs.filename.length > 0) {
    params.set("filename", attrs.filename)
  }
  if (typeof attrs.mimeType === "string" && attrs.mimeType.length > 0) {
    params.set("mimeType", attrs.mimeType)
  }
  if (typeof attrs.sizeBytes === "number" && Number.isSafeInteger(attrs.sizeBytes) && attrs.sizeBytes >= 0) {
    params.set("sizeBytes", String(attrs.sizeBytes))
  }
  if (attrs.display === "inline") {
    params.set("display", "inline")
  }

  const encoded = params.toString()
  if (!encoded) return ""
  return ` "${escapeMarkdownLinkTitle(`${ATTACHMENT_METADATA_PREFIX}${encoded}`)}"`
}

export function parseAttachmentMetadata(rawTitle: string | undefined): ParsedAttachmentMetadata {
  if (!rawTitle) {
    return { sizeBytes: null }
  }

  const title = unescapeMarkdownLinkTitle(rawTitle)
  if (!title.startsWith(ATTACHMENT_METADATA_PREFIX)) {
    return { sizeBytes: null }
  }

  const params = new URLSearchParams(title.slice(ATTACHMENT_METADATA_PREFIX.length))

  return {
    filename: params.get("filename") ?? undefined,
    mimeType: params.get("mimeType") ?? undefined,
    sizeBytes: parseNonNegativeSafeInteger(params.get("sizeBytes")),
    display: params.get("display") === "inline" ? "inline" : undefined,
  }
}
