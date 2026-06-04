import type { AttachmentRef } from "./attachment"

/**
 * The structured E2E message payload. Messages with no attachments seal the
 * bare markdown string (byte-identical to every E2E message already written),
 * so this wrapper only appears once attachments ride along. The `__e2ePayload`
 * marker + version lets the open path tell a wrapper apart from a user's
 * markdown that merely happens to start with `{` — the same structurally-
 * disjoint discrimination the backend's envelope union uses.
 *
 * Shared so the browser (seal on send, strip on view) and the enclave (strip
 * to feed the model clean markdown + read attachmentRefs) use one parser.
 */
export interface E2eSealedPayload {
  __e2ePayload: typeof E2E_PAYLOAD_VERSION
  contentMarkdown: string
  attachmentRefs: AttachmentRef[]
}

export const E2E_PAYLOAD_VERSION = 1

/** Build the bytes to seal: bare markdown, or the wrapper when refs ride along. */
export function serializeSealedPayload(contentMarkdown: string, attachmentRefs?: AttachmentRef[]): string {
  if (!attachmentRefs || attachmentRefs.length === 0) return contentMarkdown
  return JSON.stringify({
    __e2ePayload: E2E_PAYLOAD_VERSION,
    contentMarkdown,
    attachmentRefs,
  } satisfies E2eSealedPayload)
}

export interface ParsedSealedPayload {
  contentMarkdown: string
  attachmentRefs: AttachmentRef[]
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
 * Inverse of `serializeSealedPayload`. A decrypted string is either the bare
 * markdown body (the legacy/no-attachment shape) or the versioned wrapper;
 * anything that doesn't parse as our wrapper is treated as raw markdown so old
 * messages keep opening unchanged. Malformed ref elements are dropped.
 */
export function parseSealedPayload(raw: string): ParsedSealedPayload {
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Partial<E2eSealedPayload>
      if (parsed.__e2ePayload === E2E_PAYLOAD_VERSION && typeof parsed.contentMarkdown === "string") {
        const attachmentRefs = Array.isArray(parsed.attachmentRefs)
          ? parsed.attachmentRefs.filter(isAttachmentRef)
          : []
        return { contentMarkdown: parsed.contentMarkdown, attachmentRefs }
      }
    } catch {
      // Not our wrapper — fall through and treat the whole string as markdown.
    }
  }
  return { contentMarkdown: raw, attachmentRefs: [] }
}
