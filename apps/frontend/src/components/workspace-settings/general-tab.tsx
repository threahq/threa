import { useFormattedDate } from "@/hooks"
import { useWorkspaceFromStore } from "@/stores/workspace-store"
import { formatRegion } from "@/lib/regions"

interface GeneralTabProps {
  workspaceId: string
}

export function GeneralTab({ workspaceId }: GeneralTabProps) {
  const { formatDate } = useFormattedDate()
  const workspace = useWorkspaceFromStore(workspaceId)

  return (
    <div className="space-y-4 p-1">
      <div>
        <h3 className="text-sm font-medium">Name</h3>
        <p className="text-sm text-muted-foreground">{workspace?.name ?? "—"}</p>
      </div>

      {(workspace as any)?.region && (
        <div>
          <h3 className="text-sm font-medium">Data region</h3>
          <p className="text-sm text-muted-foreground">{formatRegion((workspace as any).region)}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Where your workspace data is stored</p>
        </div>
      )}

      <div>
        <h3 className="text-sm font-medium">Created</h3>
        <p className="text-sm text-muted-foreground">
          {workspace?.createdAt ? formatDate(new Date(workspace.createdAt)) : "—"}
        </p>
      </div>
    </div>
  )
}
