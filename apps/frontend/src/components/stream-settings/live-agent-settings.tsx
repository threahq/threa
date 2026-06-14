import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import type { CompanionMode, StreamBootstrap, ToolPrivacyPolicy } from "@threa/types"
import { streamKeys } from "@/hooks"
import { useUpdateCompanionMode, useUpdateToolPolicy } from "@/hooks/use-streams"
import { useCurrentWorkspaceUser } from "@/hooks/use-workspaces"
import { AgentSettingsPanel } from "./agent-settings-panel"

interface LiveAgentSettingsProps {
  workspaceId: string
  streamId: string
  companionMode: CompanionMode
  e2e: boolean
}

/**
 * The same agent-settings panel as drafts, for a persisted scratchpad: companion
 * mode and (owner-only) tool access wired to live mutations. The current policy
 * and configured categories come from the stream bootstrap the stream view
 * already loaded; the tool section is gated to the scratchpad owner, mirroring
 * the settings dialog.
 */
export function LiveAgentSettings({ workspaceId, streamId, companionMode, e2e }: LiveAgentSettingsProps) {
  const queryClient = useQueryClient()
  const { mutateAsync: updateCompanionMode, isPending: companionBusy } = useUpdateCompanionMode(workspaceId, streamId)
  const { mutateAsync: updateToolPolicy, isPending: toolBusy } = useUpdateToolPolicy(workspaceId, streamId)
  const currentUser = useCurrentWorkspaceUser(workspaceId)

  // Cache-only observer: re-renders when a mutation patches the bootstrap.
  const { data: bootstrap } = useQuery({
    queryKey: streamKeys.bootstrap(workspaceId, streamId),
    queryFn: () => queryClient.getQueryData<StreamBootstrap>(streamKeys.bootstrap(workspaceId, streamId)) ?? null,
    enabled: false,
    staleTime: Infinity,
  })

  const isOwner = !!bootstrap?.stream && bootstrap.stream.createdBy === currentUser?.id

  const handleCompanion = async (mode: CompanionMode) => {
    if (mode === companionMode) return
    try {
      await updateCompanionMode(mode)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update companion mode")
    }
  }

  const handleToolPolicy = async (next: ToolPrivacyPolicy) => {
    try {
      await updateToolPolicy(next)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update tool access")
    }
  }

  return (
    <AgentSettingsPanel
      companionMode={companionMode}
      onCompanionModeChange={handleCompanion}
      companionBusy={companionBusy}
      toolPolicy={
        isOwner
          ? {
              value: bootstrap?.allowedToolCategories ?? null,
              onChange: handleToolPolicy,
              configuredCategories: bootstrap?.configuredToolCategories,
              e2e,
              busy: toolBusy,
            }
          : undefined
      }
    />
  )
}
