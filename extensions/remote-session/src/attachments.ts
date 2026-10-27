import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { attachmentLocalPath, decryptAttachmentBytes, type AttachmentRef } from "@threahq/bot-runtime-client"
import type { AttachmentSummary, StreamMessageSummary, ThreaClient } from "./client"

/** Inbound attachments land under `<cwd>/.threa-attachments/<invocationId>/<attachmentId>/`, fresh per turn. */
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

// --- IO orchestration -----------------------------------------------------

const DOWNLOAD_TIMEOUT_MS = 60_000

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error("attachment hydration aborted")
}

export async function fetchAttachmentBytes(
  url: string,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<Uint8Array> {
  // The url is a short-lived pre-signed storage URL, so it carries its own auth
  // — a plain fetch, not the bearer-authenticated client request. The timeout
  // signal spans headers AND arrayBuffer(): a stalled download body must reject,
  // not hang the channel (same pathogen as the client request bound).
  const timeout = AbortSignal.timeout(timeoutMs)
  const response = await fetch(url, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout })
  if (!response.ok) throw new Error(`download failed with ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  throwIfAborted(signal)
  return bytes
}

/**
 * Discover the attachments on the messages Claude is being shown, download them
 * into `<cwd>/.threa-attachments/<invocationId>/<attachmentId>/`, and return
 * what landed. A per-attachment failure is logged and skipped rather than
 * aborting the turn.
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
    /** Live canonical rebuilds fail instead of acknowledging a partial file set. */
    strict?: boolean
    signal?: AbortSignal
  }
): Promise<DownloadedAttachment[]> {
  throwIfAborted(params.signal)
  const messages = await client.listStreamMessages(params.streamId, { limit: params.scanLimit })
  throwIfAborted(params.signal)
  const selected = selectInboundAttachments(messages, params.sourceMessageId, params.contextMessageIds)
  if (selected.length === 0) return []
  const dir = join(params.cwd, ATTACHMENT_DIR, params.invocationId)
  const downloaded: DownloadedAttachment[] = []
  for (const item of selected) {
    try {
      throwIfAborted(params.signal)
      const url = await client.getAttachmentDownloadUrl(item.attachment.id)
      const bytes = await fetchAttachmentBytes(url, DOWNLOAD_TIMEOUT_MS, params.signal)
      const localPath = attachmentLocalPath(dir, item.attachment.id, item.attachment.filename)
      mkdirSync(dirname(localPath), { recursive: true })
      writeFileSync(localPath, bytes)
      throwIfAborted(params.signal)
      downloaded.push({ ...item, localPath })
    } catch (error) {
      if (params.strict || params.signal?.aborted) throw error
      params.log(`attachment ${item.attachment.id} download failed: ${String(error)}`)
    }
  }
  return downloaded
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
 * `<cwd>/.threa-attachments/<invocationId>/<attachmentId>/`. The S3 object is opaque
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
    /** Live canonical rebuilds fail instead of acknowledging a partial file set. */
    strict?: boolean
    signal?: AbortSignal
  }
): Promise<DownloadedAttachment[]> {
  throwIfAborted(params.signal)
  if (params.refs.length === 0) return []
  const dir = join(params.cwd, ATTACHMENT_DIR, params.invocationId)
  const downloaded: DownloadedAttachment[] = []
  for (const { ref, isSource } of params.refs) {
    try {
      throwIfAborted(params.signal)
      const url = await client.getAttachmentDownloadUrl(ref.attachmentId)
      const ciphertext = await fetchAttachmentBytes(url, DOWNLOAD_TIMEOUT_MS, params.signal)
      const plaintext = await decryptAttachmentBytes({ ciphertext, key: ref.key, iv: ref.iv })
      throwIfAborted(params.signal)
      const localPath = attachmentLocalPath(dir, ref.attachmentId, ref.filename)
      mkdirSync(dirname(localPath), { recursive: true })
      writeFileSync(localPath, plaintext)
      downloaded.push({
        attachment: { id: ref.attachmentId, filename: ref.filename, mimeType: ref.mimeType, sizeBytes: ref.sizeBytes },
        messageId: "",
        isSource,
        localPath,
      })
    } catch (error) {
      if (params.strict || params.signal?.aborted) throw error
      params.log(`sealed attachment ${ref.attachmentId} download failed: ${String(error)}`)
    }
  }
  return downloaded
}
