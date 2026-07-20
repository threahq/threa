import { existsSync, statSync } from "node:fs"
import { basename, extname, join } from "node:path"
import { getAttachment, getAttachmentDownloadUrl, search } from "../ops"
import { arrayFlag, boolFlag, intFlag, UsageError, type NounSpec, type VerbSpec } from "../output"
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

const downloadVerb: VerbSpec = {
  name: "download",
  summary: "Download an attachment's raw bytes to a local file",
  usage: "threa attachments download <id> [destination]",
  help:
    "threa attachments download <id> [destination] [flags]\n\n" +
    "Download the attachment's raw bytes via its signed URL. destination defaults to the current directory. " +
    "A directory destination names the file after the attachment and picks `name (1).ext` on conflict; an " +
    "explicit file path is written as given (overwriting).\n\n" +
    "Flags:\n" +
    "  --json    force JSON output\n" +
    "  --help    show this help",
  options: {},
  run: async (ctx, positionals) => {
    const id = positionals[0]
    if (!id) throw new UsageError("attachments download requires a <id> (an att_ id)")
    const [meta, urlResp] = await Promise.all([
      getAttachment(ctx.client, id) as Promise<{ data?: { filename?: string } }>,
      getAttachmentDownloadUrl(ctx.client, id) as Promise<{ data?: { url?: string } }>,
    ])
    const url = urlResp.data?.url
    if (!url) throw new Error(`no download URL returned for ${id}`)
    const target = resolveDownloadTarget(positionals[1] ?? ".", meta.data?.filename ?? id)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
    const bytes = await Bun.write(target, response)
    return { downloaded: true, id, path: target, sizeBytes: bytes }
  },
  render: (payload) => {
    const p = payload as { id?: string; path?: string; sizeBytes?: number }
    return `downloaded ${p.id ?? "?"} → ${p.path ?? "?"} (${p.sizeBytes ?? 0} bytes)`
  },
}

export const attachmentsNoun: NounSpec = {
  name: "attachments",
  summary: "List attachments, get one's text or URL, or download its bytes",
  verbs: [listVerb, getVerb, downloadVerb],
}
