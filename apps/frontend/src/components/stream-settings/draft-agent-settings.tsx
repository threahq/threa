import { type CompanionMode, type ToolPrivacyCategory, type ToolPrivacyPolicy } from "@threa/types"
import { useDraftScratchpads } from "@/hooks/use-draft-scratchpads"
import { useDefaultCompanionPersona } from "@/hooks/use-default-companion-persona"
import { useCompanionRoster } from "@/hooks/use-companion-roster"
import { AgentSettingsPanel } from "./agent-settings-panel"
import {
  companionDefaultOptionLabel,
  companionPickerValue,
  companionPointerFromPickerValue,
} from "./companion-agent-select"

interface DraftAgentSettingsProps {
  workspaceId: string
  draftId: string
  companionMode: CompanionMode
  allowedToolCategories: ToolPrivacyPolicy
  configuredCategories?: ToolPrivacyCategory[]
}

/**
 * In-flow agent settings for a not-yet-created scratchpad: companion mode,
 * companion persona, and tool access, written to the local draft and threaded
 * into the create request on the first message. Drafts are always plaintext
 * (encrypted scratchpads skip the draft system), so the enclave "not yet"
 * gating never applies here. The draft author is always the owner, so the tool
 * section is always shown.
 */
export function DraftAgentSettings({
  workspaceId,
  draftId,
  companionMode,
  allowedToolCategories,
  configuredCategories,
}: DraftAgentSettingsProps) {
  const { getScratchpad, updateScratchpad } = useDraftScratchpads(workspaceId)
  const personas = useCompanionRoster(workspaceId)
  const { effectiveDefault } = useDefaultCompanionPersona(workspaceId)

  const pickerValue = companionPickerValue(personas, getScratchpad(draftId)?.companionPersonaId)

  return (
    <AgentSettingsPanel
      companionMode={companionMode}
      onCompanionModeChange={(mode) => updateScratchpad(draftId, { companionMode: mode })}
      personaPicker={
        personas.length > 0
          ? {
              workspaceId,
              personas,
              selectedPersonaId: pickerValue,
              onChange: (personaId) =>
                updateScratchpad(draftId, {
                  // Dexie removes a key set to undefined — inherit means no stored pointer.
                  companionPersonaId: companionPointerFromPickerValue(personaId) ?? undefined,
                }),
              defaultOption: { label: companionDefaultOptionLabel(effectiveDefault) },
            }
          : undefined
      }
      toolPolicy={{
        value: allowedToolCategories,
        onChange: (next) => updateScratchpad(draftId, { allowedToolCategories: next }),
        configuredCategories,
        e2e: false,
      }}
    />
  )
}
