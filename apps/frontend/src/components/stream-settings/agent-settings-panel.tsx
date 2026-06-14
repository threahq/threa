import type { ComponentType } from "react"
import { Moon, Sparkles } from "lucide-react"
import { CompanionModes, type CompanionMode, type ToolPrivacyCategory, type ToolPrivacyPolicy } from "@threa/types"
import { cn } from "@/lib/utils"
import { Label } from "@/components/ui/label"
import { ToolPolicyControl } from "./tool-policy-picker"

export interface AgentToolPolicyBinding {
  value: ToolPrivacyPolicy
  onChange: (next: ToolPrivacyPolicy) => void
  configuredCategories?: ToolPrivacyCategory[]
  /** Encrypted scratchpad: non-web categories render disabled, with a reason. */
  e2e: boolean
  busy?: boolean
}

interface AgentSettingsPanelProps {
  companionMode: CompanionMode
  onCompanionModeChange: (mode: CompanionMode) => void
  companionBusy?: boolean
  /** Tool-access section; omit to hide it (e.g. the viewer isn't the owner). */
  toolPolicy?: AgentToolPolicyBinding
}

/**
 * The compact agent-settings panel shown from the scratchpad pill — companion
 * mode and (for the owner) tool access. One presentational surface for both
 * drafts (writes to the local draft) and live scratchpads (live mutations); the
 * caller wires the handlers.
 */
export function AgentSettingsPanel({
  companionMode,
  onCompanionModeChange,
  companionBusy,
  toolPolicy,
}: AgentSettingsPanelProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-sm font-medium">Companion mode</Label>
        <div role="radiogroup" aria-label="Companion mode" className="grid grid-cols-2 gap-2">
          <ModeButton
            selected={companionMode === CompanionModes.ON}
            onSelect={() => onCompanionModeChange(CompanionModes.ON)}
            icon={Sparkles}
            label="Companion"
            disabled={companionBusy}
          />
          <ModeButton
            selected={companionMode === CompanionModes.OFF}
            onSelect={() => onCompanionModeChange(CompanionModes.OFF)}
            icon={Moon}
            label="Quiet"
            disabled={companionBusy}
          />
        </div>
      </div>

      {toolPolicy && (
        <div className="border-t pt-4">
          <ToolPolicyControl
            value={toolPolicy.value}
            onChange={toolPolicy.onChange}
            configuredCategories={toolPolicy.configuredCategories}
            e2e={toolPolicy.e2e}
            disabled={toolPolicy.busy}
          />
        </div>
      )}
    </div>
  )
}

interface ModeButtonProps {
  selected: boolean
  onSelect: () => void
  icon: ComponentType<{ className?: string }>
  label: string
  disabled?: boolean
}

function ModeButton({ selected, onSelect, icon: Icon, label, disabled }: ModeButtonProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      role="radio"
      aria-checked={selected}
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2.5 py-2 text-sm transition-colors",
        disabled && "opacity-50",
        selected ? "border-primary bg-primary/5" : "border-border hover:bg-accent"
      )}
    >
      <Icon className={cn("h-3.5 w-3.5", selected ? "text-primary" : "text-muted-foreground")} />
      <span className={cn("font-medium", selected ? "text-foreground" : "text-muted-foreground")}>{label}</span>
    </button>
  )
}
