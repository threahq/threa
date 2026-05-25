import { BOT_TRAITS, type BotTrait } from "@threa/types"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"

interface BotTraitsPickerProps {
  traits: ReadonlySet<BotTrait>
  onToggle: (trait: BotTrait) => void
}

export function BotTraitsPicker({ traits, onToggle }: BotTraitsPickerProps) {
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div>
        <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Capabilities</Label>
        <p className="text-xs text-muted-foreground mt-1">
          Enable how Threa can route work to this bot. Pi remote needs Active scratchpad.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {BOT_TRAITS.map((trait) => (
          <label key={trait} className="flex items-start gap-2 rounded-md border px-2.5 py-2 text-sm">
            <Checkbox checked={traits.has(trait)} onCheckedChange={() => onToggle(trait)} />
            <span>
              <span className="block font-medium">
                {trait === "active-scratchpad" ? "Active scratchpad" : "Mentionable"}
              </span>
              <span className="block text-xs text-muted-foreground">
                {trait === "active-scratchpad"
                  ? "Receives messages from scratchpads where this bot is the active actor."
                  : "Can be invoked by @mention where it has access."}
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}
