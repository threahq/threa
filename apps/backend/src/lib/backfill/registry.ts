import type { Pool } from "pg"

/** Shared collaborators handed to a backfill definition's plan/processChunk. */
export interface BackfillContext {
  pool: Pool
}

/**
 * A named backfill: `plan` computes the full work set as chunk descriptors,
 * `processChunk` idempotently applies one descriptor. Both are pure of queue
 * mechanics — the framework workers handle enqueue, tracking, and accounting.
 *
 * `Chunk` is the opaque per-chunk descriptor type (serialized through the
 * queue payload). `processChunk` MUST be idempotent: a chunk job may be
 * redelivered, and the framework re-runs `processChunk` before deciding
 * (exactly-once) whether to advance the run counters.
 */
export interface BackfillDefinition<Chunk = unknown> {
  name: string
  plan(ctx: BackfillContext, workspaceId: string, params?: unknown): Promise<Chunk[]>
  processChunk(ctx: BackfillContext, workspaceId: string, chunk: Chunk): Promise<{ processed: number }>
}

const registry = new Map<string, BackfillDefinition>()

export function registerBackfill<Chunk>(def: BackfillDefinition<Chunk>): void {
  registry.set(def.name, def as BackfillDefinition)
}

export function getBackfill(name: string): BackfillDefinition | undefined {
  return registry.get(name)
}
