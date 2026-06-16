import emojiData from "./emoji-data.json"

const SHORTCODE_REGEX = /^:[a-z0-9_+-]+:$/

const emojiToShortcode = new Map<string, string>()
const shortcodeToEmoji = new Map<string, string>()

for (const { emoji, shortcodes } of emojiData.emojis) {
  // First shortcode is the canonical/default one
  const primaryShortcode = shortcodes[0]

  for (const shortcode of shortcodes) {
    shortcodeToEmoji.set(shortcode, emoji)
  }

  if (!emojiToShortcode.has(emoji)) {
    emojiToShortcode.set(emoji, primaryShortcode)
  }

  // Also index emoji without variation selector so a stripped-FE0F lookup hits.
  const withoutVariation = emoji.replace(/\uFE0F/g, "")
  if (withoutVariation !== emoji && !emojiToShortcode.has(withoutVariation)) {
    emojiToShortcode.set(withoutVariation, primaryShortcode)
  }
}

/**
 * Normalize raw emoji (👍) or a shortcode (:+1:) to a colon-wrapped shortcode,
 * or null when the input maps to no known emoji.
 */
export function toShortcode(input: string): string | null {
  const trimmed = input.trim()

  if (SHORTCODE_REGEX.test(trimmed)) {
    const name = trimmed.slice(1, -1)
    if (shortcodeToEmoji.has(name)) {
      return trimmed
    }
    return null
  }

  const name = emojiToShortcode.get(trimmed)
  if (name) {
    return `:${name}:`
  }

  const withoutVariationSelector = trimmed.replace(/\uFE0F/g, "")
  const nameWithout = emojiToShortcode.get(withoutVariationSelector)
  if (nameWithout) {
    return `:${nameWithout}:`
  }

  return null
}

/**
 * Convert a shortcode (with or without colons) to its emoji, or null if unknown.
 */
export function toEmoji(shortcode: string): string | null {
  const trimmed = shortcode.trim()

  const name = trimmed.startsWith(":") && trimmed.endsWith(":") ? trimmed.slice(1, -1) : trimmed

  return shortcodeToEmoji.get(name) ?? null
}

/** Whether a shortcode (with or without colons) exists in the mapping. */
export function isValidShortcode(shortcode: string): boolean {
  const trimmed = shortcode.trim()
  const name = trimmed.startsWith(":") && trimmed.endsWith(":") ? trimmed.slice(1, -1) : trimmed
  return shortcodeToEmoji.has(name)
}

/** All available shortcode names, without colons. */
export function getShortcodeNames(): string[] {
  return Array.from(shortcodeToEmoji.keys())
}

// Regex to match emoji in text (covers most emoji including compound sequences)
const EMOJI_REGEX =
  /(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji_Modifier_Base})(\p{Emoji_Modifier}|\uFE0F|\u200D(\p{Extended_Pictographic}|\p{Emoji_Presentation}))*/gu

/**
 * Replace every known raw emoji (👍) in a message with its shortcode (:+1:),
 * leaving unknown emoji unchanged.
 */
export function normalizeMessage(message: string): string {
  return message.replace(EMOJI_REGEX, (match) => {
    const shortcode = emojiToShortcode.get(match)
    if (shortcode) {
      return `:${shortcode}:`
    }
    const withoutVariation = match.replace(/\uFE0F/g, "")
    const shortcodeWithout = emojiToShortcode.get(withoutVariation)
    if (shortcodeWithout) {
      return `:${shortcodeWithout}:`
    }
    return match
  })
}

export interface EmojiEntry {
  shortcode: string
  emoji: string
  type: "native" | "custom"
  group: string
  order: number
  aliases: string[]
}

/** All emojis in API response format, each with its primary shortcode and aliases. */
export function getEmojiList(): EmojiEntry[] {
  return emojiData.emojis.map(({ emoji, shortcodes, group, order }) => ({
    shortcode: shortcodes[0],
    emoji,
    type: "native" as const,
    group: group ?? "symbols",
    order: order ?? 9999,
    aliases: shortcodes,
  }))
}
