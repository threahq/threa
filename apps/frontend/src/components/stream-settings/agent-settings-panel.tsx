import { useId, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { CompanionModes, type CompanionMode, type ToolPrivacyCategory, type ToolPrivacyPolicy } from "@threahq/types"
import { Label } from "@/components/ui/label"
import type { ActiveBotPresence } from "@/hooks/use-active-bot-presence"
import { settingDef } from "@/components/settings/settings-registry"
import { SegmentedControl } from "@/components/settings/setting-primitives"
import { SETTING_MUTED_NOTE_TEXT } from "@/components/settings/setting-text"
import { useSettingHref } from "@/hooks/use-setting-href"
import { ToolPolicyControl } from "./tool-policy-picker"
import { ExternalAgentIndicator } from "./external-agent-indicator"
import { CompanionAgentSelect, type CompanionDefaultBadges, type CompanionPersona } from "./companion-agent-select"

export interface AgentToolPolicyBinding {
  value: ToolPrivacyPolicy
  onChange: (next: ToolPrivacyPolicy) => void
  configuredCategories?: ToolPrivacyCategory[]
  /** Encrypted scratchpad: non-web categories render disabled, with a reason. */
  e2e: boolean
  busy?: boolean
}

export interface AgentPersonaBinding {
  workspaceId: string
  /** Roster to offer (built-ins + active customs). */
  personas: CompanionPersona[]
  /** Select value: an explicit persona id, or the inherit sentinel (see
   *  `companionPickerValue`). */
  selectedPersonaId: string | undefined
  onChange: (personaId: string) => void
  /** The leading row following the default (creation-time surfaces only);
   *  the caller maps its sentinel value back to unset. */
  defaultOption?: { persona: CompanionPersona | undefined; tag: string }
  /** Row indicators marking the workspace/personal default personas. */
  defaultBadges?: CompanionDefaultBadges
  busy?: boolean
}

interface AgentSettingsPanelProps {
  companionMode: CompanionMode
  onCompanionModeChange: (mode: CompanionMode) => void
  companionBusy?: boolean
  /** Persona picker; omit to hide it (encrypted scratchpads always run the
   *  enclave's built-in Ariadne). */
  personaPicker?: AgentPersonaBinding
  /** Tool-access section; omit to hide it (e.g. the viewer isn't the owner). */
  toolPolicy?: AgentToolPolicyBinding
  /** External agent attached to the scratchpad, surfaced above the mode radios. */
  externalAgent?: ActiveBotPresence | null
  /** What shapes replies, under the controls. */
  contextSummary?: ReactNode
}

/**
 * The compact agent-settings panel shown from the scratchpad pill — companion
 * mode, (for the owner) tool access, and what the agent sees. One presentational surface for both
 * drafts (writes to the local draft) and live scratchpads (live mutations); the
 * caller wires the handlers.
 */
export function AgentSettingsPanel({
  companionMode,
  onCompanionModeChange,
  companionBusy,
  personaPicker,
  toolPolicy,
  externalAgent,
  contextSummary,
}: AgentSettingsPanelProps) {
  const repliesLabelId = useId()
  const agentLabelId = useId()
  const agentHintId = useId()
  return (
    <div className="space-y-4">
      {externalAgent && <ExternalAgentIndicator agent={externalAgent} compact />}

      <div className="space-y-2">
        <Label id={repliesLabelId} className="text-sm font-medium">
          {settingDef("stream-replies").label}
        </Label>
        <SegmentedControl
          options={REPLY_OPTIONS}
          value={companionMode}
          onValueChange={(next) => onCompanionModeChange(next as CompanionMode)}
          disabled={companionBusy}
          aria-labelledby={repliesLabelId}
          className="w-full"
        />
      </div>

      {personaPicker && (
        <div className="space-y-2">
          <Label id={agentLabelId} className="text-sm font-medium">
            {settingDef("stream-agent").label}
          </Label>
          <CompanionAgentSelect
            workspaceId={personaPicker.workspaceId}
            personas={personaPicker.personas}
            value={personaPicker.selectedPersonaId}
            onChange={personaPicker.onChange}
            defaultOption={personaPicker.defaultOption}
            defaultBadges={personaPicker.defaultBadges}
            disabled={personaPicker.busy}
            triggerClassName="w-full"
            aria-labelledby={agentLabelId}
            aria-describedby={agentHintId}
          />
          <p id={agentHintId} className={SETTING_MUTED_NOTE_TEXT}>
            Threads use this agent too. Running sessions keep theirs. <DefaultAgentLink />
          </p>
        </div>
      )}

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

      {contextSummary}
    </div>
  )
}

const REPLY_OPTIONS = [
  { value: CompanionModes.ON, label: "On" },
  { value: CompanionModes.OFF, label: "Quiet" },
] as const

/** New scratchpads start with the default; picking here changes only this one. */
function DefaultAgentLink() {
  const href = useSettingHref("default-companion")
  if (!href) return null
  return (
    <Link to={href} className="font-medium text-foreground underline underline-offset-4">
      Change default
    </Link>
  )
}
