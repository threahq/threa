/**
 * Script to add group and order information to emoji-data.json
 * Uses Unicode emoji-test.txt to get official emoji groupings
 *
 * Run: bun apps/backend/scripts/add-emoji-groups.ts
 */

import { readFileSync, writeFileSync } from "fs"
import { join } from "path"

const EMOJI_TEST_URL = "https://unicode.org/Public/emoji/16.0/emoji-test.txt"

interface EmojiEntry {
  emoji: string
  shortcodes: string[]
  group?: string
  order?: number
}

interface EmojiData {
  emojis: EmojiEntry[]
}

// Map Unicode group names to our simpler group names
const groupMapping: Record<string, string> = {
  "Smileys & Emotion": "smileys",
  "People & Body": "people",
  "Animals & Nature": "animals",
  "Food & Drink": "food",
  "Travel & Places": "travel",
  Activities: "activities",
  Objects: "objects",
  Symbols: "symbols",
  Flags: "flags",
  Component: "component", // Skin tones, etc.
}

async function fetchEmojiTest(): Promise<string> {
  console.log("Fetching emoji-test.txt from Unicode...")
  const response = await fetch(EMOJI_TEST_URL)
  if (!response.ok) {
    throw new Error(`Failed to fetch emoji-test.txt: ${response.status}`)
  }
  return response.text()
}

function parseEmojiTest(text: string): Map<string, { group: string; order: number }> {
  const emojiToGroup = new Map<string, { group: string; order: number }>()
  let currentGroup = ""
  let orderInGroup = 0

  for (const line of text.split("\n")) {
    // Group header: # group: Smileys & Emotion
    if (line.startsWith("# group:")) {
      currentGroup = line.slice(9).trim()
      orderInGroup = 0
      continue
    }

    // Skip comments and empty lines
    if (line.startsWith("#") || !line.trim()) {
      continue
    }

    // Parse emoji line: 1F600 ; fully-qualified # 😀 E1.0 grinning face
    const match = line.match(
      /^([0-9A-F\s]+)\s*;\s*(fully-qualified|minimally-qualified|unqualified|component)\s*#\s*(\S+)/
    )
    if (match) {
      const emoji = match[3]
      const mappedGroup = groupMapping[currentGroup] || "other"

      // Strip variation selectors for consistent matching
      const normalizedEmoji = emoji.replace(/\uFE0F/g, "")

      // Store both variants
      emojiToGroup.set(emoji, { group: mappedGroup, order: orderInGroup })
      if (normalizedEmoji !== emoji) {
        emojiToGroup.set(normalizedEmoji, { group: mappedGroup, order: orderInGroup })
      }

      orderInGroup++
    }
  }

  return emojiToGroup
}

async function main() {
  // Read existing emoji data
  const emojiDataPath = join(import.meta.dir, "../src/features/emoji/emoji-data.json")
  const emojiData: EmojiData = JSON.parse(readFileSync(emojiDataPath, "utf-8"))

  console.log(`Found ${emojiData.emojis.length} emojis in emoji-data.json`)

  // Fetch and parse Unicode emoji test data
  const emojiTestText = await fetchEmojiTest()
  const emojiGroups = parseEmojiTest(emojiTestText)

  console.log(`Parsed ${emojiGroups.size} emoji group mappings from Unicode`)

  // Update emoji data with groups
  let matched = 0
  let unmatched = 0
  const unmatchedEmojis: string[] = []

  for (const entry of emojiData.emojis) {
    const info = emojiGroups.get(entry.emoji) || emojiGroups.get(entry.emoji.replace(/\uFE0F/g, ""))

    if (info) {
      entry.group = info.group
      entry.order = info.order
      matched++
    } else {
      // Default to symbols for unknown emojis
      entry.group = "symbols"
      entry.order = 9999
      unmatched++
      unmatchedEmojis.push(entry.emoji)
    }
  }

  console.log(`Matched: ${matched}, Unmatched: ${unmatched}`)
  if (unmatchedEmojis.length > 0 && unmatchedEmojis.length <= 20) {
    console.log("Unmatched emojis:", unmatchedEmojis)
  }

  // Sort emojis by group order then within-group order
  const groupOrderMap: Record<string, number> = {
    smileys: 0,
    people: 1,
    animals: 2,
    food: 3,
    travel: 4,
    activities: 5,
    objects: 6,
    symbols: 7,
    flags: 8,
    component: 9,
    other: 10,
  }

  emojiData.emojis.sort((a, b) => {
    const groupA = groupOrderMap[a.group!] ?? 10
    const groupB = groupOrderMap[b.group!] ?? 10
    if (groupA !== groupB) return groupA - groupB
    return (a.order ?? 0) - (b.order ?? 0)
  })

  // Write updated data
  writeFileSync(emojiDataPath, JSON.stringify(emojiData, null, 2) + "\n")
  console.log("Updated emoji-data.json with group and order fields")
}

main().catch(console.error)
