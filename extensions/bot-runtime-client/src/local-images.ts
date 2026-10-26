import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Nodes } from "mdast"
import { fromMarkdown } from "mdast-util-from-markdown"

/** A markdown image `![alt](target)` whose target is a file on this machine rather than a URL. */
export interface LocalImageLink {
  /** Offsets of the whole `![alt](target)` in the scanned markdown. */
  start: number
  end: number
  alt: string
  path: string
}

// A cheap superset of what CommonMark reads as an image: alt on one line with at most one level of brackets,
// a target with two levels of parentheses, an optional title. Each repeat has disjoint alternatives, so the scan
// stays linear and can run over every trace step.
const WS = String.raw`[ \t\r\n]`
const DEST_CHAR = String.raw`(?:\\[^ \t\r\n]|[^ \t\r\n()\\])`
const DEST = String.raw`<(?:\\.|[^\\<>\n])*>|(?:${DEST_CHAR}|\((?:${DEST_CHAR}|\(${DEST_CHAR}*\))*\))+`
const TITLE = String.raw`"(?:\\.|[^\\"\n])*"|'(?:\\.|[^\\'\n])*'|\((?:\\.|[^\\()\n])*\)`
const ALT = String.raw`(?:\\.|[^\\[\]\n]|\[(?:\\.|[^\\[\]\n])*\])*`
const IMAGE = String.raw`!\[(${ALT})\]\(${WS}*(${DEST})(?:${WS}+(?:${TITLE}))?${WS}*\)`
const IMAGE_RE = new RegExp(IMAGE, "g")
const IMAGE_SOURCE_RE = new RegExp(`^${IMAGE}$`)
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

/** The image file a raw `![…](target)` target names on this machine, or null. */
function localImagePath(rawTarget: string): string | null {
  const path = localPath(rawTarget.startsWith("<") ? rawTarget.slice(1, -1) : rawTarget)
  return path && IMAGE_FILE_RE.test(path) ? path : null
}

/** Image files embedded outside code by absolute, relative, or `file:` path. Web URLs and linked images are left alone. */
export function findLocalImageLinks(markdown: string): LocalImageLink[] {
  // A full parse costs ~20x the scan; most replies embed nothing local.
  if (![...markdown.matchAll(IMAGE_RE)].some((match) => localImagePath(match[2]!))) return []
  // micromark drops a leading BOM, so its offsets index the text after it.
  const shift = markdown.startsWith("\uFEFF") ? 1 : 0
  const links: LocalImageLink[] = []
  const visit = (node: Nodes): void => {
    if (node.type === "image") {
      const start = node.position!.start.offset! + shift
      const end = node.position!.end.offset! + shift
      // The decoded url unescapes backslashes, which would turn `C:\tmp\_a.png` into `C:\tmp_a.png`; it serves
      // only images the scan can't read, such as a multi-line alt.
      const path = localImagePath(markdown.slice(start, end).match(IMAGE_SOURCE_RE)?.[2] ?? node.url)
      if (path) links.push({ start, end, alt: node.alt ?? "", path })
      return
    }
    // An attachment link can't nest inside another link's text.
    if (node.type === "link" || node.type === "linkReference") return
    if ("children" in node) for (const child of node.children) visit(child)
  }
  visit(fromMarkdown(markdown))
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
  const label = (link.alt.replace(/\s+/g, " ").trim() || attachment.filename).replace(/[\\[\]`]/g, "\\$&")
  const metadata = new URLSearchParams({
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    sizeBytes: String(attachment.sizeBytes),
  })
  // Mirrors serializeAttachmentMetadata in @threahq/prosemirror, which is private and so not importable here.
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

/**
 * Trace text shows that an image was embedded, never where it lives on disk. Matches the scan, not the parse, so
 * images in code, HTML blocks and footnotes are hidden too; over-redacting a trace costs nothing.
 */
export function redactLocalImageLinks(markdown: string): string {
  return markdown.replace(IMAGE_RE, (image, _alt, target: string) =>
    localImagePath(target) ? "[image: local path omitted]" : image
  )
}

/** Upload each path in turn; a failure becomes `path: reason` and the rest still upload. */
export async function uploadEach<T>(
  paths: Iterable<string>,
  upload: (path: string) => Promise<T>
): Promise<{ uploaded: [string, T][]; failed: string[] }> {
  const uploaded: [string, T][] = []
  const failed: string[] = []
  for (const path of paths) {
    try {
      uploaded.push([path, await upload(path)])
    } catch (error) {
      failed.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { uploaded, failed }
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
  const { uploaded, failed } = await uploadEach(new Set(links.map((link) => link.path)), async (path) => {
    // A symlink named like an image must not carry a key or `.env` past the extension check.
    if (!IMAGE_FILE_RE.test(realpathSync(resolve(cwd, path))))
      throw new Error("it links to a file that is not an image")
    return upload(path)
  })
  const uploads = new Map(uploaded)
  const rewritten = replaceLinks(markdown, links, (link) => {
    const attachment = uploads.get(link.path)
    return attachment === undefined ? "" : render(attachment, link)
  })
  return { markdown: rewritten, uploaded: [...uploads.values()], failed }
}
