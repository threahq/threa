import type { ComponentType } from "react"
import { Moon, Sparkles } from "lucide-react"
import { CompanionModes, type CompanionMode, type ToolPrivacyCategory, type ToolPrivacyPolicy } from "@threa/types"
import { cn } from "@/lib/utils"
import { Label } from "@/components/ui/label"
import { useDraftScratchpads } from "@/hooks/use-draft-scratchpads"
import { ToolPolicyControl } from "./tool-policy-picker"

interface DraftAgentSettingsProps {
  workspaceId: string
  draftId: string
  companionMode: CompanionMode
  allowedToolCategories: ToolPrivacyPolicy
  configuredCategories?: ToolPrivacyCategory[]
}

/**
 * In-flow agent settings for a not-yet-created scratchpad: companion mode and
 * tool access, written to the local draft and threaded into the create request
 * on the first message. Drafts are always plaintext (encrypted scratchpads skip
 * the draft system), so the enclave "not yet" gating never applies here.
 */
export function DraftAgentSettings({
  workspaceId,
  draftId,
  companionMode,
  allowedToolCategories,
  configuredCategories,
}: DraftAgentSettingsProps) {
  const { updateDraft } = useDraftScratchpads(workspaceId)

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-sm font-medium">Companion mode</Label>
        <div role="radiogroup" aria-label="Companion mode" className="grid grid-cols-2 gap-2">
          <ModeButton
            selected={companionMode === CompanionModes.ON}
            onSelect={() => updateDraft(draftId, { companionMode: CompanionModes.ON })}
            icon={Sparkles}
            label="Companion"
          />
          <ModeButton
            selected={companionMode === CompanionModes.OFF}
            onSelect={() => updateDraft(draftId, { companionMode: CompanionModes.OFF })}
            icon={Moon}
            label="Quiet"
          />
        </div>
      </div>

      <div className="border-t pt-4">
        <ToolPolicyControl
          value={allowedToolCategories}
          onChange={(next) => updateDraft(draftId, { allowedToolCategories: next })}
          configuredCategories={configuredCategories}
          e2e={false}
        />
      </div>
    </div>
  )
}

interface ModeButtonProps {
  selected: boolean
  onSelect: () => void
  icon: ComponentType<{ className?: string }>
  label: string
}

function ModeButton({ selected, onSelect, icon: Icon, label }: ModeButtonProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      role="radio"
      aria-checked={selected}
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2.5 py-2 text-sm transition-colors",
        selected ? "border-primary bg-primary/5" : "border-border hover:bg-accent"
      )}
    >
      <Icon className={cn("h-3.5 w-3.5", selected ? "text-primary" : "text-muted-foreground")} />
      <span className={cn("font-medium", selected ? "text-foreground" : "text-muted-foreground")}>{label}</span>
    </button>
  )
}
