import { ListChecks } from "lucide-react"
import { useParams } from "react-router-dom"
import { PagePaneHeader } from "@/components/panes"
import { OutcomesShell } from "@/components/agent-outcomes/outcomes-shell"

export function OutcomesPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  if (!workspaceId) return null

  return (
    <div className="flex h-full flex-col">
      <PagePaneHeader
        workspaceId={workspaceId}
        back={{ to: `/w/${workspaceId}`, label: "Back to workspace" }}
        icon={<ListChecks className="h-5 w-5 shrink-0 text-muted-foreground" />}
        title="Agent agenda"
      />
      <main className="flex-1 overflow-hidden">
        <OutcomesShell workspaceId={workspaceId} mode="page" enabled />
      </main>
    </div>
  )
}
