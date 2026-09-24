import { createWriteStream, existsSync, rmSync, statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { once } from "node:events"
import { finished } from "node:stream/promises"
import { basename, extname, join } from "node:path"
import { getAttachment, getAttachmentContent, getAttachmentDownloadUrl, search, uploadAttachment } from "../ops"
import { arrayFlag, boolFlag, intFlag, stringFlag, UsageError, type NounSpec, type VerbSpec } from "../output"
import { renderSearchResult } from "./search"

const listVerb: VerbSpec = {
  name: "list",
  summary: "List the most recent attachments, optionally scoped to streams",
  usage: "threa attachments list [--stream ref]... [--limit n]",
  help:
    "threa attachments list [flags]\n\n" +
    "Browse accessible attachments, newest first (a query-less attachment search). Filter by content with " +
    "`threa search --what attachments`.\n\n" +
    "Flags:\n" +
    "  --stream ref   limit to a source stream (stream_ id or #slug); repeatable\n" +
    "  --limit n      max results, <= 50 (default 20)\n" +
    "  --json         force JSON output\n" +
    "  --help         show this help",
  options: {
    stream: { type: "string", multiple: true },
    limit: { type: "string" },
  },
  run: (ctx, _positionals, values) =>
    search(ctx.client, ctx.resolver, {
      what: "attachments",
      stream_ids: arrayFlag(values, "stream"),
      limit: intFlag(values, "limit"),
    }),
  render: (payload) => {
    const rows = (payload as { data?: Array<Record<string, unknown>> }).data ?? []
    return rows.map(renderSearchResult).join("\n") || "(no attachments)"
  },
}

const getVerb: VerbSpec = {
  name: "get",
  summary: "Get an attachment's metadata and extracted text, or a signed download URL",
  usage: "threa attachments get <id> [--url]",
  help:
    "threa attachments get <id> [flags]\n\n" +
    "Retrieve an attachment's metadata and extracted text. With --url, instead return a short-lived signed URL " +
    "to download the raw bytes.\n\n" +
    "Flags:\n" +
    "  --url     return a short-lived signed download URL instead of the metadata/text\n" +
    "  --json    force JSON output\n" +
    "  --help    show this help",
  options: {
    url: { type: "boolean" },
  },
  run: (ctx, positionals, values) => {
    const id = positionals[0]
    if (!id) throw new UsageError("attachments get requires a <id> (an att_ id)")
    return boolFlag(values, "url") ? getAttachmentDownloadUrl(ctx.client, id) : getAttachment(ctx.client, id)
  },
}

/**
 * Directory destinations name the file after the attachment and never clobber:
 * an existing `report.pdf` yields `report (1).pdf`, Chrome-style. An explicit
 * file destination is taken literally and overwritten.
 */
export function resolveDownloadTarget(destination: string, filename: string): string {
  const isDir = destination.endsWith("/") || (existsSync(destination) && statSync(destination).isDirectory())
  if (!isDir) return destination
  const ext = extname(filename)
  const stem = basename(filename, ext)
  let candidate = join(destination, filename)
  for (let n = 1; existsSync(candidate); n++) {
    candidate = join(destination, `${stem} (${n})${ext}`)
  }
  return candidate
}

const DOWNLOAD_IDLE_MS = 30_000

/** Writes the body to target, failing and removing the partial file once no bytes arrive for idleMs. */
export async function saveDownload(body: ReadableStream<Uint8Array>, target: string, idleMs = DOWNLOAD_IDLE_MS) {
  // A read loop, not stream.pipeline: Bun's pipeline never settles when a web-stream source stalls, even once destroyed.
  const reader = body.getReader()
  const out = createWriteStream(target)
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`download stalled: no bytes for ${idleMs}ms`)), idleMs)
      })
      const chunk = await Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer))
      if (chunk.done) break
      if (!out.write(chunk.value)) await once(out, "drain")
    }
    out.end()
    await finished(out)
  } catch (error) {
    void reader.cancel().catch(() => {})
    out.destroy()
    rmSync(target, { force: true })
    throw error
  }
}

const downloadVerb: VerbSpec = {
  name: "download",
  summary: "Download an attachment's raw bytes to a local file",
  usage: "threa attachments download <id> [destination]",
  help:
    "threa attachments download <id> [destination] [flags]\n\n" +
    "Download the attachment's raw bytes. destination defaults to the current directory. " +
    "A directory destination names the file after the attachment and picks `name (1).ext` on conflict; an " +
    "explicit file path is written as given (overwriting).\n\n" +
    "Flags:\n" +
    "  --json    force JSON output\n" +
    "  --help    show this help",
  options: {},
  run: async (ctx, positionals) => {
    const id = positionals[0]
    if (!id) throw new UsageError("attachments download requires a <id> (an att_ id)")
    const [meta, response] = await Promise.all([
      getAttachment(ctx.client, id) as Promise<{ data?: { filename?: string } }>,
      getAttachmentContent(ctx.client, id),
    ])
    if (!response.body) throw new Error(`download failed: empty body for ${id}`)
    const target = resolveDownloadTarget(positionals[1] ?? ".", meta.data?.filename ?? id)
    await saveDownload(response.body, target)
    return { downloaded: true, id, path: target, sizeBytes: statSync(target).size }
  },
  render: (payload) => {
    const p = payload as { id?: string; path?: string; sizeBytes?: number }
    return `downloaded ${p.id ?? "?"} → ${p.path ?? "?"} (${p.sizeBytes ?? 0} bytes)`
  },
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
}

const uploadVerb: VerbSpec = {
  name: "upload",
  summary: "Upload a local file as an attachment",
  usage: "threa attachments upload <path> [--name filename] [--type mime]",
  help:
    "threa attachments upload <path> [flags]\n\n" +
    "Upload a file and print its attachment id. Reference it in message markdown as `[name](attachment:<id>)` " +
    "to attach it. The content type is guessed from the extension, else application/octet-stream.\n\n" +
    "Flags:\n" +
    "  --name filename   filename to store (default: the file's basename)\n" +
    "  --type mime       content type to store, overriding the guess\n" +
    "  --json            force JSON output\n" +
    "  --help            show this help",
  options: {
    name: { type: "string" },
    type: { type: "string" },
  },
  run: async (ctx, positionals, values) => {
    const path = positionals[0]
    if (!path) throw new UsageError("attachments upload requires a <path>")
    const filename = stringFlag(values, "name") ?? basename(path)
    const type =
      stringFlag(values, "type") ?? MIME_BY_EXTENSION[extname(filename).toLowerCase()] ?? "application/octet-stream"
    return uploadAttachment(ctx.client, new Blob([await readFile(path)], { type }), filename)
  },
  render: (payload) => {
    const a = (payload as { data?: { id?: string; filename?: string; sizeBytes?: number } }).data ?? {}
    return `uploaded ${a.filename ?? "?"} → ${a.id ?? "?"} (${a.sizeBytes ?? 0} bytes)`
  },
}

export const attachmentsNoun: NounSpec = {
  name: "attachments",
  summary: "List attachments, get one's text or URL, download its bytes, or upload a file",
  verbs: [listVerb, getVerb, downloadVerb, uploadVerb],
}
