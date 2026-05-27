import type { Querier } from "../../../db"
import type { Pool } from "pg"
import { withClient } from "../../../db"
import type { AI, CostContext } from "@threa/agent-runtime"
import { logger } from "../../../lib/logger"
import { ContextIntents, type ContextRefKind } from "@threa/types"
import { MessageRepository } from "../../messaging"
import { StreamRepository } from "../../streams"
import { ContextBagRepository } from "./repository"
import { SummaryRepository } from "./summary-repository"
import { getIntentConfig, getResolver } from "./registry"
import { diffInputs } from "./diff"
import { buildSnapshot, renderDelta, renderStable } from "./render"
import { summarizeThread } from "./summarizer"
import type { LastRenderedSnapshot, RenderableMessage, ResolvedRef, StoredContextBag, SummaryInput } from "./types"

/**
 * Per-ref grouping returned alongside the flat `items` list. Callers that need
 * to render "what's attached to this turn" — most notably the agent-session
 * trace's `context_received` step — use this to keep the source-stream
 * metadata (displayName/slug/itemCount) and the actual messages associated.
 *
 * `source` mirrors the shape that `fetchStreamBag` produces for the timeline
 * pill so the trace can render an identical "50 messages in #foo" chip with
 * no extra lookups on the frontend.
 */
export interface ResolvedBagRef {
  streamId: string
  fromMessageId: string | null
  toMessageId: string | null
  /** Cosmetic deep-link anchor; the focal message the discussion was started from. */
  originMessageId: string | null
  source: {
    displayName: string | null
    slug: string | null
    type: string
    itemCount: number
  }
  items: RenderableMessage[]
}

export interface ResolvedBag {
  bagId: string
  intent: StoredContextBag["intent"]
  /** Rendered prompt region that SHOULD stay byte-identical across turns for a stable cache prefix. */
  stable: string
  /** Rendered "since last turn" region. Empty string when there's no drift. */
  delta: string
  /**
   * Renderable items from every resolved ref, concatenated in ref order. Used
   * by callers that want to surface the raw messages behind the bag (e.g. the
   * agent-session trace `context_received` step) regardless of whether the
   * stable region inlined them or collapsed them into a summary.
   */
  items: RenderableMessage[]
  /**
   * Per-ref breakdown of `items` paired with source-stream metadata. The
   * agent-session trace renders one chip per entry and lists the underlying
   * messages so users can see exactly what context was fed to the turn.
   */
  refs: ResolvedBagRef[]
  /**
   * Snapshot the caller should persist after the agent turn completes. This
   * is NOT co-committed with the message insert — see `persistSnapshot` for
   * the crash-window safety model (session COMPLETED guard + `clientMessageId`
   * dedup + idempotent UPDATE).
   */
  nextSnapshot: LastRenderedSnapshot
}

export interface ResolveBagDeps {
  pool: Pool
  ai: AI
  costContext: CostContext
}

export interface ResolveBagOptions {
  /**
   * When true, return null if the bag's `lastRendered` is already non-null.
   * Used by the pre-compute worker so a retried job skips the resolver +
   * summarization pass once the initial snapshot has been written.
   */
  skipIfAlreadyRendered?: boolean
}

/**
 * Resolve the bag attached to a stream (if any), producing a cache-friendly
 * prompt region pair (stable + delta) plus the `nextSnapshot` the caller
 * should persist after the AI turn.
 *
 * INV-41: we acquire and release the DB connection before kicking off the
 * (potentially slow) summarization AI call. If summarization is needed, we
 * write the resulting summary back through a fresh short-lived connection.
 */
