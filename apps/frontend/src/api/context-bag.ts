import { api } from "./client"
import type { ContextBag, ContextIntent, ContextRef, ContextRefKind } from "@threahq/types"

/**
 * Per-ref result from `POST /context-bag/precompute`.
 *
 * `status: "ready"` means the server wrote a summary row into
 * `context_summaries` and the first real turn will hit the cache;
 * `"inline"` means the ref fit under the intent's inline-char threshold
 * and will be inlined at render time instead. The composer strip treats
 * both as "safe to send."
 */
export interface PrecomputedRefResult {
  kind: ContextRefKind
  refKey: string
  fingerprint: string
  tailMessageId: string | null
  status: "ready" | "inline"
  itemCount: number
  inlineChars: number
}

interface PrecomputeResponse {
  refs: PrecomputedRefResult[]
}

export interface PrecomputeInput {
  intent: ContextIntent
  refs: ContextRef[]
}

/** Per-ref source-stream metadata returned by `GET /streams/:id/context-bag`. */
export interface ContextRefSource {
  streamId: string
  displayName: string | null
  slug: string | null
  type: string
  itemCount: number
}

export interface EnrichedContextRef {
  kind: ContextRefKind
  streamId: string
  /** The conversation for `kind: "conversation"` refs; null for thread refs. */
  conversationId: string | null
  fromMessageId: string | null
  toMessageId: string | null
  source: ContextRefSource
}

export interface StreamContextBagResponse {
  bag: { id: string; intent: ContextIntent } | null
  refs: EnrichedContextRef[]
}

export const contextBagApi = {
  /**
   * Pre-warm the shared summary cache for a set of refs before the user
   * sends their first message. The server returns one status entry per ref
   * so a composer chip can flip from "pending" to "ready" / "inline"
   * before `POST /streams` fires. No `ContextBag` row is written by this
   * endpoint — the bag is persisted atomically with the stream on first
   * send via the existing `contextBag` payload on `POST /streams`.
   */
  async precompute(workspaceId: string, input: PrecomputeInput): Promise<PrecomputeResponse> {
    return api.post<PrecomputeResponse>(`/api/workspaces/${workspaceId}/context-bag/precompute`, input)
  },

  /**
   * Fetch the persisted `ContextBag` for a stream (if any), with each ref
   * enriched with source-stream metadata so the composer strip can render
   * a rich label ("12 messages in #intro") without re-fetching the source.
   * Drives the post-send / page-reload state of the strip when no draft
   * sidecar is present.
   */
  async getForStream(workspaceId: string, streamId: string): Promise<StreamContextBagResponse> {
    return api.get<StreamContextBagResponse>(`/api/workspaces/${workspaceId}/streams/${streamId}/context-bag`)
  },
}

export type { ContextBag }
