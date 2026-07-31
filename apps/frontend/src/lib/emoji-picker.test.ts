import { describe, it, expect } from "vitest"
import type { EmojiEntry } from "@threa/types"
import {
  buildQuickEmojis,
  buildShortcodeIndex,
  filterBySearch,
  stripShortcodeColons,
  indexToCoord,
  moveSelection,
  pickRecentlyUsed,
  sortByDefaultOrder,
  totalCount,
} from "./emoji-picker"

function make(shortcode: string, group: string, order: number, aliases?: string[], keywords?: string[]): EmojiEntry {
  return {
    shortcode,
    emoji: shortcode,
    type: "native",
    group,
    order,
    aliases: aliases ?? [shortcode],
    keywords: keywords ?? [],
  }
}

const smile = make("smile", "smileys", 1)
const grin = make("grin", "smileys", 2)
const dog = make("dog", "animals", 1)
const cat = make("cat", "animals", 2)
const pizza = make("pizza", "food", 1)
const rocket = make("rocket", "travel", 1)
const flag = make("flag_us", "flags", 1)

const all = [rocket, flag, pizza, dog, cat, smile, grin]

describe("sortByDefaultOrder", () => {
  it("orders by group first, then in-group order", () => {
    const sorted = sortByDefaultOrder(all)
    expect(sorted.map((e) => e.shortcode)).toEqual(["smile", "grin", "dog", "cat", "pizza", "rocket", "flag_us"])
  })

  it("is weight-independent (ignores weights)", () => {
    const sorted = sortByDefaultOrder(all)
    const first = sorted[0]!
    expect(first.shortcode).toBe("smile")
  })
})

describe("pickRecentlyUsed", () => {
  it("returns only emojis with weight > 0, sorted weight desc", () => {
    const weights = { dog: 5, smile: 10, pizza: 2 }
    const recent = pickRecentlyUsed(all, weights, 10)
    expect(recent.map((e) => e.shortcode)).toEqual(["smile", "dog", "pizza"])
  })

  it("caps at the given limit", () => {
    const weights = { dog: 5, smile: 10, pizza: 2, cat: 1 }
    expect(pickRecentlyUsed(all, weights, 2).map((e) => e.shortcode)).toEqual(["smile", "dog"])
  })

  it("tiebreaks equal weights by default order", () => {
    const weights = { cat: 1, dog: 1 }
    expect(pickRecentlyUsed(all, weights, 10).map((e) => e.shortcode)).toEqual(["dog", "cat"])
  })

  it("returns empty when limit <= 0", () => {
    expect(pickRecentlyUsed(all, { dog: 1 }, 0)).toEqual([])
  })
})

describe("filterBySearch", () => {
  it("returns all when query is empty", () => {
    expect(filterBySearch(all, "")).toEqual(all)
  })

  it("matches any alias substring, case-insensitive", () => {
    const poop = make("poop", "people", 10, ["poop", "hankey", "shit"])
    const matches = filterBySearch([smile, poop], "HANKEY")
    expect(matches.map((e) => e.shortcode)).toEqual(["poop"])
  })

  it("matches regardless of whitespace/dash/underscore separators", () => {
    const thumbsUp = make("thumbs_up", "people", 1, ["thumbs_up", "+1"])
    for (const query of ["thumbs up", "thumbs-up", "thumbsup"]) {
      expect(filterBySearch([smile, thumbsUp], query).map((e) => e.shortcode)).toEqual(["thumbs_up"])
    }
  })

  it("admits fuzzy subsequence matches after substring matches", () => {
    const thumbsUp = make("thumbs_up", "people", 1, ["thumbs_up", "+1"])
    const tulip = make("tulip", "animals", 1)
    const setup = make("setup", "objects", 1)
    // "setup" contains "tup" raw; thumbs_up (boundary-aligned, quality 1) and
    // tulip (gapped) only match as subsequences, in quality order behind it.
    const matches = filterBySearch([smile, tulip, thumbsUp, setup], "tup")
    expect(matches.map((e) => e.shortcode)).toEqual(["setup", "thumbs_up", "tulip"])
  })

  it("ranks visible shortcode matches above hidden alias matches regardless of input order", () => {
    const happy = make("happy_face", "people", 1, ["happy_face", "smile_alt"])
    const matches = filterBySearch([happy, smile], "smile")
    expect(matches.map((e) => e.shortcode)).toEqual(["smile", "happy_face"])
  })

  it("matches search keywords, which no shortcode spells", () => {
    const cry = make("cry", "smileys", 1, ["cry"], ["sad", "unhappy", "tear"])
    expect(filterBySearch([smile, cry], "unhappy").map((e) => e.shortcode)).toEqual(["cry"])
  })

  it("ranks a shortcode match above a keyword match", () => {
    const sadFace = make("sad_face", "smileys", 9, ["sad_face"])
    const cry = make("cry", "smileys", 1, ["cry"], ["sad"])
    expect(filterBySearch([cry, sadFace], "sad").map((e) => e.shortcode)).toEqual(["sad_face", "cry"])
  })

  it("tolerates entries with no keywords field (emoji list cached before keywords shipped)", () => {
    const legacy = { ...smile, keywords: undefined } as unknown as EmojiEntry
    expect(filterBySearch([legacy], "smile").map((e) => e.shortcode)).toEqual(["smile"])
  })
})

