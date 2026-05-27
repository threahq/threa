import type { Pool } from "pg"
import { withClient } from "../../../db"
import type { AI, CostContext } from "@threa/agent-runtime"
import type { ContextIntent, ContextRef, ContextRefKind } from "@threa/types"
import { HttpError } from "../../../lib/errors"
import { logger } from "../../../lib/logger"
import { getIntentConfig, getResolver } from "./registry"
import { loadOrCreateSummary } from "./resolve"
import type { ResolvedRef } from "./types"

export interface PrecomputeRefsDeps {
  pool: Pool
  ai: AI
}

export interface PrecomputeRefsParams {
  workspaceId: string
  userId: string
  intent: ContextIntent
  refs: ContextRef[]
}

/**
 * Per-ref result returned to the client so a composer chip can flip from
 * "pending" to a concrete state. `ready` means the summary row is in
 * `context_summaries` and the first real turn will get a cache hit; `inline`
 * means the ref fit under the intent's inline-char threshold so no summary
 * was needed (the first real turn will inline the raw messages).
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

/**
 * Pre-compute summaries for a set of context refs without requiring a stream
 * attachment. Used by the composer's draft-scratchpad flow so chips can flip
 * to "ready" before the user clicks send.
 *
 * Contract:
 * - INV-8: caller access to every ref is re-verified here; a thrown HttpError
 *   surfaces to the handler unchanged.
 * - INV-41: the DB connection is released before any summarization AI call
 *   runs. Summary upserts open fresh short-lived connections.
 * - INV-20: `SummaryRepository.upsert` is race-safe on the fingerprint key,
 *   so concurrent precompute requests for the same ref converge.
 * - No `stream_context_attachments` row is written. The bag gets persisted
 *   later when the user sends their first message via `POST /streams` with
 *   the `contextBag` payload; by that time `context_summaries` is already
 *   warm and the downstream `resolveBagForStream` hits the cache.
 */
export async function precomputeRefSummaries(
  deps: PrecomputeRefsDeps,
  params: PrecomputeRefsParams
): Promise<PrecomputedRefResult[]> {
  const { pool, ai } = deps
  const { workspaceId, userId, intent, refs } = params

  const config = getIntentConfig(intent)

  // Phase 1 (DB): access-check + fetch every ref. Access lives at this
  // boundary so cache writes in Phase 2 can trust their inputs.
  const resolveds = await withClient(pool, async (db) => {
    const out: ResolvedRef[] = []
    for (const ref of refs) {
      if (!config.supportedKinds.includes(ref.kind)) {
        throw new HttpError(`Intent "${intent}" does not support ref kind "${ref.kind}"`, {
          status: 422,
          code: "CONTEXT_INTENT_KIND_MISMATCH",
        })
      }
      const resolver = getResolver(ref.kind)
      await resolver.assertAccess(db, ref, userId, workspaceId)
      const part = await resolver.fetch(db, ref, { intent })
      out.push({ ref, ...part })
    }
    return out
  })

  // Phase 2 (maybe AI): summarize anything over the inline threshold and
  // upsert. Below-threshold refs skip the cache entirely — they'll be
  // inlined at render time.
  const results: PrecomputedRefResult[] = []
  // User-initiated endpoint — attribute summarization spend to the caller.
  // The background `ContextBagPrecomputeWorker` (outbox-driven) is the
  // legitimate "system" caller; here the request came from a user composing
  // a draft, so cost goes to them per Langfuse + cost dashboards.
  const costContext: CostContext = { workspaceId, userId, origin: "user" }

  for (const resolved of resolveds) {
    const resolver = getResolver(resolved.ref.kind)
    const refKey = resolver.canonicalKey(resolved.ref)
    const inlineChars = resolved.items.reduce((acc, m) => acc + m.contentMarkdown.length, 0)
    const needsSummary = inlineChars > config.inlineCharThreshold && resolved.items.length > 0

    if (needsSummary) {
      await loadOrCreateSummary({
        pool,
        ai,
        costContext,
        workspaceId,
        refKind: resolved.ref.kind,
        refKey,
        fingerprint: resolved.fingerprint,
        inputs: resolved.inputs,
        items: resolved.items,
      })
    }

    results.push({
      kind: resolved.ref.kind,
      refKey,
      fingerprint: resolved.fingerprint,
      tailMessageId: resolved.tailMessageId,
      status: needsSummary ? "ready" : "inline",
      itemCount: resolved.items.length,
      inlineChars,
    })
  }

  logger.info(
    {
      workspaceId,
      intent,
      refCount: results.length,
      readyCount: results.filter((r) => r.status === "ready").length,
    },
    "context-bag precompute: completed"
  )

  return results
}
