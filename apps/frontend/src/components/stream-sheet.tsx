import { ArchiveX } from "lucide-react"
import { LabelableResourceTypes, StreamTypes } from "@threahq/types"
import { Badge } from "@/components/ui/badge"
import { SidebarActionDrawer, type SidebarActionItem } from "@/components/layout/sidebar/sidebar-actions"
import { LiveAgentSettings } from "@/components/stream-settings/live-agent-settings"
import { InviteActorButton, InviteBotButton } from "@/components/encryption"
import { StreamHeaderEncryptionAction } from "@/components/encryption/stream-encryption-affordance"
import { LabelStack } from "@/components/labels/label-stack"
import { getStreamTypeLabel } from "@/lib/streams"
import type { VirtualStream } from "@/hooks/use-stream-or-draft"

interface StreamSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  streamId: string
  /** Persisted stream only — drafts keep the inline header affordances. */
  stream: VirtualStream
  streamName: string
  actions: SidebarActionItem[]
}

/**
 * Mobile bottom sheet for the stream topbar: the single home for everything a
 * phone-width header can't afford to keep inline — the full name (wraps, never
 * truncates), type/archived/labels, the agent settings the header pill's
 * popover holds on desktop (companion mode, tool access, external-agent
 * status), invite + encryption affordances, and the action list.
 */
export function StreamSheet({
  open,
  onOpenChange,
  workspaceId,
  streamId,
  stream,
  streamName,
  actions,
}: StreamSheetProps) {
  const isScratchpad = stream.type === StreamTypes.SCRATCHPAD
  const isEncrypted = !!stream.e2eEnabled
  const isArchived = stream.archivedAt != null

  const header = (
    <div className="flex flex-col gap-3 px-4 pt-2 pb-3">
      <div>
        <p className="break-words text-base font-semibold text-foreground">{streamName}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{getStreamTypeLabel(stream.type)}</span>
          {isArchived && (
            <Badge variant="secondary" className="gap-1">
              <ArchiveX className="h-3 w-3" />
              Archived
            </Badge>
          )}
          <LabelStack workspaceId={workspaceId} resourceType={LabelableResourceTypes.STREAM} resourceId={streamId} />
        </div>
      </div>
      {isScratchpad && (
        <div className="rounded-xl bg-muted/40 p-3">
          <LiveAgentSettings
            workspaceId={workspaceId}
            streamId={streamId}
            companionMode={stream.companionMode}
            e2e={isEncrypted}
          />
          {isEncrypted && (
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3">
              <InviteActorButton workspaceId={workspaceId} stream={stream} kind="enclave" />
              <InviteBotButton workspaceId={workspaceId} stream={stream} />
              <StreamHeaderEncryptionAction workspaceId={workspaceId} encrypted streamId={streamId} />
            </div>
          )}
        </div>
      )}
    </div>
  )

  return (
    <SidebarActionDrawer
      open={open}
      onOpenChange={onOpenChange}
      actions={actions}
      title="Stream details and actions"
      description="Stream details, agent settings, and actions."
      header={header}
    />
  )
}