describe("buildShortcodeIndex", () => {
  it("resolves aliases as well as primary shortcodes", () => {
    const poop = make("poop", "people", 10, ["poop", "hankey", "shit"])
    const index = buildShortcodeIndex([poop])
    expect(index.get("hankey")).toBe(poop)
    expect(index.get("poop")).toBe(poop)
    expect(index.get("nope")).toBeUndefined()
  })

  it("never lets another emoji's alias shadow a primary shortcode", () => {
    // A stale cached list can carry an alias that has since been reassigned;
    // the primary must still win, whatever the input order.
    const stale = make("old", "objects", 1, ["old", "smile"])
    expect(buildShortcodeIndex([smile, stale]).get("smile")).toBe(smile)
    expect(buildShortcodeIndex([stale, smile]).get("smile")).toBe(smile)
  })
})

describe("stripShortcodeColons", () => {
  it("unwraps :name: and leaves a bare name alone", () => {
    expect(stripShortcodeColons(":smile:")).toBe("smile")
    expect(stripShortcodeColons("smile")).toBe("smile")
  })
})

describe("indexToCoord", () => {
  it("maps indices in the recent section", () => {
    const g = { recentCount: 12, allCount: 100, columns: 8 }
    expect(indexToCoord(0, g)).toEqual({ section: "recent", row: 0, col: 0 })
    expect(indexToCoord(7, g)).toEqual({ section: "recent", row: 0, col: 7 })
    expect(indexToCoord(8, g)).toEqual({ section: "recent", row: 1, col: 0 })
    expect(indexToCoord(11, g)).toEqual({ section: "recent", row: 1, col: 3 })
  })

  it("maps indices in the all section", () => {
    const g = { recentCount: 12, allCount: 100, columns: 8 }
    expect(indexToCoord(12, g)).toEqual({ section: "all", row: 0, col: 0 })
    expect(indexToCoord(19, g)).toEqual({ section: "all", row: 0, col: 7 })
    expect(indexToCoord(20, g)).toEqual({ section: "all", row: 1, col: 0 })
  })
})

describe("totalCount", () => {
  it("sums recent and all", () => {
    expect(totalCount({ recentCount: 3, allCount: 100, columns: 8 })).toBe(103)
  })
})

