/**
 * Rebuild emoji-data.json from its two upstream sources.
 *
 * Run: bun apps/backend/scripts/build-emoji-data.ts
 *
 * Each source is used only for what it is authoritative for:
 *
 * - Unicode `emoji-test.txt` decides WHICH emoji exist, their fully-qualified
 *   character form, their group, and their in-group order. Its listing order is
 *   the order the picker renders.
 * - `emojibase-data` supplies the searchable text: CLDR annotation `tags` and
 *   the GitHub/Slack/emojibase/JoyPixels/CLDR shortcode sets.
 *
 * Two output fields that are NOT interchangeable:
 *
 * - `shortcodes` are resolvable: `:name:` round-trips through toEmoji/toShortcode
 *   and gets persisted, so every one must map to exactly one emoji (enforced by
 *   the collision test in emoji.test.ts). A name already claimed by another emoji
 *   is dropped rather than duplicated.
 * - `keywords` are search-only — the CLDR tags ("sad", "unhappy", "tear"), which
 *   are deliberately shared across emoji and would make `:face:` ambiguous if
 *   they were shortcodes.
 *
 * `shortcodes[0]` is never touched for an emoji already in the file: it is the
 * canonical form already persisted in message content and reactions.
 */

import { readFileSync, writeFileSync } from "fs"
import { join } from "path"

const EMOJIBASE_VERSION = "17.0.0"
const EMOJIBASE_CDN = `https://cdn.jsdelivr.net/npm/emojibase-data@${EMOJIBASE_VERSION}/en`

/**
 * Unicode publishes each release under /Public/emoji/<version>/, but only once
 * it is superseded — the current release lives at `latest` and nowhere else.
 * EXPECTED_EMOJI_VERSION pins what we think `latest` is, so a Unicode release
 * lands as a loud failure here instead of a silent dataset change.
 */
const EMOJI_TEST_URL = "https://unicode.org/Public/emoji/latest/emoji-test.txt"
const EXPECTED_EMOJI_VERSION = "17.0"

/** Ordered by how likely a user is to type the set's spelling first. */
const SHORTCODE_SETS = ["github", "iamcal", "emojibase", "joypixels", "cldr"] as const

/** Same body as SHORTCODE_REGEX in emoji.ts — a name that fails it cannot round-trip. */
const SHORTCODE_BODY = /^[a-z0-9_+-]+$/

/**
 * Names for emoji whose every upstream shortcode is already owned by an emoji
 * we shipped first. 🧒 is called "child" by all five sets, but `:child:` has
 * been 💒's primary since the original hand-curated file — a typo we cannot undo
 * without changing what already-persisted `:child:` renders as.
 *
 * The nameless check at the end of main() is what tells you an entry belongs
 * here; do not add one speculatively.
 */
const SHORTCODE_OVERRIDES: Record<string, string> = {
  "🧒": "kid",
}

/** Unicode group name -> our group name. Component is dropped entirely. */
const GROUPS: Record<string, string> = {
  "Smileys & Emotion": "smileys",
  "People & Body": "people",
  "Animals & Nature": "animals",
  "Food & Drink": "food",
  "Travel & Places": "travel",
  Activities: "activities",
  Objects: "objects",
  Symbols: "symbols",
  Flags: "flags",
}

/**
 * Skin-tone modifiers multiply the set ~2x with variants of emoji already listed
 * in their base form. The picker offers no tone selector, so they would only
 * bloat the payload.
 */
const SKIN_TONE = /[\u{1F3FB}-\u{1F3FF}]/u

