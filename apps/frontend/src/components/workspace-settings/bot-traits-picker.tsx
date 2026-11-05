import { useId } from "react"
import { BOT_TRAITS, type BotTrait } from "@threahq/types"
import { SettingCheckboxList } from "@/components/settings/setting-lists"
import { SETTING_MUTED_NOTE_TEXT } from "@/components/settings/setting-text"

export const BOT_TRAIT_LABELS: Record<BotTrait, string> = {
  mentionable: "Mentionable",
  "active-scratchpad": "Active scratchpad",
}

const BOT_TRAIT_DESCRIPTIONS: Record<BotTrait, string> = {
  mentionable: "Can be invoked by @mention where it has access.",
  "active-scratchpad": "Receives messages from scratchpads where this bot is the active actor.",
}

const TRAIT_ITEMS = BOT_TRAITS.map((trait) => ({
  value: trait,
  label: BOT_TRAIT_LABELS[trait],
  description: BOT_TRAIT_DESCRIPTIONS[trait],
}))

interface BotTraitsPickerProps {
  traits: ReadonlySet<BotTrait>
  onChange: (trait: BotTrait, checked: boolean) => void
  disabled?: boolean
}

export function BotTraitsPicker({ traits, onChange, disabled }: BotTraitsPickerProps) {
  const labelId = useId()
  const descriptionId = useId()
  return (
    <div className="space-y-1">
      <p id={labelId} className="text-sm font-medium">
        Capabilities
      </p>
      <p id={descriptionId} className={SETTING_MUTED_NOTE_TEXT}>
        How Threa can route work to this bot. Pi remote needs Active scratchpad.
      </p>
      <SettingCheckboxList
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        items={TRAIT_ITEMS}
        selected={traits}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </div>
  )
}