describe("buildQuickEmojis", () => {
  // Extra fixtures for a larger pool so fill-to-count is testable
  const heart = make("heart", "symbols", 1)
  const fire = make("fire", "symbols", 2)
  const joy = make("joy", "smileys", 3)
  const pool = [smile, grin, dog, cat, pizza, rocket, flag, heart, fire, joy]

  it("returns empty when emojis array is empty", () => {
    expect(buildQuickEmojis([], {}, 6)).toEqual([])
  })

  it("fills from weighted emojis first, sorted by weight desc", () => {
    const weights = { dog: 5, smile: 10, pizza: 2 }
    const result = buildQuickEmojis(pool, weights, 3)
    expect(result.map((e) => e.shortcode)).toEqual(["smile", "dog", "pizza"])
  })

  it("falls back to defaults when weighted emojis are insufficient", () => {
    // Only 1 weighted emoji; defaults fill the rest
    const weights = { dog: 3 }
    const defaults = ["smile", "grin"]
    const result = buildQuickEmojis(pool, weights, 3, defaults)
    expect(result.map((e) => e.shortcode)).toEqual(["dog", "smile", "grin"])
  })

  it("falls back to default order when defaults are also exhausted", () => {
    // No weights, no defaults — result comes from sortByDefaultOrder
    const result = buildQuickEmojis(pool, {}, 3, [])
    // sortByDefaultOrder: smileys first (smile, grin, joy), then animals...
    expect(result.map((e) => e.shortcode)).toEqual(["smile", "grin", "joy"])
  })

  it("always fills to count across all three passes", () => {
    const result = buildQuickEmojis(pool, {}, 6, ["smile", "grin"])
    expect(result).toHaveLength(6)
    // smile + grin from defaults, then 4 from sortByDefaultOrder (excluding smile/grin)
    expect(result.map((e) => e.shortcode)).toContain("smile")
    expect(result.map((e) => e.shortcode)).toContain("grin")
  })

  it("excludes shortcodes in excludeShortcodes from all passes", () => {
    const weights = { smile: 10, dog: 5 }
    const excluded = new Set(["smile", "dog"])
    const result = buildQuickEmojis(pool, weights, 2, [], excluded)
    expect(result.map((e) => e.shortcode)).not.toContain("smile")
    expect(result.map((e) => e.shortcode)).not.toContain("dog")
    expect(result).toHaveLength(2)
  })

  it("respects the count parameter", () => {
    expect(buildQuickEmojis(pool, {}, 2)).toHaveLength(2)
    expect(buildQuickEmojis(pool, {}, 8)).toHaveLength(8)
  })

  it("never produces duplicates across passes", () => {
    // smile appears in both weights and defaults — should appear only once
    const weights = { smile: 1 }
    const defaults = ["smile", "grin"]
    const result = buildQuickEmojis(pool, weights, 4, defaults)
    const codes = result.map((e) => e.shortcode)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it("returns fewer than count when not enough emojis exist", () => {
    const tiny = [smile, grin]
    const result = buildQuickEmojis(tiny, {}, 6, [])
    expect(result).toHaveLength(2)
  })
})

describe("moveSelection", () => {
  const g = { recentCount: 12, allCount: 100, columns: 8 }

  it("ArrowRight moves forward across the whole flat space", () => {
    expect(moveSelection(0, "ArrowRight", g)).toBe(1)
    expect(moveSelection(11, "ArrowRight", g)).toBe(12) // recent → all
    expect(moveSelection(111, "ArrowRight", g)).toBe(111) // last item clamps
  })

  it("ArrowLeft moves backward across sections", () => {
    expect(moveSelection(12, "ArrowLeft", g)).toBe(11)
    expect(moveSelection(0, "ArrowLeft", g)).toBe(0)
  })

  describe("ArrowDown", () => {
    it("moves within recent when next row exists and has the col", () => {
      // row 0 col 3 (index 3) → row 1 col 3 (index 11), which exists (recent has 12 items)
      expect(moveSelection(3, "ArrowDown", g)).toBe(11)
    })

    it("from last full recent row jumps to all row 0 same col", () => {
      const full = { recentCount: 8, allCount: 100, columns: 8 }
      // index 3 is row 0 col 3 (last recent row) → all row 0 col 3 = 8 + 3 = 11
      expect(moveSelection(3, "ArrowDown", full)).toBe(11)
    })

    it("from partial last recent row, col past the end, jumps to all row 0 same col", () => {
      // recent = 12, cols = 8: row 1 has cols 0..3. Starting at row 0 col 5 (index 5),
      // next row 1 has no col 5. Jump to all row 0 col 5 = 12 + 5 = 17.
      expect(moveSelection(5, "ArrowDown", g)).toBe(17)
    })

    it("from within recent bottom-partial row, jumps to all at same col", () => {
      // index 10 = recent row 1 col 2, last row in recent. → all row 0 col 2 = 14
      expect(moveSelection(10, "ArrowDown", g)).toBe(14)
    })

    it("moves within all by one row", () => {
      expect(moveSelection(12, "ArrowDown", g)).toBe(20)
    })

    it("at last all row, does not move", () => {
      // last row contains the final item at index 111 (total 112). row = 12.
      const lastInAll = 111
      expect(moveSelection(lastInAll, "ArrowDown", g)).toBe(lastInAll)
    })

    it("from partial last recent row clamps to last all item when col exceeds all", () => {
      const small = { recentCount: 3, allCount: 2, columns: 8 }
      // recent row 0 col 2 (index 2), last recent row. all has 2 items.
      // target col 2 in all → clamp to index recentCount + allCount - 1 = 4
      expect(moveSelection(2, "ArrowDown", small)).toBe(4)
    })

    it("with no all section, stays at current", () => {
      const onlyRecent = { recentCount: 3, allCount: 0, columns: 8 }
      expect(moveSelection(2, "ArrowDown", onlyRecent)).toBe(2)
    })
  })

  describe("ArrowUp", () => {
    it("from all row 0 jumps back into recent last row same col", () => {
      // all row 0 col 5 (index 17) → recent has 12 items, last row is row 1 (cols 0..3).
      // target col 5 → clamp to last recent index = 11.
      expect(moveSelection(17, "ArrowUp", g)).toBe(11)
    })

    it("from all row 0 col within recent last row, preserves col", () => {
      // all row 0 col 2 (index 14) → recent last row (row 1) col 2 = index 10.
      expect(moveSelection(14, "ArrowUp", g)).toBe(10)
    })

    it("from all row 0 with no recent, stays", () => {
      const noRecent = { recentCount: 0, allCount: 100, columns: 8 }
      expect(moveSelection(3, "ArrowUp", noRecent)).toBe(3)
    })

    it("within all, moves up by one row", () => {
      expect(moveSelection(20, "ArrowUp", g)).toBe(12)
    })

    it("within recent, moves up by one row", () => {
      expect(moveSelection(10, "ArrowUp", g)).toBe(2)
    })

    it("at recent row 0, does not move", () => {
      expect(moveSelection(3, "ArrowUp", g)).toBe(3)
    })
  })
})
