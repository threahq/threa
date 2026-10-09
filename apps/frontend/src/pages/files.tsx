import { Paperclip } from "lucide-react"
import { useParams } from "react-router-dom"
import { PagePaneHeader } from "@/components/panes"
import { ExplorerShell } from "@/components/attachment-explorer/explorer-shell"

export function FilesPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  if (!workspaceId) return null

  return (
    <div className="flex h-full flex-col">
      <PagePaneHeader
        workspaceId={workspaceId}
        back={{ to: `/w/${workspaceId}`, label: "Back to workspace" }}
        icon={<Paperclip className="h-5 w-5 shrink-0 text-muted-foreground" />}
        title="Files"
      />
      <main className="flex-1 overflow-hidden">
        <ExplorerShell workspaceId={workspaceId} mode="page" enabled />
      </main>
    </div>
  )
}
