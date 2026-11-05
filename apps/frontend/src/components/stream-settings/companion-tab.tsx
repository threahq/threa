import { toast } from "sonner"
import {
  ChoiceSetting,
  SETTING_CONTROL_CLASS,
  SettingLinkRow,
  SettingRow,
  SettingValue,
  SettingsSection,
  settingIds,
} from "@/components/settings/setting-primitives"
import { SETTING_MUTED_NOTE_TEXT } from "@/components/settings/setting-text"
import { SettingsLink } from "@/components/workspace-settings/settings-link"
import { SETTING_CHOICE_LABELS, settingDef } from "@/components/settings/settings-registry"
import { useUpdateCompanionMode } from "@/hooks/use-streams"
import { useCanManageChannels } from "@/lib/use-can-manage-channels"
import { useDefaultCompanionPersona } from "@/hooks/use-default-companion-persona"
import { useCompanionRoster } from "@/hooks/use-companion-roster"
import { useActiveBotPresence } from "@/hooks/use-active-bot-presence"
import { useSettingHref } from "@/hooks/use-setting-href"
import { usePreferencesOptional } from "@/contexts/preferences-context"
import { streamFallbackLabel } from "@/lib/streams"
import {
  CompanionModes,
  StreamTypes,
  type CompanionMode,
  type Stream,
  type ToolPrivacyCategory,
  type ToolPrivacyPolicy,
} from "@threahq/types"
import { CompanionAgentSelect, resolveCompanionSelection } from "./companion-agent-select"
import { ToolPolicyPicker } from "./tool-policy-picker"
import { ExternalAgentIndicator } from "./external-agent-indicator"
import { BriefSection } from "./brief-section"
import { AgentContextSummary } from "./agent-context-summary"
import { briefSharedWith } from "./agent-context"

interface CompanionTabProps {
  workspaceId: string
  stream: Stream
  /** The scratchpad's current tool policy (from the bootstrap envelope). */
  allowedToolCategories: ToolPrivacyPolicy
  /** Tool categories the workspace has configured, so the picker hides unconnected integrations. */
  configuredToolCategories?: ToolPrivacyCategory[]
  /** True only when the viewer can manage this stream's tool policy (scratchpad owner). */
  canManageToolPolicy: boolean
  /** A thread's root, whose brief the thread edits. */
  rootStream?: Stream | null
}

