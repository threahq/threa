import type { AttachmentRef } from "./attachment"

/**
 * One citation source sealed into an E2E message payload. Structural twin of
 * `@threa/types`' `SourceItem` — this package stays dependency-free (it must
 * not pull the whole types package into every crypto consumer), so the shape
 * is mirrored here and bridged by structural typing, exactly like
 * `EnclaveStreamEnvelope` mirrors `StreamEnvelope` on the types side.
 *
 * Sources reveal *what was researched*, so they ride inside the SSK ciphertext
 * (this wrapper), never a cleartext column or wire field (E2EE-9).
 */
export interface SealedSourceItem {
  /** Source type, e.g. "web" — optional, mirrors `SourceItem.type`. */
  type?: string
  title: string
  url: string
  snippet?: string
}

/**
 * The structured E2E message payload. Messages with no attachments and no
 * sources seal the bare markdown string (byte-identical to every E2E message
 * already written), so this wrapper only appears once attachments or sources
 * ride along. The `__e2ePayload` marker + version lets the open path tell a
 * wrapper apart from a user's markdown that merely happens to start with `{` —
 * the same structurally-disjoint discrimination the backend's envelope union
 * uses.
 *
 * Shared so the browser (seal on send, strip on view) and the enclave (strip
 * to feed the model clean markdown + read attachmentRefs, seal replies with
 * their citation sources) use one parser.
 */
export interface E2eSealedPayload {
  __e2ePayload: typeof E2E_PAYLOAD_VERSION
  contentMarkdown: string
  attachmentRefs: AttachmentRef[]
  /** Citation sources for agent replies. Absent on user messages and older payloads. */
  sources?: SealedSourceItem[]
}

export const E2E_PAYLOAD_VERSION = 1

/** Build the bytes to seal: bare markdown, or the wrapper when refs/sources ride along. */
export function serializeSealedPayload(
  contentMarkdown: string,
  attachmentRefs?: AttachmentRef[],
  sources?: SealedSourceItem[]
): string {
  const hasRefs = attachmentRefs !== undefined && attachmentRefs.length > 0
  const hasSources = sources !== undefined && sources.length > 0
  if (!hasRefs && !hasSources) return contentMarkdown
  return JSON.stringify({
    __e2ePayload: E2E_PAYLOAD_VERSION,
    contentMarkdown,
    attachmentRefs: attachmentRefs ?? [],
    ...(hasSources ? { sources } : {}),
  } satisfies E2eSealedPayload)
}

export interface ParsedSealedPayload {
  contentMarkdown: string
  attachmentRefs: AttachmentRef[]
  sources: SealedSourceItem[]
}

/**
 * Validate one decrypted `attachmentRefs` element before it's surfaced. The
 * refs are decrypted text we authored, but a malformed or mixed-version payload
 * could carry objects missing `key`/`iv`/`filename`/etc. — those must not flow
 * onward (a viewer would fetch/decrypt with `undefined`).
 */
export function isAttachmentRef(value: unknown): value is AttachmentRef {
  if (typeof value !== "object" || value === null) return false
  const r = value as Record<string, unknown>
  return (
    typeof r.attachmentId === "string" &&
    typeof r.key === "string" &&
    typeof r.iv === "string" &&
    typeof r.filename === "string" &&
    typeof r.mimeType === "string" &&
    typeof r.sizeBytes === "number"
  )
}

/**
 * Validate one decrypted `sources` element before it's surfaced — same defence
 * as `isAttachmentRef`: a malformed element must not reach the renderer with
 * `undefined` where it expects a title/url string.
 */
export function isSealedSourceItem(value: unknown): value is SealedSourceItem {
  if (typeof value !== "object" || value === null) return false
  const s = value as Record<string, unknown>
  return (
    typeof s.title === "string" &&
    typeof s.url === "string" &&
    (s.type === undefined || typeof s.type === "string") &&
    (s.snippet === undefined || typeof s.snippet === "string")
  )
}

/**
 * Inverse of `serializeSealedPayload`. A decrypted string is either the bare
 * markdown body (the legacy/no-attachment shape) or the versioned wrapper;
 * anything that doesn't parse as our wrapper is treated as raw markdown so old
 * messages keep opening unchanged. Malformed ref/source elements are dropped.
 */
export function parseSealedPayload(raw: string): ParsedSealedPayload {
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Partial<E2eSealedPayload>
      if (parsed.__e2ePayload === E2E_PAYLOAD_VERSION && typeof parsed.contentMarkdown === "string") {
        const attachmentRefs = Array.isArray(parsed.attachmentRefs) ? parsed.attachmentRefs.filter(isAttachmentRef) : []
        const sources = Array.isArray(parsed.sources) ? parsed.sources.filter(isSealedSourceItem) : []
        return { contentMarkdown: parsed.contentMarkdown, attachmentRefs, sources }
      }
    } catch {
      // Not our wrapper — fall through and treat the whole string as markdown.
    }
  }
  return { contentMarkdown: raw, attachmentRefs: [], sources: [] }
}
