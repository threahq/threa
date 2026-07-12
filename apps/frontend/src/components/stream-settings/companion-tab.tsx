import { Moon, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { useUpdateCompanionMode } from "@/hooks/use-streams"
import { usePersonas } from "@/hooks/use-personas"
import { useDefaultCompanionPersona } from "@/hooks/use-default-companion-persona"
import { useActiveBotPresence } from "@/hooks/use-active-bot-presence"
import {
  CompanionModes,
  type CompanionMode,
  type Stream,
  type ToolPrivacyCategory,
  type ToolPrivacyPolicy,
} from "@threa/types"
import {
  COMPANION_DEFAULT_OPTION_VALUE,
  CompanionAgentSelect,
  companionDefaultOptionLabel,
  companionPickerValue,
  resolveCompanionSelection,
} from "./companion-agent-select"
import { ToolPolicyPicker } from "./tool-policy-picker"
import { ExternalAgentIndicator } from "./external-agent-indicator"
import { BriefSection } from "./brief-section"

interface CompanionTabProps {
  workspaceId: string
  stream: Stream
  /** The scratchpad's current tool policy (from the bootstrap envelope). */
  allowedToolCategories: ToolPrivacyPolicy
  /** Tool categories the workspace has configured, so the picker hides unconnected integrations. */
  configuredToolCategories?: ToolPrivacyCategory[]
  /** True only when the viewer can manage this stream's tool policy (scratchpad owner). */
  canManageToolPolicy: boolean
}

export function CompanionTab({
  workspaceId,
  stream,
  allowedToolCategories,
  configuredToolCategories,
  canManageToolPolicy,
}: CompanionTabProps) {
  const { mutateAsync: updateCompanionMode, isPending } = useUpdateCompanionMode(workspaceId, stream.id)
  const externalAgent = useActiveBotPresence(workspaceId, stream.id)

  // On encrypted scratchpads Ariadne runs in the enclave (never the plaintext
  // companion path), so the toggle is a real control here too: Companion =
  // she replies via the enclave, Quiet = silent encrypted storage.
  const isE2e = stream.e2eEnabled === true
  const disabled = isPending

  // The picker (and its roster fetch) is plaintext-only — an encrypted
  // scratchpad always runs the built-in Ariadne, so don't fire /personas there.
  const { data: personas } = usePersonas(workspaceId, { enabled: !isE2e })
  const { effectiveDefault } = useDefaultCompanionPersona(workspaceId, { enabled: !isE2e })

  const { companionName: resolvedName } = resolveCompanionSelection(
    personas,
    stream.companionPersonaId,
    effectiveDefault
  )
  // Until the roster resolves, the real default is unknown — say "your companion"
  // rather than flash a name that may be wrong. E2E streams never load the roster
  // and genuinely always run Ariadne, so the resolved name is correct there.
  const rosterReady = isE2e || personas !== undefined
  const companionName = rosterReady ? resolvedName : "your companion"
  const pickerValue = companionPickerValue(personas, stream.companionPersonaId)

  const handleChange = async (next: CompanionMode) => {
    if (next === stream.companionMode) return
    try {
      await updateCompanionMode({ companionMode: next })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update companion mode"
      toast.error(message)
    }
  }

  const handlePersonaChange = async (personaId: string) => {
    if (personaId === pickerValue) return
    try {
      await updateCompanionMode({
        companionMode: stream.companionMode,
        companionPersonaId: personaId === COMPANION_DEFAULT_OPTION_VALUE ? null : personaId,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update companion agent"
      toast.error(message)
    }
  }

  return (
    <div className="space-y-6 p-1">
      {externalAgent && <ExternalAgentIndicator agent={externalAgent} />}

      <div className="space-y-3">
        <div className="space-y-1">
          <Label className="text-sm font-medium">Companion mode</Label>
          <p className="text-xs text-muted-foreground">
            Decide whether {companionName} reads new messages and replies, or whether this scratchpad stays a silent
            dump.
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
            hint={
              rosterReady
                ? `${companionName} reads new messages and replies in the thread`
                : "Your companion reads new messages and replies in the thread"
            }
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

      {/* Encrypted scratchpads always run the built-in Ariadne in the enclave
          regardless of the pointer, so the persona picker is plaintext-only. */}
      {!isE2e && personas && personas.length > 0 && (
        <div className="space-y-2">
          <div className="space-y-1">
            <Label className="text-sm font-medium">Companion agent</Label>
            <p className="text-xs text-muted-foreground">
              Which agent replies here. Threads inherit this scratchpad&apos;s agent — sessions already running keep
              their agent; new sessions use this selection.
            </p>
          </div>
          <CompanionAgentSelect
            workspaceId={workspaceId}
            personas={personas}
            value={pickerValue}
            onChange={handlePersonaChange}
            defaultOption={{ label: companionDefaultOptionLabel(effectiveDefault) }}
            disabled={disabled}
            triggerClassName="w-full sm:w-72"
          />
        </div>
      )}

      {isE2e && (
        <p className="text-xs text-muted-foreground">
          On encrypted scratchpads Ariadne replies from inside the encryption enclave, so your content stays end-to-end
          encrypted either way. Companion lets her reply; Quiet keeps this a silent, encrypted dump.
        </p>
      )}

      {canManageToolPolicy && (
        <ToolPolicyPicker
          workspaceId={workspaceId}
          streamId={stream.id}
          value={allowedToolCategories}
          configuredCategories={configuredToolCategories}
          e2e={isE2e}
        />
      )}

      {/* Briefs are server-stored plaintext the enclave prompt never injects, so
          they are unsupported on encrypted streams (roadmap §4.1 deviation). */}
      {!isE2e && <BriefSection workspaceId={workspaceId} stream={stream} />}
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
