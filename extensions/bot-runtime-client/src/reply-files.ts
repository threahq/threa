import { readFileSync, statSync } from "node:fs"
import { basename, resolve } from "node:path"
import { encryptAttachmentBytes, type AttachmentRef } from "./crypto"
import {
  findLocalFileLinks,
  fileAttachmentLink,
  redactLocalFileLinks,
  uploadEach,
  uploadLocalFileLinks,
} from "./local-images"

export interface UploadedAttachment {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
}

/** POSTs a multipart form to the workspace's attachments endpoint. */
export interface AttachmentUploader {
  uploadAttachment(form: FormData): Promise<UploadedAttachment>
}

/** A reply line `THREA_ATTACH: ./out.png` tells the runtime to upload that file and attach it to the reply. */
const ATTACH_DIRECTIVE_RE = /^THREA_ATTACH:\s*(.+?)\s*$/

/** Strip `THREA_ATTACH:` directive lines out of a reply, returning the remaining text and the paths. */
export function extractAttachmentDirectives(markdown: string): { markdown: string; paths: string[] } {
  const paths: string[] = []
  const lines = markdown.split("\n").filter((line) => {
    const match = line.match(ATTACH_DIRECTIVE_RE)
    if (!match) return true
    paths.push(match[1]!)
    return false
  })
  return { markdown: lines.join("\n").trim(), paths }
}

/** True when sending the reply would upload local files: `THREA_ATTACH:` lines, local images, or explicit deliverable links. */
export function hasReplyAttachments(markdown: string): boolean {
  return extractAttachmentDirectives(markdown).paths.length > 0 || findLocalFileLinks(markdown).length > 0
}

/** Directive lines and local file links name local paths; trace text shows that a file was attached, never where it lives. */
export function redactAttachDirectives(text: string): string {
  return redactLocalFileLinks(text.replace(/^THREA_ATTACH:\s*.+$/gm, "THREA_ATTACH: [local path omitted]"))
}

function guessMimeType(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".gif")) return "image/gif"
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".svg")) return "image/svg+xml"
  if (lower.endsWith(".html")) return "text/html"
  if (lower.endsWith(".md")) return "text/markdown"
  if (lower.endsWith(".txt")) return "text/plain"
  if (lower.endsWith(".csv")) return "text/csv"
  if (lower.endsWith(".json")) return "application/json"
  if (lower.endsWith(".mp4")) return "video/mp4"
  if (lower.endsWith(".webm")) return "video/webm"
  if (lower.endsWith(".mov")) return "video/quicktime"
  if (lower.endsWith(".mp3")) return "audio/mpeg"
  if (lower.endsWith(".wav")) return "audio/wav"
  if (lower.endsWith(".ogg")) return "audio/ogg"
  if (lower.endsWith(".pdf")) return "application/pdf"
  return "application/octet-stream"
}

function readLocalFile(path: string, cwd: string): { absolute: string; bytes: Uint8Array<ArrayBuffer> } {
  const absolute = resolve(cwd, path)
  if (!statSync(absolute).isFile()) throw new Error(`${path} is not a file`)
  return { absolute, bytes: new Uint8Array(readFileSync(absolute)) }
}

function failureNote(failed: string[]): string {
  return failed.length > 0 ? ["Attachment upload failed:", ...failed.map((f) => `- ${f}`)].join("\n") : ""
}

/**
 * Resolve a reply's local files: each local image or explicit deliverable link
 * uploads and becomes an inline `attachment:<id>` link in place, and each
 * `THREA_ATTACH:` file uploads and is listed under the reply. The backend
 * associates those links with the posted message. Upload failures surface as a
 * note rather than throwing.
 */
export async function uploadReplyAttachments(
  uploader: AttachmentUploader,
  markdown: string,
  cwd: string
): Promise<{ markdown: string; uploaded: UploadedAttachment[]; failed: string[] }> {
  const uploadFile = (path: string): Promise<UploadedAttachment> => {
    const { absolute, bytes } = readLocalFile(path, cwd)
    const form = new FormData()
    form.append("file", new Blob([bytes], { type: guessMimeType(absolute) }), basename(absolute))
    return uploader.uploadAttachment(form)
  }
  const { markdown: stripped, paths } = extractAttachmentDirectives(markdown)
  const files = await uploadLocalFileLinks(stripped, cwd, uploadFile, fileAttachmentLink)
  const directives = await uploadEach(paths, uploadFile)
  const listed = directives.uploaded.map(([, attachment]) => attachment)
  const failed = [...files.failed, ...directives.failed]
  const links = listed.length > 0 ? ["Attachments:", ...listed.map((a) => `- [${a.filename}](attachment:${a.id})`)] : []
  return {
    markdown: [files.markdown.trim(), links.join("\n"), failureNote(failed)].filter(Boolean).join("\n\n"),
    uploaded: [...files.uploaded, ...listed],
    failed,
  }
}

/**
 * Server cap on `attachmentIds` per sealed message (`sealedAttachmentIdsSchema`
 * caps at 16). Clamp before uploading: sending more ids would 400 the whole
 * completion, and the retry loop would re-send the same over-limit body forever.
 */
const MAX_SEALED_ATTACHMENTS_PER_MESSAGE = 16

/**
 * Resolve local files in SEALED output (`THREA_ATTACH:` lines and local file
 * links, which are removed from the text): encrypt each file under a
 * fresh single-use key, upload only the ciphertext (`e2e=true`, placeholder
 * name/mime), and return the refs to seal into the message payload plus the ids
 * the wire body binds to the message row. No `attachment:<id>` links are added:
 * an E2E viewer renders attachments from the sealed refs, not the markdown.
 * Upload failures surface as a note (itself sealed) rather than throwing.
 */
export async function uploadSealedReplyAttachments(
  uploader: AttachmentUploader,
  markdown: string,
  cwd: string
): Promise<{ markdown: string; refs: AttachmentRef[]; attachmentIds: string[] }> {
  const refs: AttachmentRef[] = []
  const uploadFile = async (path: string): Promise<AttachmentRef> => {
    if (refs.length >= MAX_SEALED_ATTACHMENTS_PER_MESSAGE) {
      throw new Error(`over the ${MAX_SEALED_ATTACHMENTS_PER_MESSAGE}-attachment limit for one message`)
    }
    const { absolute, bytes } = readLocalFile(path, cwd)
    const encrypted = await encryptAttachmentBytes(bytes)
    const form = new FormData()
    form.append("e2e", "true")
    // The real name and type ride only in the sealed ref.
    form.append("file", new Blob([encrypted.ciphertext], { type: "application/octet-stream" }), "encrypted")
    const uploaded = await uploader.uploadAttachment(form)
    const ref = {
      attachmentId: uploaded.id,
      key: encrypted.key,
      iv: encrypted.iv,
      filename: basename(absolute),
      mimeType: guessMimeType(absolute),
      sizeBytes: bytes.length,
    }
    refs.push(ref)
    return ref
  }
  const { markdown: stripped, paths } = extractAttachmentDirectives(markdown)
  // Explicit directives claim the capped slots before embedded images.
  const directives = await uploadEach(paths, uploadFile)
  const files = await uploadLocalFileLinks(stripped, cwd, uploadFile, () => "")
  const failed = [...directives.failed, ...files.failed]
  return {
    markdown: [files.markdown.trim(), failureNote(failed)].filter(Boolean).join("\n\n"),
    refs,
    attachmentIds: refs.map((ref) => ref.attachmentId),
  }
}
