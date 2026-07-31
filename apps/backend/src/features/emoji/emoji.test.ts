import { describe, test, expect } from "bun:test"
import { toShortcode, toEmoji, isValidShortcode, getShortcodeNames, normalizeMessage } from "./emoji"
import emojiData from "./emoji-data.json"

describe("Emoji Library", () => {
  describe("toShortcode", () => {
    test("should convert raw emoji to shortcode", () => {
      expect(toShortcode("👍")).toBe(":+1:")
      expect(toShortcode("👎")).toBe(":-1:")
      expect(toShortcode("❤️")).toBe(":heart:")
      expect(toShortcode("🎉")).toBe(":tada:")
      expect(toShortcode("🔥")).toBe(":fire:")
      expect(toShortcode("🚀")).toBe(":rocket:")
    })

    test("should pass through valid shortcodes", () => {
      expect(toShortcode(":+1:")).toBe(":+1:")
      expect(toShortcode(":heart:")).toBe(":heart:")
      expect(toShortcode(":fire:")).toBe(":fire:")
      expect(toShortcode(":tada:")).toBe(":tada:")
    })

    test("should handle emoji without variation selector", () => {
      // Heart without FE0F variation selector
      expect(toShortcode("❤")).toBe(":heart:")
    })

    test("should return null for invalid emoji", () => {
      expect(toShortcode("not-an-emoji")).toBeNull()
      expect(toShortcode("123")).toBeNull()
      expect(toShortcode("abc")).toBeNull()
    })

    test("should return null for unknown shortcodes", () => {
      expect(toShortcode(":not_a_real_shortcode:")).toBeNull()
      expect(toShortcode(":unknown_emoji_name:")).toBeNull()
    })

    test("should handle whitespace", () => {
      expect(toShortcode(" 👍 ")).toBe(":+1:")
      expect(toShortcode(" :heart: ")).toBe(":heart:")
    })
  })

  describe("toEmoji", () => {
    test("should convert shortcode to emoji", () => {
      expect(toEmoji(":+1:")).toBe("👍")
      expect(toEmoji(":-1:")).toBe("👎")
      expect(toEmoji(":heart:")).toBe("❤️")
      expect(toEmoji(":tada:")).toBe("🎉")
      expect(toEmoji(":fire:")).toBe("🔥")
    })

    test("should work with shortcode without colons", () => {
      expect(toEmoji("+1")).toBe("👍")
      expect(toEmoji("heart")).toBe("❤️")
      expect(toEmoji("fire")).toBe("🔥")
    })

    test("should return null for unknown shortcodes", () => {
      expect(toEmoji(":not_real:")).toBeNull()
      expect(toEmoji("not_real")).toBeNull()
    })
  })

  describe("isValidShortcode", () => {
    test("should return true for valid shortcodes", () => {
      expect(isValidShortcode(":+1:")).toBe(true)
      expect(isValidShortcode(":heart:")).toBe(true)
      expect(isValidShortcode("+1")).toBe(true)
      expect(isValidShortcode("heart")).toBe(true)
    })

    test("should return false for invalid shortcodes", () => {
      expect(isValidShortcode(":not_a_real_one:")).toBe(false)
      expect(isValidShortcode("not_a_real_one")).toBe(false)
    })
  })

  describe("getShortcodeNames", () => {
    test("should return array of shortcode names", () => {
      const names = getShortcodeNames()
      expect(Array.isArray(names)).toBe(true)
      expect(names.length).toBeGreaterThan(100)
      expect(names).toContain("+1")
      expect(names).toContain("heart")
      expect(names).toContain("fire")
    })
  })

  describe("Common emoji coverage", () => {
    const commonEmoji = [
      { emoji: "😀", shortcode: ":grinning:" },
      { emoji: "😂", shortcode: ":joy:" },
      { emoji: "🤔", shortcode: ":thinking:" },
      { emoji: "👀", shortcode: ":eyes:" },
      { emoji: "✅", shortcode: ":white_check_mark:" },
      { emoji: "❌", shortcode: ":x:" },
      { emoji: "💯", shortcode: ":100:" },
      { emoji: "✨", shortcode: ":sparkles:" },
      { emoji: "👏", shortcode: ":clap:" },
      { emoji: "🙏", shortcode: ":pray:" },
      { emoji: "💪", shortcode: ":muscle:" },
      { emoji: "🧵", shortcode: ":thread:" },
    ]

    for (const { emoji, shortcode } of commonEmoji) {
      test(`should convert ${emoji} to ${shortcode}`, () => {
        expect(toShortcode(emoji)).toBe(shortcode)
      })

      test(`should convert ${shortcode} to ${emoji}`, () => {
        expect(toEmoji(shortcode)).toBe(emoji)
      })
    }
  })

  describe("dataset integrity", () => {
    // The shortcode regex used everywhere a shortcode crosses the wire
    // (composer input rule, toShortcode/toEmoji APIs). If a shortcode in
    // the JSON doesn't satisfy this, it cannot round-trip through the
    // system — catch it here rather than at runtime.
    const SHORTCODE_BODY = /^[a-z0-9_+-]+$/

    test("no shortcode collisions across emojis", () => {
      // Every shortcode (primary or alias) must map to exactly one emoji.
      // Without this, toEmoji() becomes ambiguous and which mapping wins
      // depends on JSON insertion order — a silent footgun when expanding
      // aliases. If this fails, the failure message lists every offending
      // shortcode and the emojis fighting over it.
      const owners = new Map<string, string[]>()
      for (const { emoji, shortcodes } of emojiData.emojis) {
        for (const shortcode of shortcodes) {
          const list = owners.get(shortcode) ?? []
          if (!list.includes(emoji)) list.push(emoji)
          owners.set(shortcode, list)
        }
      }
      const collisions = Array.from(owners.entries())
        .filter(([, emojis]) => emojis.length > 1)
        .map(([shortcode, emojis]) => `${shortcode} -> ${emojis.join(", ")}`)
      expect(collisions).toEqual([])
    })

    test("every shortcode satisfies the wire-format regex", () => {
      const invalid: string[] = []
      for (const { emoji, shortcodes } of emojiData.emojis) {
        for (const shortcode of shortcodes) {
          if (!SHORTCODE_BODY.test(shortcode)) invalid.push(`${emoji} -> "${shortcode}"`)
        }
      }
      expect(invalid).toEqual([])
    })

    test("every emoji has at least one shortcode", () => {
      const empty = emojiData.emojis.filter((entry) => entry.shortcodes.length === 0).map((entry) => entry.emoji)
      expect(empty).toEqual([])
    })

    test("no keyword duplicates a shortcode of the same emoji", () => {
      // Keywords are the lower-ranked search band; one that repeats a shortcode
      // this emoji already owns is payload that can never change a result.
      const fold = (text: string) => text.toLowerCase().replace(/[\s_-]/g, "")
      const redundant: string[] = []
      for (const { emoji, shortcodes, keywords } of emojiData.emojis) {
        const owned = new Set(shortcodes.map(fold))
        for (const keyword of keywords) {
          if (owned.has(fold(keyword))) redundant.push(`${emoji} -> "${keyword}"`)
        }
      }
      expect(redundant).toEqual([])
    })

    test("keywords are lowercase and free of the colon wrapper", () => {
      // Keywords never cross the wire as `:name:`; the only formatting contract
      // is that search compares them lowercased and unwrapped.
      const invalid: string[] = []
      for (const { emoji, keywords } of emojiData.emojis) {
        for (const keyword of keywords) {
          if (keyword !== keyword.toLowerCase().trim() || /^:.*:$/.test(keyword)) {
            invalid.push(`${emoji} -> "${keyword}"`)
          }
        }
      }
      expect(invalid).toEqual([])
    })

    test("primary shortcode is canonical for toShortcode()", () => {
      // shortcodes[0] is the wire-format primary that toShortcode() returns
      // and is what gets persisted, displayed in tooltips, and rendered into
      // markdown. Reordering aliases (e.g. swapping a synonym to first) would
      // silently rewrite normalized output and break message-history parity.
      const mismatches = emojiData.emojis
        .map(({ emoji, shortcodes }) => ({
          emoji,
          expected: `:${shortcodes[0]}:`,
          actual: toShortcode(emoji),
        }))
        .filter(({ expected, actual }) => actual !== expected)
        .map(({ emoji, expected, actual }) => `${emoji}: expected ${expected}, got ${actual}`)
      expect(mismatches).toEqual([])
    })
  })

  describe("plain-language search coverage", () => {
    // The dataset used to carry 1.13 shortcodes per emoji and nothing else, so
    // searching the word a person actually thinks of ("sad", "cheers") returned
    // nothing at all. These are the words, not the shortcode spellings — each
    // must be an exact match on some emoji's shortcode or keyword, and the
    // obvious emoji must be among the matches.
    const expectations: Array<{ query: string; expected: string[] }> = [
      { query: "sad", expected: ["😢", "😭", "😔", "☹️"] },
      { query: "cheers", expected: ["🍻"] },
      { query: "celebrate", expected: ["🎉", "🥳"] },
      { query: "thanks", expected: ["🙏"] },
      { query: "angry", expected: ["😠", "😡"] },
      { query: "confused", expected: ["😕", "🫤"] },
      { query: "tired", expected: ["😴", "🥱"] },
      { query: "hug", expected: ["🤗", "🫂"] },
      { query: "oops", expected: ["🤭"] },
      { query: "excited", expected: ["🤩", "🥳"] },
      { query: "disappointed", expected: ["😔", "😞"] },
      { query: "money", expected: ["💰", "🤑"] },
      { query: "idea", expected: ["💡"] },
      { query: "bug", expected: ["🐛"] },
    ]

    for (const { query, expected } of expectations) {
      test(`"${query}" matches ${expected.join("")}`, () => {
        const matched = new Set(
          emojiData.emojis
            .filter((entry) => entry.shortcodes.includes(query) || entry.keywords.includes(query))
            .map((entry) => entry.emoji)
        )
        expect(expected.filter((emoji) => !matched.has(emoji))).toEqual([])
      })
    }
  })

  describe("Unicode version coverage", () => {
    // Guards against silently falling behind Unicode releases. When a new
    // Emoji version ships, add a block below for it AND add the emojis to
    // emoji-data.json — this test fails on either half being missing.
    //
    // Version labels are best-effort; the test only asserts presence in
    // the dataset, not the exact version. If a label is slightly off
    // (some borderline characters move between 14.0 and 15.0 in different
    // sources), the test still passes as long as the emoji is present.
    const dataset = new Set(emojiData.emojis.map((entry) => entry.emoji))
    const findMissing = (emojis: string[]) => emojis.filter((emoji) => !dataset.has(emoji))

    // Emoji 14.0 (Sept 2021)
    test("supports Emoji 14.0 (2021)", () => {
      const expected = [
        // Faces
        "🥹",
        "🫠",
        "🫡",
        "🫢",
        "🫣",
        "🫤",
        "🫥",
        // Hands
        "🫰",
        "🫱",
        "🫲",
        "🫳",
        "🫴",
        "🫵",
        "🫶",
        // Person
        "🫅",
        "🫃",
        "🫄",
        // Animals & nature
        "🪺",
        "🪹",
        "🪷",
        "🪸",
        // Food & drink
        "🫘",
        "🫗",
        "🫙",
        // Travel
        "🛞",
        // Objects
        "🩼",
        "🩻",
        "🪪",
        "🪫",
        "🪩",
        "🛟",
        "🪬",
        "🪮",
        "🪯",
        // Symbols
        "🟰",
        "🫧",
      ]
      expect(findMissing(expected)).toEqual([])
    })

    // Emoji 15.0 (Sept 2022)
    test("supports Emoji 15.0 (2022)", () => {
      const expected = [
        // Faces
        "🫨",
        // Hands
        "🫷",
        "🫸",
        // Animals
        "🐦‍⬛",
        "🪿",
        "🪼",
        "🪽",
        "🫎",
        "🫏",
        // Plants
        "🪻",
        // Food
        "🫚",
        "🫛",
        // Activities
        "🪈",
        "🪇",
        // Objects
        "🪭",
        // Hearts & symbols
        "🛜",
        "🩷",
        "🩵",
        "🩶",
      ]
      expect(findMissing(expected)).toEqual([])
    })

    // Emoji 15.1 (Sept 2023) — small release of ZWJ sequences
    test("supports Emoji 15.1 (2023)", () => {
      const expected = ["🐦‍🔥", "🍋‍🟩", "🍄‍🟫", "⛓️‍💥"]
      expect(findMissing(expected)).toEqual([])
    })

    // Emoji 16.0 (Sept 2024)
    test("supports Emoji 16.0 (2024)", () => {
      const expected = ["🫩", "🫆", "🪾", "🫜", "🪉", "🪏", "🫟"]
      expect(findMissing(expected)).toEqual([])
    })

    // Explicit guard for the rightwards-hand family. The version blocks
    // above could be reorganized or split; this test pins the specific
    // hand emojis and their canonical/aliased shortcode lookups.
    test("supports the rightwards-hand family (regression guard)", () => {
      expect(findMissing(["🫱", "🫲", "🫳", "🫴", "🫵", "🫶"])).toEqual([])
      expect(toEmoji(":rightwards_hand:")).toBe("🫱")
      expect(toEmoji(":open_hand_right:")).toBe("🫱")
    })
  })

  describe("normalizeMessage", () => {
    test("should convert emoji in text to shortcodes", () => {
      expect(normalizeMessage("Hi there 👋")).toBe("Hi there :wave:")
      expect(normalizeMessage("Great job! 👍")).toBe("Great job! :+1:")
      expect(normalizeMessage("I ❤️ this")).toBe("I :heart: this")
    })

    test("should handle multiple emoji", () => {
      expect(normalizeMessage("🎉 Party time! 🚀")).toBe(":tada: Party time! :rocket:")
      expect(normalizeMessage("👍👍👍")).toBe(":+1::+1::+1:")
    })

    test("should leave text without emoji unchanged", () => {
      expect(normalizeMessage("Hello world")).toBe("Hello world")
      expect(normalizeMessage("No emoji here!")).toBe("No emoji here!")
    })

    test("should leave existing shortcodes unchanged", () => {
      expect(normalizeMessage("Already :+1: normalized")).toBe("Already :+1: normalized")
    })

    test("should handle emoji without variation selector", () => {
      expect(normalizeMessage("Love ❤")).toBe("Love :heart:")
    })

    test("should handle complex emoji sequences", () => {
      // Pirate flag is in our mapping
      expect(normalizeMessage("Arr 🏴‍☠️")).toBe("Arr :pirate_flag:")
    })
  })
})
