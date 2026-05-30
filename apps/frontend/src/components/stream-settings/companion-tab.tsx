import { Moon, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { useUpdateCompanionMode } from "@/hooks/use-streams"
import { CompanionModes, type CompanionMode, type Stream } from "@threa/types"

interface CompanionTabProps {
  workspaceId: string
  stream: Stream
}

export function CompanionTab({ workspaceId, stream }: CompanionTabProps) {
  const { mutateAsync: updateCompanionMode, isPending } = useUpdateCompanionMode(workspaceId, stream.id)

  // INV-E1: E2E streams can't speak plaintext through the companion, so this
  // surface is purely informational for them.
  const isE2e = stream.e2eEnabled === true
  const disabled = isPending || isE2e

  const handleChange = async (next: CompanionMode) => {
    if (next === stream.companionMode) return
    try {
      await updateCompanionMode(next)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update companion mode"
      toast.error(message)
    }
  }

  return (
    <div className="space-y-6 p-1">
      <div className="space-y-3">
        <div className="space-y-1">
          <Label className="text-sm font-medium">Companion mode</Label>
          <p className="text-xs text-muted-foreground">
            Decide whether Ariadne reads new messages and replies, or whether this scratchpad stays a silent dump.
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label="Companion mode"
          aria-disabled={disabled || undefined}
          className="grid gap-2 sm:grid-cols-2"
        >
          <CompanionOption
            selected={stream.companionMode === CompanionModes.ON}
            onSelect={() => handleChange(CompanionModes.ON)}
            icon={Sparkles}
            label="Companion"
            hint="Ariadne reads new messages and replies in the thread"
            disabled={disabled}
          />
          <CompanionOption
            selected={stream.companionMode === CompanionModes.OFF}
            onSelect={() => handleChange(CompanionModes.OFF)}
            icon={Moon}
            label="Quiet"
            hint="Just storage — no AI replies, no inference cost"
            disabled={disabled}
          />
        </div>
      </div>

      {isE2e && (
        <p className="text-xs text-muted-foreground">
          Companion mode stays off on encrypted scratchpads — it would reply in plaintext. Ariadne still replies here,
          running in the encryption enclave so your content stays end-to-end encrypted.
        </p>
      )}
    </div>
  )
}

interface CompanionOptionProps {
  selected: boolean
  onSelect: () => void
  icon: React.ComponentType<{ className?: string }>
  label: string
  hint: string
  disabled?: boolean
}

function CompanionOption({ selected, onSelect, icon: Icon, label, hint, disabled }: CompanionOptionProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      role="radio"
      aria-checked={selected}
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
