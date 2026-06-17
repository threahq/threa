import { type CompanionMode, type ToolPrivacyCategory, type ToolPrivacyPolicy } from "@threa/types"
import { useDraftScratchpads } from "@/hooks/use-draft-scratchpads"
import { AgentSettingsPanel } from "./agent-settings-panel"

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
 * the draft system), so the enclave "not yet" gating never applies here. The
 * draft author is always the owner, so the tool section is always shown.
 */
export function DraftAgentSettings({
  workspaceId,
  draftId,
  companionMode,
  allowedToolCategories,
  configuredCategories,
}: DraftAgentSettingsProps) {
  const { updateScratchpad } = useDraftScratchpads(workspaceId)

  return (
    <AgentSettingsPanel
      companionMode={companionMode}
      onCompanionModeChange={(mode) => updateScratchpad(draftId, { companionMode: mode })}
      toolPolicy={{
        value: allowedToolCategories,
        onChange: (next) => updateScratchpad(draftId, { allowedToolCategories: next }),
        configuredCategories,
        e2e: false,
      }}
    />
  )
}
