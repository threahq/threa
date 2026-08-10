import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { decryptAttachmentBytes, encryptAttachmentBytes, type AttachmentRef } from "@threa/bot-runtime-client"
import type { AttachmentSummary, StreamMessageSummary, ThreaClient } from "./client"

/** A reply line `THREA_ATTACH: ./out.png` tells the channel to upload that file and attach it to the reply. */
export const ATTACH_DIRECTIVE_RE = /^THREA_ATTACH:\s*(.+?)\s*$/
/** Inbound attachments land under `<cwd>/.threa-attachments/<invocationId>/`, fresh per turn. */
export const ATTACHMENT_DIR = ".threa-attachments"

export interface SelectedAttachment {
  attachment: AttachmentSummary
  messageId: string
  /** True when the attachment is on the message that triggered this turn. */
  isSource: boolean
}

export interface DownloadedAttachment extends SelectedAttachment {
  localPath: string
}

// --- Pure helpers ---------------------------------------------------------

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

export function guessMimeType(path: string): string {
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
  if (lower.endsWith(".pdf")) return "application/pdf"
  return "application/octet-stream"
}

export function safeFilename(filename: string): string {
  return filename.replace(/[\\/:*?"<>|]/g, "_").slice(0, 180) || "attachment"
}

/**
 * Pick the attachments worth downloading: those on the source message (the
 * request) plus any on the history messages Claude is being shown. De-duplicated
 * by attachment id, source first so the manifest leads with the current request.
 */
export function selectInboundAttachments(
  messages: StreamMessageSummary[],
  sourceMessageId: string,
  contextMessageIds: readonly string[]
): SelectedAttachment[] {
  const inScope = new Set<string>([sourceMessageId, ...contextMessageIds])
  // Process the source message first so it leads the manifest and so a file
  // shared with an older context message keeps its source marker regardless of
  // the order the stream listing returned.
  const ordered = [...messages].sort((a, b) => Number(b.id === sourceMessageId) - Number(a.id === sourceMessageId))
  const seen = new Set<string>()
  const selected: SelectedAttachment[] = []
  for (const message of ordered) {
    if (!inScope.has(message.id)) continue
    for (const attachment of message.attachments ?? []) {
      if (seen.has(attachment.id)) continue
      seen.add(attachment.id)
      selected.push({ attachment, messageId: message.id, isSource: message.id === sourceMessageId })
    }
  }
  return selected
}

/** The block appended to the channel event so Claude knows where the files landed. */
export function formatInboundAttachmentManifest(downloaded: DownloadedAttachment[]): string {
  if (downloaded.length === 0) return ""
  const lines = downloaded.map((entry) => {
    const marker = entry.isSource ? " [attached to the message you just received]" : ""
    const { filename, mimeType, sizeBytes } = entry.attachment
    return `- ${filename} (${mimeType}, ${sizeBytes} bytes) → ${entry.localPath}${marker}`
  })
  return ["Attachments saved into this session's working directory — read them from these paths:", ...lines].join("\n")
}

/** The attachment links / failure notes appended to an outbound reply. */
export function buildReplyAttachmentSection(uploaded: AttachmentSummary[], failed: string[]): string {
  const parts: string[] = []
  if (uploaded.length > 0) {
    parts.push(["Attachments:", ...uploaded.map((a) => `- [${a.filename}](attachment:${a.id})`)].join("\n"))
  }
  if (failed.length > 0) {
    parts.push(["Attachment upload failed:", ...failed.map((f) => `- ${f}`)].join("\n"))
  }
  return parts.join("\n\n")
}

// --- IO orchestration -----------------------------------------------------

const DOWNLOAD_TIMEOUT_MS = 60_000

export async function fetchAttachmentBytes(url: string, timeoutMs = DOWNLOAD_TIMEOUT_MS): Promise<Uint8Array> {
  // The url is a short-lived pre-signed storage URL, so it carries its own auth
  // — a plain fetch, not the bearer-authenticated client request. The timeout
  // signal spans headers AND arrayBuffer(): a stalled download body must reject,
  // not hang the channel (same pathogen as the client request bound).
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`download failed with ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * Discover the attachments on the messages Claude is being shown, download them
 * into `<cwd>/.threa-attachments/<invocationId>/`, and return what landed. A
 * per-attachment failure is logged and skipped rather than aborting the turn.
 */
export async function downloadInboundAttachments(
  client: Pick<ThreaClient, "listStreamMessages" | "getAttachmentDownloadUrl">,
  params: {
    streamId: string
    sourceMessageId: string
    contextMessageIds: readonly string[]
    invocationId: string
    cwd: string
    scanLimit: number
    log: (message: string) => void
  }
): Promise<DownloadedAttachment[]> {
  const messages = await client.listStreamMessages(params.streamId, { limit: params.scanLimit })
  const selected = selectInboundAttachments(messages, params.sourceMessageId, params.contextMessageIds)
  if (selected.length === 0) return []
  const dir = join(params.cwd, ATTACHMENT_DIR, params.invocationId)
  mkdirSync(dir, { recursive: true })
  const downloaded: DownloadedAttachment[] = []
  for (const item of selected) {
    try {
      const url = await client.getAttachmentDownloadUrl(item.attachment.id)
      const bytes = await fetchAttachmentBytes(url)
      const localPath = join(dir, safeFilename(item.attachment.filename))
      writeFileSync(localPath, bytes)
      downloaded.push({ ...item, localPath })
    } catch (error) {
      params.log(`attachment ${item.attachment.id} download failed: ${String(error)}`)
    }
  }
  return downloaded
}

async function uploadFile(
  client: Pick<ThreaClient, "uploadAttachment">,
  path: string,
  cwd: string
): Promise<AttachmentSummary> {
  const absolute = resolve(cwd, path)
  const stats = statSync(absolute)
  if (!stats.isFile()) throw new Error(`${path} is not a file`)
  const bytes = readFileSync(absolute)
  const form = new FormData()
  form.append("file", new Blob([bytes], { type: guessMimeType(absolute) }), basename(absolute))
  return client.uploadAttachment(form)
}

/**
 * Resolve `THREA_ATTACH:` directives in a reply: upload each referenced file and
 * rewrite the reply to carry `attachment:<id>` links the backend associates with
 * the posted message. Upload failures surface as a note rather than throwing.
 */
export async function uploadReplyAttachments(
  client: Pick<ThreaClient, "uploadAttachment">,
  markdown: string,
  cwd: string
): Promise<{ markdown: string; uploaded: AttachmentSummary[]; failed: string[] }> {
  const { markdown: stripped, paths } = extractAttachmentDirectives(markdown)
  const uploaded: AttachmentSummary[] = []
  const failed: string[] = []
  for (const path of paths) {
    try {
      uploaded.push(await uploadFile(client, path, cwd))
    } catch (error) {
      failed.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const section = buildReplyAttachmentSection(uploaded, failed)
  const finalMarkdown = [stripped, section].filter(Boolean).join("\n\n") || "Done."
  return { markdown: finalMarkdown, uploaded, failed }
}

// --- Sealed (E2E) attachments ----------------------------------------------

/** Placeholder name/mime for the opaque ciphertext upload — the real values ride only in the sealed ref. */
const SEALED_UPLOAD_FILENAME = "encrypted"
const SEALED_UPLOAD_MIME = "application/octet-stream"
/**
 * Server cap on `attachmentIds` per sealed message (`sealedAttachmentIdsSchema`
 * caps at 16). Clamp before uploading: sending more ids would 400 the whole
 * completion, and the retry loop would re-send the same over-limit body forever.
 */
export const MAX_SEALED_ATTACHMENTS_PER_MESSAGE = 16

async function uploadSealedFile(
  client: Pick<ThreaClient, "uploadAttachment">,
  path: string,
  cwd: string
): Promise<AttachmentRef> {
  const absolute = resolve(cwd, path)
  const stats = statSync(absolute)
  if (!stats.isFile()) throw new Error(`${path} is not a file`)
  const bytes = readFileSync(absolute)
  const encrypted = await encryptAttachmentBytes(bytes)
  const form = new FormData()
  form.append("e2e", "true")
  form.append("file", new Blob([encrypted.ciphertext], { type: SEALED_UPLOAD_MIME }), SEALED_UPLOAD_FILENAME)
  const summary = await client.uploadAttachment(form)
  return {
    attachmentId: summary.id,
    key: encrypted.key,
    iv: encrypted.iv,
    filename: basename(absolute),
    mimeType: guessMimeType(absolute),
    sizeBytes: bytes.length,
  }
}

/**
 * Resolve `THREA_ATTACH:` directives in SEALED output: encrypt each file under a
 * fresh single-use key, upload only the ciphertext (`e2e=true`, placeholder
 * name/mime), and return the refs to seal into the message payload plus the ids
 * the wire body binds to the message row. No `attachment:<id>` links are added —
 * an E2E viewer renders attachments from the sealed refs, not the markdown.
 * Upload failures surface as a note (itself sealed) rather than throwing.
 */
export async function uploadSealedReplyAttachments(
  client: Pick<ThreaClient, "uploadAttachment">,
  markdown: string,
  cwd: string
): Promise<{ markdown: string; refs: AttachmentRef[]; attachmentIds: string[] }> {
  const { markdown: stripped, paths } = extractAttachmentDirectives(markdown)
  const refs: AttachmentRef[] = []
  const failed: string[] = []
  for (const path of paths.slice(MAX_SEALED_ATTACHMENTS_PER_MESSAGE)) {
    failed.push(`${path}: over the ${MAX_SEALED_ATTACHMENTS_PER_MESSAGE}-attachment limit for one message`)
  }
  for (const path of paths.slice(0, MAX_SEALED_ATTACHMENTS_PER_MESSAGE)) {
    try {
      refs.push(await uploadSealedFile(client, path, cwd))
    } catch (error) {
      failed.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const failureNote = failed.length > 0 ? ["Attachment upload failed:", ...failed.map((f) => `- ${f}`)].join("\n") : ""
  return {
    markdown: [stripped, failureNote].filter(Boolean).join("\n\n"),
    refs,
    attachmentIds: refs.map((ref) => ref.attachmentId),
  }
}

/** One inbound sealed attachment to fetch: the ref plus whether it rode the trigger message. */
export interface SealedInboundRef {
  ref: AttachmentRef
  isSource: boolean
}

/**
 * Dedupe the refs opened from a sealed claim (trigger payload + history
 * payloads) by attachment id, trigger first — the sealed sibling of
 * `selectInboundAttachments`, working from decrypted refs instead of the
 * plaintext message list (which only holds placeholders on an E2E stream).
 */
export function selectSealedInboundRefs(
  promptRefs: readonly AttachmentRef[],
  historyRefs: readonly AttachmentRef[]
): SealedInboundRef[] {
  const seen = new Set<string>()
  const selected: SealedInboundRef[] = []
  for (const { refs, isSource } of [
    { refs: promptRefs, isSource: true },
    { refs: historyRefs, isSource: false },
  ]) {
    for (const ref of refs) {
      if (seen.has(ref.attachmentId)) continue
      seen.add(ref.attachmentId)
      selected.push({ ref, isSource })
    }
  }
  return selected
}

/**
 * Download + decrypt a sealed turn's inbound attachments into
 * `<cwd>/.threa-attachments/<invocationId>/`. The S3 object is opaque
 * ciphertext; the ref's key/iv (opened from the sealed message payload) decrypt
 * it locally, and the file lands under its REAL name — decrypted bytes never
 * transit the server. A per-attachment failure is logged and skipped.
 */
export async function downloadSealedInboundAttachments(
  client: Pick<ThreaClient, "getAttachmentDownloadUrl">,
  params: {
    refs: SealedInboundRef[]
    invocationId: string
    cwd: string
    log: (message: string) => void
  }
): Promise<DownloadedAttachment[]> {
  if (params.refs.length === 0) return []
  const dir = join(params.cwd, ATTACHMENT_DIR, params.invocationId)
  mkdirSync(dir, { recursive: true })
  const downloaded: DownloadedAttachment[] = []
  for (const { ref, isSource } of params.refs) {
    try {
      const url = await client.getAttachmentDownloadUrl(ref.attachmentId)
      const ciphertext = await fetchAttachmentBytes(url)
      const plaintext = await decryptAttachmentBytes({ ciphertext, key: ref.key, iv: ref.iv })
      const localPath = join(dir, safeFilename(ref.filename))
      writeFileSync(localPath, plaintext)
      downloaded.push({
        attachment: { id: ref.attachmentId, filename: ref.filename, mimeType: ref.mimeType, sizeBytes: ref.sizeBytes },
        messageId: "",
        isSource,
        localPath,
      })
    } catch (error) {
      params.log(`sealed attachment ${ref.attachmentId} download failed: ${String(error)}`)
    }
  }
  return downloaded
}
