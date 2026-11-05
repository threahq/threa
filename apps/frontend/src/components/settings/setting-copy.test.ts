import { describe, expect, it } from "vitest"
import { DESKTOP_SURFACE_OPTIONS, LAYOUT_OPTIONS, MIRROR_OPTIONS } from "./call-settings"
import { FONT_FAMILY_CHOICES } from "./appearance-settings"
import { DATE_FORMAT_CHOICES } from "./datetime-settings"
import { MODEL_OPTIONS, POLISH_OPTIONS } from "./dictation-settings"
import { INBOX_CLEAR_CHOICES, UNREAD_OPEN_CHOICES } from "./inbox-settings"
import { CODE_BLOCK_WRAP_DESCRIPTIONS } from "./messages-settings"
import { NOTIFICATION_LEVEL_DESCRIPTIONS } from "./notifications-settings"
import { SEND_KEY_CHOICE_DESCRIPTIONS, SETTINGS, settingDef, type SettingId } from "./settings-registry"

type Described = { description?: string }

/** Every choice whose options carry descriptions, shown beside the setting's own. */
const OPTION_DESCRIPTIONS: Partial<Record<SettingId, readonly (string | undefined)[]>> = {
  "dictation-polish": POLISH_OPTIONS.map((option) => option.description),
  "dictation-model": MODEL_OPTIONS.map((option) => option.description),
  "call-mirror": MIRROR_OPTIONS.map((option) => option.description),
  "call-layout": LAYOUT_OPTIONS.map((option) => option.description),
  "call-desktop-video": DESKTOP_SURFACE_OPTIONS.map((option) => option.description),
  "unread-landing": Object.values<Described>(UNREAD_OPEN_CHOICES).map((choice) => choice.description),
  settling: Object.values<Described>(INBOX_CLEAR_CHOICES).map((choice) => choice.description),
  "font-family": Object.values<Described>(FONT_FAMILY_CHOICES).map((choice) => choice.description),
  "date-format": Object.values<Described>(DATE_FORMAT_CHOICES).map((choice) => choice.description),
  "code-wrap": Object.values(CODE_BLOCK_WRAP_DESCRIPTIONS),
  "notification-level": Object.values(NOTIFICATION_LEVEL_DESCRIPTIONS),
  "send-key": Object.values(SEND_KEY_CHOICE_DESCRIPTIONS),
}

function sentences(text: string | undefined): string[] {
  if (!text) return []
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) =>
      sentence
        .trim()
        .replace(/[.!?]$/, "")
        .toLowerCase()
    )
    .filter(Boolean)
}

/** Named UI, such as “Show original”: a row that names it twice explains it twice. */
function quotedNames(text: string | undefined): string[] {
  return [...(text ?? "").matchAll(/“([^”]+)”/g)].map((match) => match[1].toLowerCase())
}

function shared(left: string[], right: string[]): string[] {
  return left.filter((item) => right.includes(item))
}

describe("settings copy says each thing once", () => {
  it("no option description repeats a sentence or a named control from its setting's description", () => {
    const repeats = Object.entries(OPTION_DESCRIPTIONS).flatMap(([id, options]) => {
      const description = settingDef(id as SettingId).description
      return (options ?? []).flatMap((option) =>
        [
          ...shared(sentences(option), sentences(description)),
          ...shared(quotedNames(option), quotedNames(description)),
        ].map((repeat) => `${id}: ${repeat}`)
      )
    })

    expect(repeats).toEqual([])
  })

  it("no two settings in a section share a sentence of description", () => {
    const bySection = new Map<string, { id: string; sentences: string[] }[]>()
    for (const [id, def] of Object.entries(SETTINGS) as [string, Described & { section: string }][]) {
      const rows = bySection.get(def.section) ?? []
      rows.push({ id, sentences: sentences(def.description) })
      bySection.set(def.section, rows)
    }

    const repeats = [...bySection.values()].flatMap((rows) =>
      rows.flatMap((row, index) =>
        rows
          .slice(index + 1)
          .flatMap((other) =>
            shared(row.sentences, other.sentences).map((repeat) => `${row.id}/${other.id}: ${repeat}`)
          )
      )
    )

    expect(repeats).toEqual([])
  })
})
