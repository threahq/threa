/**
 * Rebuild the `shortcodes` aliases and `keywords` of emoji-data.json from
 * emojibase-data (CLDR annotations + the GitHub/Slack/JoyPixels shortcode sets).
 *
 * Run: bun apps/backend/scripts/build-emoji-aliases.ts
 *
 * Two separate outputs, because they are not interchangeable:
 *
 * - `shortcodes` are resolvable: `:name:` round-trips through toEmoji/toShortcode
 *   and gets persisted, so every one must map to exactly one emoji (enforced by
 *   the collision test in emoji.test.ts). A name already claimed by another emoji
 *   is dropped rather than duplicated.
 * - `keywords` are search-only. They are the CLDR annotation tags ("sad",
 *   "unhappy", "tear"), which are deliberately shared across emoji and would
 *   make `:face:` ambiguous if they were shortcodes.
 *
 * shortcodes[0] is never touched — it is the canonical form already persisted in
 * message content and reactions.
 */

import { readFileSync, writeFileSync } from "fs"
import { join } from "path"

const EMOJIBASE_VERSION = "17.0.0"
const CDN = `https://cdn.jsdelivr.net/npm/emojibase-data@${EMOJIBASE_VERSION}/en`

/** Ordered by how likely a user is to type the set's spelling first. */
const SHORTCODE_SETS = ["github", "iamcal", "emojibase", "joypixels", "cldr"] as const

/** Same body as SHORTCODE_REGEX in emoji.ts — a name that fails it cannot round-trip. */
const SHORTCODE_BODY = /^[a-z0-9_+-]+$/

interface EmojiEntry {
  emoji: string
  shortcodes: string[]
  group?: string
  order?: number
  keywords?: string[]
}

interface EmojibaseEmoji {
  emoji: string
  text?: string
  hexcode: string
  label: string
  tags?: string[]
  skins?: EmojibaseEmoji[]
}

type ShortcodeSet = Record<string, string | string[]>

async function fetchJson<T>(path: string): Promise<T> {
  const url = `${CDN}/${path}`
  console.log(`Fetching ${url}`)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`)
  }
  return response.json() as Promise<T>
}

/** Variation selectors differ between sources; compare without them. */
function normalizeEmoji(emoji: string): string {
  return emoji.replace(/️/g, "")
}

/** Separator-insensitive form, so "thumbs up" and "thumbs_up" compare equal. */
function fold(text: string): string {
  return text.toLowerCase().replace(/[\s_-]/g, "")
}

/**
 * Reduce a CLDR annotation to characters a picker query can plausibly contain:
 * diacritics folded to ASCII, everything outside [a-z0-9 _+-] turned into a
 * separator. Punctuation left in place would match queries no one means —
 * "a button (blood type)" made `:)` match 🅰️, so the classic smiley typo held
 * the emoji popup open and swallowed the Enter that should have sent the
 * message (tests/browser/emoji-shortcuts.spec.ts).
 */
function sanitizeKeyword(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9 _+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function toList(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function indexByEmoji(emojis: EmojibaseEmoji[]): Map<string, EmojibaseEmoji> {
  const index = new Map<string, EmojibaseEmoji>()
  const add = (entry: EmojibaseEmoji) => {
    index.set(normalizeEmoji(entry.emoji), entry)
    if (entry.text) index.set(normalizeEmoji(entry.text), entry)
    for (const skin of entry.skins ?? []) add(skin)
  }
  for (const entry of emojis) add(entry)
  return index
}

async function main() {
  const dataPath = join(import.meta.dir, "../src/features/emoji/emoji-data.json")
  const data: { emojis: EmojiEntry[] } = JSON.parse(readFileSync(dataPath, "utf-8"))
  console.log(`Loaded ${data.emojis.length} emojis from emoji-data.json`)

  const [emojibase, ...shortcodeSets] = await Promise.all([
    fetchJson<EmojibaseEmoji[]>("data.json"),
    ...SHORTCODE_SETS.map((name) => fetchJson<ShortcodeSet>(`shortcodes/${name}.json`)),
  ])

  const byEmoji = indexByEmoji(emojibase)

  const unmatched = data.emojis.filter((entry) => !byEmoji.has(normalizeEmoji(entry.emoji)))
  if (unmatched.length > 0) {
    throw new Error(
      `${unmatched.length} emoji in emoji-data.json are absent from emojibase ${EMOJIBASE_VERSION}: ` +
        unmatched.map((entry) => `${entry.emoji} (${entry.shortcodes[0]})`).join(", ")
    )
  }

  // Every existing shortcode keeps its owner. Set priority beats dataset order:
  // walking one whole set before the next stops a low-priority alias of an early
  // emoji from claiming a name the next set gives to its canonical owner.
  const owner = new Map<string, string>()
  for (const entry of data.emojis) {
    for (const shortcode of entry.shortcodes) owner.set(shortcode, entry.emoji)
  }

  const added: Record<string, number> = {}
  const contested: string[] = []
  for (const [index, set] of shortcodeSets.entries()) {
    const setName = SHORTCODE_SETS[index]
    for (const entry of data.emojis) {
      const source = byEmoji.get(normalizeEmoji(entry.emoji))!
      for (const shortcode of toList(set[source.hexcode])) {
        if (!SHORTCODE_BODY.test(shortcode)) continue
        const existing = owner.get(shortcode)
        if (existing === undefined) {
          owner.set(shortcode, entry.emoji)
          entry.shortcodes.push(shortcode)
          added[setName] = (added[setName] ?? 0) + 1
        } else if (existing !== entry.emoji) {
          contested.push(`${shortcode}: kept by ${existing}, dropped from ${entry.emoji} (${setName})`)
        }
      }
    }
  }

  let keywordCount = 0
  for (const entry of data.emojis) {
    const source = byEmoji.get(normalizeEmoji(entry.emoji))!
    const covered = new Set(entry.shortcodes.map(fold))
    const keywords: string[] = []
    for (const raw of [...(source.tags ?? []), source.label]) {
      const keyword = sanitizeKeyword(raw)
      // A keyword identical to one of this emoji's own shortcodes is pure
      // payload — the shortcode already matches at a strictly better tier.
      if (!keyword || covered.has(fold(keyword))) continue
      covered.add(fold(keyword))
      keywords.push(keyword)
    }
    entry.keywords = keywords
    keywordCount += keywords.length
  }

  // Format through prettier, not bare JSON.stringify: lint-staged reformats the
  // file on commit, so unformatted output makes every regeneration a 14k-line
  // whitespace diff instead of the handful of lines that actually changed.
  const prettier = await import("prettier")
  const config = await prettier.resolveConfig(dataPath)
  writeFileSync(dataPath, await prettier.format(JSON.stringify(data), { ...config, filepath: dataPath }))

  console.log(`Added ${Object.values(added).reduce((sum, n) => sum + n, 0)} shortcodes`, added)
  console.log(`Wrote ${keywordCount} keywords`)
  console.log(`${contested.length} shortcodes were already claimed and dropped:`)
  for (const line of contested) console.log(`  ${line}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
