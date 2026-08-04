import { ArrowLeft, ListChecks } from "lucide-react"
import { Link, useParams } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { SidebarToggle } from "@/components/layout"
import { OutcomesShell } from "@/components/agent-outcomes/outcomes-shell"

export function OutcomesPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  if (!workspaceId) return null

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <SidebarToggle location="page" />
        <Button asChild variant="ghost" size="icon" className="h-8 w-8">
          <Link to={`/w/${workspaceId}`} aria-label="Back to workspace">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="flex items-center gap-2">
          <ListChecks className="h-5 w-5 text-muted-foreground" />
          <h1 className="font-semibold">Agent agenda</h1>
        </div>
      </header>
      <main className="flex-1 overflow-hidden">
        <OutcomesShell workspaceId={workspaceId} mode="page" enabled />
      </main>
    </div>
  )
}
