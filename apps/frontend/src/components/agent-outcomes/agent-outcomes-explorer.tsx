import { ResponsiveDialog, ResponsiveDialogContent, ResponsiveDialogTitle } from "@/components/ui/responsive-dialog"
import { useOutcomesUrlState } from "./use-outcomes-url-state"
import { OutcomesShell } from "./outcomes-shell"

interface AgentOutcomesExplorerProps {
  workspaceId: string
}

/**
 * The outcomes view over whatever the viewer was looking at, opened from a
 * stream menu or the command palette — the same surface `/outcomes` renders
 * full-page. Mounted once per workspace route (beside `AttachmentExplorer`) and
 * driven entirely by the URL marker, so every entry point is a link-shaped
 * `open()` rather than its own copy of the dialog.
 */
export function AgentOutcomesExplorer({ workspaceId }: AgentOutcomesExplorerProps) {
  const { isOpen, close } = useOutcomesUrlState()

  return (
    <ResponsiveDialog open={isOpen} onOpenChange={(open) => (open ? null : close())}>
      <ResponsiveDialogContent
        desktopClassName="overflow-hidden p-0 gap-0 shadow-lg sm:!fixed sm:!top-[12%] sm:!translate-y-0 sm:!flex sm:!flex-col sm:max-w-[920px] sm:rounded-2xl sm:!h-[76vh]"
        drawerClassName="overflow-hidden p-0 h-[92dvh]"
        hideCloseButton
      >
        <ResponsiveDialogTitle className="sr-only">Agent agenda</ResponsiveDialogTitle>
        <OutcomesShell workspaceId={workspaceId} mode="modal" enabled={isOpen} />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
