/** Continuous-refill token bucket; callers hold one per socket and drop whatever `take()` refuses. */
export function createTokenBucket(burst: number, refillPerSecond: number) {
  let tokens = burst
  let last = Date.now()
  return {
    take(): boolean {
      const now = Date.now()
      tokens = Math.min(burst, tokens + ((now - last) / 1000) * refillPerSecond)
      last = now
      if (tokens < 1) return false
      tokens -= 1
      return true
    },
  }
}
