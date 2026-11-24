import { STORYBOARD_MAX_COLUMNS, STORYBOARD_MAX_TILES, STORYBOARD_MIN_INTERVAL_MS } from "./config"

export interface StoryboardLayout {
  tileCount: number
  intervalMs: number
  columns: number
  rows: number
}

export function storyboardLayout(durationMs: number): StoryboardLayout {
  const tileCount = Math.min(STORYBOARD_MAX_TILES, Math.max(1, Math.ceil(durationMs / STORYBOARD_MIN_INTERVAL_MS)))
  const intervalMs = Math.ceil(durationMs / tileCount)
  const columns = Math.min(STORYBOARD_MAX_COLUMNS, tileCount)
  return { tileCount, intervalMs, columns, rows: Math.ceil(tileCount / columns) }
}

/** Seconds into the source for tile `index`: the start of the span it stands for, so tile 0 is the first frame. */
export function tileTimeSeconds(layout: StoryboardLayout, index: number): number {
  return (index * layout.intervalMs) / 1000
}
