/**
 * Sidecar entry on a draft for an attached context ref. Lives next to
 * `attachments` on the `CachedDraft` row so the composer surface (uploads
 * + context refs) is atomic with the user's typed content.
 *
 * Status reflects the precompute lifecycle:
 * - `pending` — `POST /context-bag/precompute` is in flight.
 * - `ready`   — precompute returned a cached summary.
 * - `inline`  — content fits under the inline threshold; no summary needed.
 * - `error`   — precompute failed (e.g. lost access to source stream).
 *
 * `composer.canSend` blocks while any ref is `pending` or `error`.
 *
 * Defined here (rather than in `@/db`) so view layers can `import type` it
 * without violating the "components must not import database" lint rule
 * (INV-15).
 */
export interface DraftContextRef {
  refKind: string
  /** The conversation this ref points at, for `refKind: "conversation"`. Null for
   * thread refs. Keyed alongside `streamId` so a conversation chip is distinct
   * from a thread chip on the same root stream. */
  conversationId: string | null
  streamId: string
  /**
   * Lower slice anchor for the resolver. Setting this narrows the AI's
   * view of the thread; UI labels show "Slice of …". Leave null for
   * whole-thread context (the default).
   */
  fromMessageId: string | null
  toMessageId: string | null
  /** Cosmetic deep-link anchor — chip's link target. Resolver ignores it. */
  originMessageId: string | null
  status: "pending" | "ready" | "inline" | "error"
  fingerprint: string | null
  errorMessage: string | null
}
