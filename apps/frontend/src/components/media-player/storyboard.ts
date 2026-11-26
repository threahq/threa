import type { VideoStoryboard } from "@threahq/types"
import { clamp } from "@/lib/math-utils"

export type ReadyStoryboard = Extract<VideoStoryboard, { status: "ready" }>

export interface LoadedStoryboard extends ReadyStoryboard {
  spriteUrl: string
}

/** Background size and offset that show, at the displayed tile size, the tile covering `timeSeconds`. */
export function storyboardTileStyle(
  storyboard: ReadyStoryboard,
  timeSeconds: number,
  tile: { width: number; height: number }
): { backgroundSize: string; backgroundPosition: string } {
  const index = clamp(Math.floor((timeSeconds * 1000) / storyboard.intervalMs), 0, storyboard.tileCount - 1)
  const column = index % storyboard.columns
  const row = Math.floor(index / storyboard.columns)
  return {
    backgroundSize: `${storyboard.columns * tile.width}px ${storyboard.rows * tile.height}px`,
    backgroundPosition: `${-column * tile.width}px ${-row * tile.height}px`,
  }
}