interface EmojiEntry {
  emoji: string
  shortcodes: string[]
  group: string
  order: number
  keywords: string[]
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

async function fetchText(url: string): Promise<string> {
  console.log(`Fetching ${url}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`)
  return response.text()
}

async function fetchJson<T>(path: string): Promise<T> {
  return JSON.parse(await fetchText(`${EMOJIBASE_CDN}/${path}`)) as T
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

/** Every emoji Unicode lists, in listing order, with its group. */
function parseEmojiTest(text: string): Array<{ emoji: string; group: string }> {
  const version = text.match(/^# Version: ([0-9.]+)/m)?.[1]
  if (version !== EXPECTED_EMOJI_VERSION) {
    throw new Error(
      `${EMOJI_TEST_URL} is Emoji ${version}, expected ${EXPECTED_EMOJI_VERSION}. ` +
        `Bump EXPECTED_EMOJI_VERSION and add a coverage block to emoji.test.ts.`
    )
  }

  const entries: Array<{ emoji: string; group: string }> = []
  let group = ""
  for (const line of text.split("\n")) {
    if (line.startsWith("# group:")) {
      group = line.slice(8).trim()
      continue
    }
    const match = line.match(/^[0-9A-F ]+;\s*fully-qualified\s*#\s*(\S+)/)
    if (!match) continue
    const emoji = match[1]
    const mapped = GROUPS[group]
    if (!mapped || SKIN_TONE.test(emoji)) continue
    entries.push({ emoji, group: mapped })
  }
  return entries
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
  const existing: { emojis: EmojiEntry[] } = JSON.parse(readFileSync(dataPath, "utf-8"))
  console.log(`Loaded ${existing.emojis.length} emojis from emoji-data.json`)

  const [emojiTest, emojibase, ...shortcodeSets] = await Promise.all([
    fetchText(EMOJI_TEST_URL),
    fetchJson<EmojibaseEmoji[]>("data.json"),
    ...SHORTCODE_SETS.map((name) => fetchJson<ShortcodeSet>(`shortcodes/${name}.json`)),
  ])

  const unicodeEmojis = parseEmojiTest(emojiTest)
  const bySource = indexByEmoji(emojibase)
  const previous = new Map(existing.emojis.map((entry) => [normalizeEmoji(entry.emoji), entry]))

  // Dropping an emoji would strand every `:shortcode:` already persisted for it,
  // so a disappearance is a hard failure, never a silent trim.
  const dropped = existing.emojis.filter(
    (entry) => !unicodeEmojis.some(({ emoji }) => normalizeEmoji(emoji) === normalizeEmoji(entry.emoji))
  )
  if (dropped.length > 0) {
    throw new Error(
      `${dropped.length} emoji in emoji-data.json are absent from Emoji ${EXPECTED_EMOJI_VERSION}: ` +
        dropped.map((entry) => `${entry.emoji} (${entry.shortcodes[0]})`).join(", ")
    )
  }

  const orderInGroup = new Map<string, number>()
  const entries: EmojiEntry[] = []
  const added: EmojiEntry[] = []
  for (const { emoji, group } of unicodeEmojis) {
    const order = orderInGroup.get(group) ?? 0
    orderInGroup.set(group, order + 1)

    const prior = previous.get(normalizeEmoji(emoji))
    const entry: EmojiEntry = {
      emoji,
      shortcodes: prior ? [...prior.shortcodes] : [],
      group,
      order,
      keywords: [],
    }
    entries.push(entry)
    if (!prior) added.push(entry)
  }

  // Every shortcode already in the file keeps its owner, and existing emoji are
  // offered each set before new ones. Set priority beats listing order: walking
  // one whole set before the next stops a low-priority alias of an early emoji
  // from claiming a name the next set gives its canonical owner.
  const owner = new Map<string, string>()
  for (const entry of entries) {
    for (const shortcode of entry.shortcodes) owner.set(shortcode, entry.emoji)
  }

  for (const [emoji, shortcode] of Object.entries(SHORTCODE_OVERRIDES)) {
    const entry = added.find((candidate) => normalizeEmoji(candidate.emoji) === normalizeEmoji(emoji))
    if (!entry) throw new Error(`SHORTCODE_OVERRIDES has ${emoji}, which is not a new emoji — drop the entry`)
    if (owner.has(shortcode))
      throw new Error(`SHORTCODE_OVERRIDES gives ${emoji} "${shortcode}", owned by ${owner.get(shortcode)}`)
    owner.set(shortcode, entry.emoji)
    entry.shortcodes.push(shortcode)
  }

  const claimOrder = [...entries.filter((entry) => entry.shortcodes.length > 0), ...added]
  const claimed: Record<string, number> = {}
  const contested: string[] = []
  for (const [index, set] of shortcodeSets.entries()) {
    const setName = SHORTCODE_SETS[index]
    for (const entry of claimOrder) {
      const source = bySource.get(normalizeEmoji(entry.emoji))
      if (!source) continue
      for (const shortcode of toList(set[source.hexcode])) {
        if (!SHORTCODE_BODY.test(shortcode)) continue
        const existingOwner = owner.get(shortcode)
        if (existingOwner === undefined) {
          owner.set(shortcode, entry.emoji)
          entry.shortcodes.push(shortcode)
          claimed[setName] = (claimed[setName] ?? 0) + 1
        } else if (existingOwner !== entry.emoji) {
          contested.push(`${shortcode}: kept by ${existingOwner}, dropped from ${entry.emoji} (${setName})`)
        }
      }
    }
  }

  let keywordCount = 0
  for (const entry of entries) {
    const source = bySource.get(normalizeEmoji(entry.emoji))
    if (!source) continue
    const covered = new Set(entry.shortcodes.map(fold))
    for (const raw of [...(source.tags ?? []), source.label]) {
      const keyword = sanitizeKeyword(raw)
      // A keyword identical to one of this emoji's own shortcodes is pure
      // payload — the shortcode already matches at a strictly better tier.
      if (!keyword || covered.has(fold(keyword))) continue
      covered.add(fold(keyword))
      entry.keywords.push(keyword)
      keywordCount++
    }
  }

  const nameless = entries.filter((entry) => entry.shortcodes.length === 0)
  if (nameless.length > 0) {
    throw new Error(
      `${nameless.length} emoji ended with no shortcode and would be unreachable: ` +
        nameless.map((entry) => entry.emoji).join(" ")
    )
  }

  // Format through prettier, not bare JSON.stringify: lint-staged reformats the
  // file on commit, so unformatted output makes every regeneration a 14k-line
  // whitespace diff instead of the handful of lines that actually changed.
  const prettier = await import("prettier")
  const config = await prettier.resolveConfig(dataPath)
  writeFileSync(dataPath, await prettier.format(JSON.stringify({ emojis: entries }), { ...config, filepath: dataPath }))

  console.log(`Wrote ${entries.length} emojis (${added.length} new), ${keywordCount} keywords`)
  console.log(`Claimed ${Object.values(claimed).reduce((sum, n) => sum + n, 0)} shortcodes`, claimed)
  console.log(`${contested.length} shortcodes were already claimed and dropped`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
