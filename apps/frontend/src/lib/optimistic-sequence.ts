let lastOptimisticSequence = 0

export function nextOptimisticSequence(now = Date.now()): string {
  lastOptimisticSequence = Math.max(now, lastOptimisticSequence + 1)
  return lastOptimisticSequence.toString()
}