export async function resolveBagForStream(
  deps: ResolveBagDeps,
  streamId: string,
  options?: ResolveBagOptions
): Promise<ResolvedBag | null> {
  const { pool, ai, costContext } = deps

  // Phase 1 (DB): load the bag, resolve its refs, compute diff + inputs.
  const phase1 = await withClient(pool, async (db) => {
    const bag = await ContextBagRepository.findByStream(db, costContext.workspaceId, streamId)
    if (!bag) return null

    // Short-circuit for idempotent callers (pre-compute worker): if the bag
    // has already been rendered once, don't waste a resolver pass or a
    // summarization AI call — the caller will skip its downstream work.
    if (options?.skipIfAlreadyRendered && bag.lastRendered !== null) {
      return "already-rendered" as const
    }

    const config = getIntentConfig(bag.intent)
    const resolveds: ResolvedRef[] = []
    for (const ref of bag.refs) {
      if (!config.supportedKinds.includes(ref.kind)) {
        logger.warn({ intent: bag.intent, kind: ref.kind }, "context-bag: unsupported ref kind for intent, skipping")
        continue
      }
      const resolver = getResolver(ref.kind)
      const part = await resolver.fetch(db, ref, { intent: bag.intent })
      resolveds.push({ ref, ...part })
    }

    // Source-stream enrichment for the trace UI's "X messages in #foo" pill.
    // Mirrors `fetchStreamBag` so the agent-session trace renders the same
    // label as the inline message badge — INV-35: don't fork the formatting
    // logic, share the data shape via `formatContextRefLabel` on the FE.
    const refStreamIds = [...new Set(resolveds.map((r) => r.ref.streamId))]
    const [sourceStreams, itemCounts] = refStreamIds.length
      ? await Promise.all([
          StreamRepository.findByIds(db, refStreamIds),
          MessageRepository.countByStreams(db, refStreamIds),
        ])
      : [[], new Map<string, number>()]
    const streamById = new Map(sourceStreams.map((s) => [s.id, s]))

    return { bag, config, resolveds, streamById, itemCounts }
  })

  if (!phase1 || phase1 === "already-rendered") return null

  const { bag, config, resolveds, streamById, itemCounts } = phase1

  // Phase 2 (maybe AI): for each ref, decide inline vs summary. Summaries use
  // the shared cache keyed by (workspace, refKind, refKey, fingerprint).
  const stableParts: string[] = []
  const deltaParts: string[] = []
  const allItems: RenderableMessage[] = []
  const groupedRefs: ResolvedBagRef[] = []
  const nextItems: SummaryInput[] = []
  let nextTail: string | null = null

  // For windowed bags (DISCUSS_THREAD), the trace pill should report the
  // actual resolved item count, not the global cap. `ThreadResolver` prepends
  // the thread root on top of the discuss window, so the resolved length can
  // exceed `DISCUSS_WINDOW_TOTAL` by one — the trace exists to show what the
  // AI actually saw, so the chip and the disclosure must agree on the same
  // number. Non-windowed intents fall back to the raw source-stream count.
  const isWindowedIntent = bag.intent === ContextIntents.DISCUSS_THREAD

  for (const resolved of resolveds) {
    const inlineSize = resolved.items.reduce((acc, m) => acc + m.contentMarkdown.length, 0)
    const resolver = getResolver(resolved.ref.kind)
    const refKey = resolver.canonicalKey(resolved.ref)

    let summaryText: string | undefined
    if (inlineSize > config.inlineCharThreshold && resolved.items.length > 0) {
      summaryText = await loadOrCreateSummary({
        pool,
        ai,
        costContext,
        workspaceId: bag.workspaceId,
        refKind: resolved.ref.kind,
        refKey,
        fingerprint: resolved.fingerprint,
        inputs: resolved.inputs,
        items: resolved.items,
      })
    }

    const stable = renderStable({
      preamble: config.systemPreamble,
      inlineItems: summaryText ? undefined : resolved.items,
      summaryText,
      refLabel: refKey,
      focalMessageId: resolved.focalMessageId,
    })
    stableParts.push(stable)

    const diff = diffInputs(resolved.inputs, bag.lastRendered)
    const currentByMessageId = new Map<string, RenderableMessage>(resolved.items.map((item) => [item.messageId, item]))
    const delta = renderDelta({ diff, currentByMessageId })
    if (delta) deltaParts.push(delta)

    allItems.push(...resolved.items)
    nextItems.push(...resolved.inputs)
    if (resolved.tailMessageId) nextTail = resolved.tailMessageId

    const sourceStream = streamById.get(resolved.ref.streamId)
    const totalCount = itemCounts.get(resolved.ref.streamId) ?? 0
    groupedRefs.push({
      streamId: resolved.ref.streamId,
      fromMessageId: resolved.ref.fromMessageId ?? null,
      toMessageId: resolved.ref.toMessageId ?? null,
      originMessageId: resolved.ref.originMessageId ?? null,
      source: {
        displayName: sourceStream?.displayName ?? null,
        slug: sourceStream?.slug ?? null,
        type: sourceStream?.type ?? "thread",
        itemCount: isWindowedIntent ? resolved.items.length : totalCount,
      },
      items: resolved.items,
    })
  }

  return {
    bagId: bag.id,
    intent: bag.intent,
    stable: stableParts.join("\n\n"),
    delta: deltaParts.join("\n\n"),
    items: allItems,
    refs: groupedRefs,
    nextSnapshot: buildSnapshot(nextItems, nextTail),
  }
}

/**
 * Look up a cached summary for a resolved ref, or produce one and upsert.
 * Exported so the standalone precompute service can reuse the exact same
 * cache logic as the stream-attached resolver path (INV-35). INV-41: the AI
 * call runs without holding a DB connection.
 */
export async function loadOrCreateSummary(params: {
  pool: Pool
  ai: AI
  costContext: CostContext
  workspaceId: string
  refKind: ContextRefKind
  refKey: string
  fingerprint: string
  inputs: SummaryInput[]
  items: RenderableMessage[]
}): Promise<string> {
  const { pool, ai, costContext, workspaceId, refKind, refKey, fingerprint, inputs, items } = params

  const cached = await SummaryRepository.find(pool, { workspaceId, refKind, refKey, fingerprint })
  if (cached) return cached.summaryText

  const { text, model } = await summarizeThread({ ai, costContext }, { refKey, items })

  const stored = await SummaryRepository.upsert(pool, {
    workspaceId,
    refKind,
    refKey,
    fingerprint,
    inputs,
    summaryText: text,
    model,
  })
  return stored.summaryText
}

/**
 * Persist the snapshot from a successful render.
 *
 * Idempotent standalone UPDATE — callers run it as the final step of a render
 * pass. The pre-compute worker writes this after `resolveBagForStream`
 * finishes; retries short-circuit via `skipIfAlreadyRendered` rather than
 * re-writing the same snapshot. See `context-bag-precompute-handler.ts`.
 *
 * Workspace-scoped per INV-8.
 */
export async function persistSnapshot(
  db: Querier,
  workspaceId: string,
  bagId: string,
  snapshot: LastRenderedSnapshot
): Promise<void> {
  await ContextBagRepository.updateLastRendered(db, workspaceId, bagId, snapshot)
}
