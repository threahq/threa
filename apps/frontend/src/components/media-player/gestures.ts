export const NUDGE_CHAIN_MS = 700

export type NudgeDirection = -1 | 1

export interface NudgeChain {
  direction: NudgeDirection
  totalSeconds: number
  lastAt: number
}

export function nextNudgeChain(
  prev: NudgeChain | null,
  direction: NudgeDirection,
  seconds: number,
  now: number
): NudgeChain {
  const continues = prev !== null && prev.direction === direction && now - prev.lastAt <= NUDGE_CHAIN_MS
  return { direction, totalSeconds: continues ? prev.totalSeconds + seconds : seconds, lastAt: now }
}

export function isNudgeChainActive(chain: NudgeChain | null, now: number): boolean {
  return chain !== null && now - chain.lastAt <= NUDGE_CHAIN_MS
}

export type TapZone = "left" | "center" | "right"

export function tapZone(x: number, width: number): TapZone {
  if (width <= 0) return "center"
  const fraction = x / width
  if (fraction < 1 / 3) return "left"
  if (fraction > 2 / 3) return "right"
  return "center"
}

export function zoneDirection(zone: TapZone): NudgeDirection | null {
  if (zone === "left") return -1
  if (zone === "right") return 1
  return null
}
