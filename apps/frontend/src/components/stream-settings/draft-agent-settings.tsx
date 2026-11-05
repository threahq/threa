import { type CompanionMode, type ToolPrivacyCategory, type ToolPrivacyPolicy } from "@threahq/types"
import { useDraftScratchpads } from "@/hooks/use-draft-scratchpads"
import { useDefaultCompanionPersona } from "@/hooks/use-default-companion-persona"
import { useCompanionRoster } from "@/hooks/use-companion-roster"
import { AgentSettingsPanel } from "./agent-settings-panel"
import { COMPANION_DEFAULT_TAGS, companionPickerValue, companionPointerFromPickerValue } from "./companion-agent-select"
import { AgentContextSummary } from "./agent-context-summary"

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
  const { effectiveDefault, personalDefault } = useDefaultCompanionPersona(workspaceId)

  const pickerValue = companionPickerValue(personas, getScratchpad(draftId)?.companionPersonaId)
  const personaId = companionPointerFromPickerValue(pickerValue) ?? effectiveDefault?.id

  return (
    <AgentSettingsPanel
      companionMode={companionMode}
      onCompanionModeChange={(mode) => updateScratchpad(draftId, { companionMode: mode })}
      contextSummary={
        <AgentContextSummary workspaceId={workspaceId} personaId={personaId} e2e={false} variant="panel" />
      }
      personaPicker={{
        workspaceId,
        personas,
        selectedPersonaId: pickerValue,
        onChange: (personaId) =>
          updateScratchpad(draftId, {
            // Dexie removes a key set to undefined — inherit means no stored pointer.
            companionPersonaId: companionPointerFromPickerValue(personaId) ?? undefined,
          }),
        defaultOption: {
          persona: effectiveDefault,
          tag: personalDefault ? COMPANION_DEFAULT_TAGS.personal : COMPANION_DEFAULT_TAGS.workspace,
        },
      }}
      toolPolicy={{
        value: allowedToolCategories,
        onChange: (next) => updateScratchpad(draftId, { allowedToolCategories: next }),
        configuredCategories,
        e2e: false,
      }}
    />
  )
}
