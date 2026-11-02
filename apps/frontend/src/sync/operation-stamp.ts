let lastCreatedAt = 0

/**
 * Replay orders by `createdAt` and ties fall back to `id`, so both must follow
 * enqueue order: `createdAt` never repeats within a tab, even inside one millisecond.
 */
export function newOperationStamp(): { id: string; createdAt: number } {
  const createdAt = Math.max(Date.now(), lastCreatedAt + 1)
  lastCreatedAt = createdAt
  return { id: `op_${createdAt}_${Math.random().toString(36).slice(2)}`, createdAt }
}
