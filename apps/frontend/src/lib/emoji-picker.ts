import type { EmojiEntry } from "@threa/types"
import { rankMatches } from "@/lib/match-score"

export const EMOJI_GROUP_ORDER = [
  "smileys",
  "people",
  "animals",
  "food",
  "travel",
  "activities",
  "objects",
  "symbols",
  "flags",
] as const

export const DESKTOP_GRID_COLUMNS = 8
export const MAX_RECENTLY_USED_ROWS = 2

export function chunkByColumns<T>(items: T[], columns: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < items.length; i += columns) {
    result.push(items.slice(i, i + columns))
  }
  return result
}

function groupIndex(group: string): number {
  const idx = (EMOJI_GROUP_ORDER as readonly string[]).indexOf(group)
  return idx === -1 ? EMOJI_GROUP_ORDER.length : idx
}

export function compareByDefaultOrder(a: EmojiEntry, b: EmojiEntry): number {
  const ga = groupIndex(a.group)
  const gb = groupIndex(b.group)
  if (ga !== gb) return ga - gb
  return a.order - b.order
}

/** All emojis sorted by group then in-group order, no weight influence. */
export function sortByDefaultOrder(emojis: EmojiEntry[]): EmojiEntry[] {
  return [...emojis].sort(compareByDefaultOrder)
}

/**
 * Pick the top N recently-used emojis by weight.
 * Only emojis with weight > 0 qualify. Ties fall back to default order.
 */
export function pickRecentlyUsed(emojis: EmojiEntry[], weights: Record<string, number>, limit: number): EmojiEntry[] {
  if (limit <= 0) return []
  const recent = emojis.filter((e) => (weights[e.shortcode] ?? 0) > 0)
  recent.sort((a, b) => {
    const wa = weights[a.shortcode] ?? 0
    const wb = weights[b.shortcode] ?? 0
    if (wa !== wb) return wb - wa
    return compareByDefaultOrder(a, b)
  })
  return recent.slice(0, limit)
}

export const QUICK_REACTION_COUNT = 6
export const DEFAULT_QUICK_REACTION_SHORTCODES = ["+1", "heart", "joy", "open_mouth", "cry", "fire"]

/**
 * Build the quick-react emoji list (the lower "fresh picks" row).
 *
 * Emojis in excludeShortcodes are omitted so the bar never duplicates
 * reactions the user has already placed on the message — those are shown
 * in a separate active-reactions row above the separator.
 *
 * Slot priority: most-used by weight → static defaults → full picker in
 * default order (top-left), ensuring the bar always fills to count.
 */
export function buildQuickEmojis(
  emojis: EmojiEntry[],
  weights: Record<string, number>,
  count: number = QUICK_REACTION_COUNT,
  defaults: string[] = DEFAULT_QUICK_REACTION_SHORTCODES,
  excludeShortcodes?: Set<string>
): EmojiEntry[] {
  if (!emojis.length) return []
  const result: EmojiEntry[] = []
  const seen = new Set<string>(excludeShortcodes)

  const byWeight = emojis
    .filter((e) => (weights[e.shortcode] ?? 0) > 0 && !seen.has(e.shortcode))
    .sort((a, b) => (weights[b.shortcode] ?? 0) - (weights[a.shortcode] ?? 0))
  for (const e of byWeight) {
    if (result.length >= count) break
    result.push(e)
    seen.add(e.shortcode)
  }

  const emojiMap = new Map(emojis.map((e) => [e.shortcode, e]))
  for (const shortcode of defaults) {
    if (result.length >= count) break
    const entry = emojiMap.get(shortcode)
    if (entry && !seen.has(shortcode)) {
      result.push(entry)
      seen.add(shortcode)
    }
  }

  // Fill any remaining slots from the full list in default order (picker top-left).
  if (result.length < count) {
    for (const e of sortByDefaultOrder(emojis)) {
      if (result.length >= count) break
      if (!seen.has(e.shortcode)) {
        result.push(e)
        seen.add(e.shortcode)
      }
    }
  }

  return result
}

/**
 * Filter and rank emojis for a search query. The canonical shortcode is the
 * primary match target; other aliases score a tier below, so `:smile:` ranks
 * above an emoji that merely lists "smile" as a hidden alias. Ties keep input
 * order (default order for the grid, weight order for recents).
 */
export function filterBySearch(emojis: EmojiEntry[], query: string): EmojiEntry[] {
  return rankMatches(emojis, query, (e) => ({ labels: [e.shortcode], keywords: e.aliases }))
}

export type Section = "recent" | "all"

export interface GridCoord {
  section: Section
  row: number
  col: number
}

export interface GridGeometry {
  recentCount: number
  allCount: number
  columns: number
}

export function totalCount(g: GridGeometry): number {
  return g.recentCount + g.allCount
}

export function indexToCoord(index: number, g: GridGeometry): GridCoord {
  if (index < g.recentCount) {
    return { section: "recent", row: Math.floor(index / g.columns), col: index % g.columns }
  }
  const eIdx = index - g.recentCount
  return { section: "all", row: Math.floor(eIdx / g.columns), col: eIdx % g.columns }
}

/**
 * Compute the next selected index when pressing an arrow key.
 * Returns the same index when the movement is blocked at an edge.
 *
 * Column-preserving across the section boundary: moving down from the last
 * (possibly partial) row of Recently used jumps to the same column in the
 * first row of Emojis, clamped to the last Emojis item.
 */
export function moveSelection(
  index: number,
  key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight",
  g: GridGeometry
): number {
  const total = totalCount(g)
  if (total === 0) return 0
  const { recentCount, allCount, columns } = g
  const coord = indexToCoord(index, g)

  switch (key) {
    case "ArrowLeft":
      return index > 0 ? index - 1 : index
    case "ArrowRight":
      return index < total - 1 ? index + 1 : index
    case "ArrowDown": {
      if (coord.section === "recent") {
        const recentRows = Math.ceil(recentCount / columns)
        const nextInSection = index + columns
        if (coord.row < recentRows - 1 && nextInSection < recentCount) {
          return nextInSection
        }
        // Cross into "all" at same col, clamped to last "all" item.
        if (allCount === 0) return index
        return recentCount + Math.min(coord.col, allCount - 1)
      }
      // section === "all"
      const allRows = Math.ceil(allCount / columns)
      if (coord.row >= allRows - 1) return index
      const nextInSection = index + columns
      return Math.min(nextInSection, total - 1)
    }
    case "ArrowUp": {
      if (coord.section === "all") {
        if (coord.row > 0) return index - columns
        if (recentCount === 0) return index
        // Cross back into "recent" at same col, clamped to last "recent" item.
        const recentRows = Math.ceil(recentCount / columns)
        const target = (recentRows - 1) * columns + coord.col
        return Math.min(target, recentCount - 1)
      }
      // section === "recent"
      return coord.row > 0 ? index - columns : index
    }
  }
}
