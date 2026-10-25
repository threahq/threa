import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** A markdown image `![alt](target)` whose target is a file on this machine rather than a URL. */
export interface LocalImageLink {
  /** Offsets of the whole `![alt](target)` in the scanned markdown. */
  start: number
  end: number
  alt: string
  path: string
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
const QUOTE_PREFIX_RE = /^(?: {0,3}> ?)*/
const INDENT_RE = /^(?: {4}| {0,3}\t)/
// Alt stays on one line and holds no bare `[`, so a stray `![` can't swallow the prose up to a later image.
const IMAGE_RE =
  /(?<!\\)!\[((?:\\.|[^\\[\]\n])*)\]\(\s*(<[^>\n]*>|(?:[^\s()]|\([^\s()]*\))+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i
const WINDOWS_DRIVE_RE = /^[a-z]:[\\/]/i
// Agents echo `![](…)` from READMEs and tool output; only image files may upload, never a key or `.env`.
const IMAGE_FILE_RE = /\.(?:png|jpe?g|gif|webp|svg)$/i

function localPath(target: string): string | null {
  if (target.startsWith("//") || target.startsWith("#")) return null
  if (WINDOWS_DRIVE_RE.test(target) || !SCHEME_RE.test(target)) return target
  if (!/^file:/i.test(target)) return null
  try {
    return fileURLToPath(target)
  } catch {
    return null
  }
}

function blank(text: string): string {
  return " ".repeat(text.length)
}

function maskCodeSpans(line: string): string {
  let out = ""
  let i = 0
  while (i < line.length) {
    if (line[i] !== "`") {
      out += line[i]
      i++
      continue
    }
    let openEnd = i
    while (line[openEnd] === "`") openEnd++
    const ticks = openEnd - i
    let close = -1
    for (let j = openEnd; j < line.length && close === -1; ) {
      if (line[j] !== "`") {
        j++
        continue
      }
      let runEnd = j
      while (line[runEnd] === "`") runEnd++
      if (runEnd - j === ticks) close = j
      j = runEnd
    }
    if (close === -1) {
      out += line.slice(i, openEnd)
      i = openEnd
      continue
    }
    out += blank(line.slice(i, close + ticks))
    i = close + ticks
  }
  return out
}

/**
 * Same-length copy with fenced blocks, indented code and inline code spans
 * blanked, so offsets still index the original. Fences inside blockquotes
 * count; an indented list paragraph reads as code, which only leaves its
 * image unrewritten.
 */
function maskCode(markdown: string): string {
  let fence: string | null = null
  let indented = false
  let previousBlank = true
  return markdown
    .split("\n")
    .map((line) => {
      const body = line.slice(line.match(QUOTE_PREFIX_RE)![0].length)
      const isBlank = body.trim() === ""
      const marker = body.match(FENCE_RE)?.[1]
      let code: boolean
      if (fence) {
        if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length && body.trim() === marker) {
          fence = null
        }
        code = true
      } else if (marker) {
        fence = marker
        code = true
      } else {
        if (!isBlank) indented = INDENT_RE.test(body) && (previousBlank || indented)
        code = indented
      }
      previousBlank = isBlank
      return code ? blank(line) : maskCodeSpans(line)
    })
    .join("\n")
}

/**
 * Per offset, how many link texts enclose it: a `[`…`]` closed on the same line and followed by `(` or `[`,
 * other than an image's own alt. `[see ![x](a.png)](url)` puts the image in a link's text, and an attachment
 * link can't nest inside another link.
 */
function linkTextDepth(markdown: string): Int32Array {
  const depth = new Int32Array(markdown.length + 1)
  let open: number[] = []
  for (let i = 0; i < markdown.length; i++) {
    const char = markdown[i]
    if (char === "\\" && markdown[i + 1] !== "\n") i++
    else if (char === "\n") open = []
    else if (char === "[") open.push(i)
    else if (char === "]") {
      const start = open.pop()
      if (start !== undefined && markdown[start - 1] !== "!" && (markdown[i + 1] === "(" || markdown[i + 1] === "[")) {
        depth[start + 1]!++
        depth[i]!--
      }
    }
  }
  for (let i = 1; i < depth.length; i++) depth[i]! += depth[i - 1]!
  return depth
}

/** Image files embedded outside code by absolute, relative, or `file:` path. Web URLs and linked images are left alone. */
export function findLocalImageLinks(markdown: string): LocalImageLink[] {
  const links: LocalImageLink[] = []
  const masked = maskCode(markdown)
  const inLinkText = linkTextDepth(masked)
  for (const match of masked.matchAll(IMAGE_RE)) {
    const start = match.index
    const end = start + match[0].length
    // A match that straddles masked code reads differently in the original; it is not a real image.
    if (markdown.slice(start, end) !== match[0]) continue
    if (inLinkText[start]! > 0) continue
    const raw = match[2]!
    const path = localPath(raw.startsWith("<") ? raw.slice(1, -1) : raw)
    if (path && IMAGE_FILE_RE.test(path)) links.push({ start, end, alt: match[1]!, path })
  }
  return links
}

/**
 * An inline `attachment:` link for an uploaded image, labelled by its alt text
 * or else its filename, with the `threa-attachment:` title Threa reads the
 * chip's filename and type from.
 */
export function imageAttachmentLink(
  attachment: { id: string; filename: string; mimeType: string; sizeBytes: number },
  link: Pick<LocalImageLink, "alt">
): string {
  // A link label can't span lines or hold a bare bracket; either leaves plain text and the upload never binds.
  const alt = link.alt
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\\.|[[\]]/g, (match) => (match.length === 2 ? match : `\\${match}`))
  const label = alt || attachment.filename.replace(/[\\[\]]/g, "\\$&")
  const metadata = new URLSearchParams({
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    sizeBytes: String(attachment.sizeBytes),
  })
  const title = `threa-attachment:${metadata}`.replace(/[\\"]/g, "\\$&")
  return `[${label}](attachment:${attachment.id} "${title}")`
}

function replaceLinks(markdown: string, links: LocalImageLink[], replace: (link: LocalImageLink) => string): string {
  let out = ""
  let cursor = 0
  for (const link of links) {
    out += markdown.slice(cursor, link.start) + replace(link)
    cursor = link.end
  }
  return out + markdown.slice(cursor)
}

/** Trace text shows that an image was embedded, never where it lives on disk. */
export function redactLocalImageLinks(markdown: string): string {
  return replaceLinks(markdown, findLocalImageLinks(markdown), () => "[image: local path omitted]")
}

/**
 * Upload every local image file the markdown embeds, resolved against `cwd`, and replace each
 * `![alt](path)` with `render(uploaded, link)`. A path embedded twice uploads
 * once. A failed upload removes the image and reports `path: reason`, the
 * same shape as a failed `THREA_ATTACH:`.
 */
export async function uploadLocalImageLinks<T>(
  markdown: string,
  cwd: string,
  upload: (path: string) => Promise<T>,
  render: (uploaded: T, link: LocalImageLink) => string
): Promise<{ markdown: string; uploaded: T[]; failed: string[] }> {
  const links = findLocalImageLinks(markdown)
  const uploads = new Map<string, T>()
  const failed: string[] = []
  for (const path of new Set(links.map((link) => link.path))) {
    try {
      // A symlink named like an image must not carry a key or `.env` past the extension check.
      if (!IMAGE_FILE_RE.test(realpathSync(resolve(cwd, path))))
        throw new Error("it links to a file that is not an image")
      uploads.set(path, await upload(path))
    } catch (error) {
      failed.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const rewritten = replaceLinks(markdown, links, (link) => {
    const uploaded = uploads.get(link.path)
    return uploaded === undefined ? "" : render(uploaded, link)
  })
  return { markdown: rewritten, uploaded: [...uploads.values()], failed }
}