export function CompanionTab({
  workspaceId,
  stream,
  allowedToolCategories,
  configuredToolCategories,
  canManageToolPolicy,
  rootStream,
}: CompanionTabProps) {
  const { mutateAsync: updateCompanionMode, isPending } = useUpdateCompanionMode(workspaceId, stream.id)
  const externalAgent = useActiveBotPresence(workspaceId, stream.id)

  // On encrypted scratchpads Ariadne runs in the enclave (never the plaintext
  // companion path), so the toggle is a real control here too: Companion =
  // she replies via the enclave, Quiet = silent encrypted storage.
  const isE2e = stream.e2eEnabled === true
  const canManageChannels = useCanManageChannels(workspaceId)
  const channelLocked = stream.type === StreamTypes.CHANNEL && !canManageChannels
  // A thread whose root is not cached yet locks too: the backend gates the brief on the root's type.
  const briefRootType = stream.type === StreamTypes.THREAD ? (rootStream?.type ?? StreamTypes.CHANNEL) : stream.type
  const briefLocked = briefRootType === StreamTypes.CHANNEL && !canManageChannels
  const disabled = isPending || channelLocked

  // Bootstrap-backed store read (no fetch) — instant on open, offline-capable.
  // The picker itself stays hidden on encrypted scratchpads (enclave is
  // Ariadne-only).
  const personas = useCompanionRoster(workspaceId)
  const { effectiveDefault, workspaceDefault, personalDefault } = useDefaultCompanionPersona(workspaceId)
  const noun = streamFallbackLabel(stream.type, "noun")
  const isScratchpad = stream.type === StreamTypes.SCRATCHPAD
  // Personal instructions reach scratchpads and the threads under them.
  const followsInstructions =
    isScratchpad || (stream.type === StreamTypes.THREAD && rootStream?.type === StreamTypes.SCRATCHPAD)

  // A created scratchpad is pinned to one persona; a legacy NULL pointer
  // displays (and dispatches as) the built-in default. Only an explicit pick
  // changes the agent — defaults apply at create, never retroactively.
  const { selectedPersonaId, companionName } = resolveCompanionSelection(personas, stream.companionPersonaId)
  // Until the store hydrates ([] before the bootstrap/IDB seed lands), the real
  // default is unknown — say "Your agent" rather than flash a name that may
  // be wrong. E2E scratchpads genuinely always run Ariadne, so the resolved name
  // is correct there regardless.
  const rosterReady = isE2e || personas.length > 0

  const update = async (params: Parameters<typeof updateCompanionMode>[0], failureMessage: string) => {
    try {
      await updateCompanionMode(params)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : failureMessage)
    }
  }

  const handleChange = (next: CompanionMode) => {
    if (next !== stream.companionMode) void update({ companionMode: next }, "Failed to update agent replies")
  }

  const handlePersonaChange = (personaId: string) => {
    if (personaId === selectedPersonaId) return
    void update({ companionMode: stream.companionMode, companionPersonaId: personaId }, "Failed to update agent")
  }

  const agentIds = settingIds("stream-agent")
  const hasContext = !isE2e || followsInstructions

  return (
    <div className="space-y-8">
      <SettingsSection section="stream-agent">
        {externalAgent && <ExternalAgentIndicator agent={externalAgent} />}
        <ChoiceSetting
          setting="stream-replies"
          variant="segmented"
          value={stream.companionMode}
          options={[
            {
              value: CompanionModes.ON,
              label: SETTING_CHOICE_LABELS["stream-replies"].on,
              description: `${rosterReady ? companionName : "Your agent"} answers each new message in this ${noun}.`,
            },
            {
              value: CompanionModes.OFF,
              label: SETTING_CHOICE_LABELS["stream-replies"].off,
              description: "No agent replies and no AI usage.",
            },
          ]}
          onValueChange={handleChange}
          disabled={disabled}
        />

        {isE2e ? (
          <SettingRow
            setting="stream-agent"
            labelFor={false}
            description="Ariadne replies from inside the encryption enclave, so messages stay end-to-end encrypted. Other agents can't run here."
            control={<SettingValue>Ariadne</SettingValue>}
          />
        ) : (
          <SettingRow
            setting="stream-agent"
            labelFor={false}
            description={`${isScratchpad ? "Which agent replies here and in this scratchpad's threads." : "Which agent replies here."} Running sessions keep the agent they started with.`}
            control={
              <CompanionAgentSelect
                workspaceId={workspaceId}
                personas={personas}
                value={selectedPersonaId}
                onChange={handlePersonaChange}
                defaultBadges={{ workspaceDefaultId: workspaceDefault?.id, personalDefaultId: personalDefault?.id }}
                disabled={disabled}
                triggerClassName={SETTING_CONTROL_CLASS}
                aria-labelledby={agentIds.label}
                aria-describedby={agentIds.description}
              />
            }
          >
            {isScratchpad && <DefaultCompanionLine name={effectiveDefault?.name} />}
          </SettingRow>
        )}
      </SettingsSection>

      <AgentContextSummary
        workspaceId={workspaceId}
        personaId={selectedPersonaId}
        e2e={isE2e}
        stream={{ id: stream.id, type: stream.type, root: rootStream }}
        tools={
          isScratchpad && !canManageToolPolicy ? { policy: allowedToolCategories, viewerIsOwner: false } : undefined
        }
        exclude={SHOWN_AS_CONTROLS}
        variant="section"
      />

      {hasContext && (
        <SettingsSection section="stream-context">
          {/* Briefs are server-stored plaintext the enclave prompt never injects, so
              they are unsupported on encrypted streams (roadmap §4.1 deviation). */}
          {!isE2e && (
            <BriefSection
              workspaceId={workspaceId}
              stream={stream}
              locked={briefLocked}
              description={
                stream.type === StreamTypes.THREAD
                  ? `${settingDef("stream-brief").description} Shared with ${briefSharedWith(rootStream)}.`
                  : undefined
              }
            />
          )}
          {followsInstructions && <InstructionsRow />}
        </SettingsSection>
      )}

      {canManageToolPolicy && (
        <SettingsSection section="stream-tools">
          <ToolPolicyPicker
            workspaceId={workspaceId}
            streamId={stream.id}
            value={allowedToolCategories}
            configuredCategories={configuredToolCategories}
            e2e={isE2e}
          />
        </SettingsSection>
      )}
    </div>
  )
}

/**
 * What shapes replies, minus what this page shows as controls: the agent, the
 * brief and your instructions. It sits right under the agent picker, so the
 * picked agent's model and instructions read as part of that choice.
 */
const SHOWN_AS_CONTROLS = ["agent", "brief", "instructions"] as const

/** New scratchpads pin the default at create; this one keeps its agent when the default changes. */
function DefaultCompanionLine({ name }: { name: string | undefined }) {
  const href = useSettingHref("default-companion")
  return (
    <p className={SETTING_MUTED_NOTE_TEXT}>
      {name ? `Your default for new scratchpads: ${name}.` : "New scratchpads start with your default agent."}{" "}
      {href && <SettingsLink setting="default-companion">Change default</SettingsLink>}
    </p>
  )
}

/** The account setting that also shapes replies here, shown where it applies and linked to where it is set. */
function InstructionsRow() {
  const preferences = usePreferencesOptional()?.preferences
  const href = useSettingHref("ai-instructions")
  if (!preferences) return null
  const hasInstructions = !!preferences.scratchpadCustomPrompt?.trim()
  return (
    <SettingLinkRow
      setting="ai-instructions"
      href={href}
      description={hasInstructions ? "Agents here follow them too." : "No instructions yet."}
    />
  )
}
