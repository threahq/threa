import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { useStreamName } from "@/hooks/use-stream-name"
import { useCurrentWorkspaceUserId } from "@/hooks/use-current-workspace-user-id"
import { MembersTab } from "./members-tab"
import { useStreamMembers } from "./use-stream-members"

interface StreamMembersDialogProps {
  workspaceId: string
}

export function StreamMembersDialog({ workspaceId }: StreamMembersDialogProps) {
  const { isOpen, streamId, closeStreamMembers } = useStreamMembers()
  const streamName = useStreamName(workspaceId, streamId ?? "", "sidebar") ?? "Stream"
  const currentUserId = useCurrentWorkspaceUserId(workspaceId)

  return (
    <ResponsiveDialog open={isOpen} onOpenChange={(open) => !open && closeStreamMembers()} disableSnapPoints>
      <ResponsiveDialogContent
        desktopClassName="sm:max-w-lg max-h-[min(720px,calc(100vh-2rem))] flex flex-col overflow-hidden"
        drawerClassName="max-h-[85dvh] flex flex-col"
      >
        <ResponsiveDialogHeader className="pt-4 sm:pt-0">
          <ResponsiveDialogTitle>{streamName}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">
            People and bots in {streamName}.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(16px,env(safe-area-inset-bottom))] sm:px-0 sm:pb-0">
          {streamId && currentUserId && (
            <MembersTab workspaceId={workspaceId} streamId={streamId} currentUserId={currentUserId} />
          )}
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
