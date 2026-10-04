import { Globe, Lock, UsersRound } from "lucide-react"
import { cn } from "@/lib/utils"
import type { CreatableVisibility, Visibility } from "@threahq/types"

interface VisibilityPickerProps {
  value: Visibility
  onChange: (value: CreatableVisibility) => void
  disabled?: boolean
}

export const GuestPublicIcon = UsersRound

export const VISIBILITY_LABELS: Record<Visibility, string> = {
  public: "Public",
  guest_public: "Open to guests",
  private: "Private",
}

export function VisibilityPicker({ value, onChange, disabled }: VisibilityPickerProps) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <VisibilityOption
        selected={value === "public"}
        onSelect={() => onChange("public")}
        icon={Globe}
        label={VISIBILITY_LABELS.public}
        hint="Members can find and join"
        disabled={disabled}
      />
      <VisibilityOption
        selected={value === "guest_public"}
        onSelect={() => onChange("guest_public")}
        icon={GuestPublicIcon}
        label={VISIBILITY_LABELS.guest_public}
        hint="Members and guests can find and join"
        disabled={disabled}
      />
      <VisibilityOption
        selected={value === "private"}
        onSelect={() => onChange("private")}
        icon={Lock}
        label={VISIBILITY_LABELS.private}
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
      aria-pressed={selected}
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
