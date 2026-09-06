import { Globe, Lock } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Visibility } from "@threahq/types"

interface VisibilityPickerProps {
  value: Visibility
  onChange: (value: Visibility) => void
  disabled?: boolean
}

export function VisibilityPicker({ value, onChange, disabled }: VisibilityPickerProps) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <VisibilityOption
        selected={value === "public"}
        onSelect={() => onChange("public")}
        icon={Globe}
        label="Public"
        hint="Anyone in the workspace can find and join"
        disabled={disabled}
      />
      <VisibilityOption
        selected={value === "private"}
        onSelect={() => onChange("private")}
        icon={Lock}
        label="Private"
        hint="Only invited members can access"
        disabled={disabled}
      />
    </div>
  )
}

interface VisibilityOptionProps {
  selected: boolean
  onSelect: () => void
  icon: React.ComponentType<{ className?: string }>
  label: string
  hint: string
  disabled?: boolean
}

function VisibilityOption({ selected, onSelect, icon: Icon, label, hint, disabled }: VisibilityOptionProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={cn(
        "flex flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-all",
        disabled && "opacity-50 cursor-not-allowed",
        selected
          ? "border-primary bg-primary/5 ring-1 ring-primary/20"
          : "border-border hover:border-muted-foreground/30 hover:bg-accent/50"
      )}
    >
      <div className="flex items-center gap-2">
        <Icon className={cn("h-3.5 w-3.5", selected ? "text-primary" : "text-muted-foreground")} />
        <span className={cn("text-sm font-medium", selected ? "text-foreground" : "text-muted-foreground")}>
          {label}
        </span>
      </div>
      <span className="text-[11px] leading-snug text-muted-foreground">{hint}</span>
    </button>
  )
}
