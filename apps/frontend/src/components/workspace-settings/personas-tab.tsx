import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { Pencil } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { usePersonas } from "@/hooks/use-personas"

interface PersonasTabProps {
  workspaceId: string
}

/**
 * Admin list of the workspace's editable built-in personas (v1: Ariadne). Each
 * row links to the full editor page (INV-40 — navigation is a link, not a
 * button); the tab itself is admin-gated by the dialog's `visibleTabs` filter.
 */
export function PersonasTab({ workspaceId }: PersonasTabProps) {
  const { data: personas, isLoading } = usePersonas(workspaceId)
  const { toEmoji } = useWorkspaceEmoji(workspaceId)

  let body: ReactNode
  if (isLoading) {
    body = <p className="text-xs text-muted-foreground">Loading personas…</p>
  } else if (personas && personas.length > 0) {
    body = (
      <ul className="space-y-2">
        {personas.map((persona) => (
          <li key={persona.id} className="flex items-center gap-3 rounded-lg border border-input bg-card p-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-lg leading-none">
              {(persona.avatarEmoji && (toEmoji(persona.avatarEmoji) ?? persona.avatarEmoji)) || persona.name.charAt(0)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{persona.name}</span>
                {persona.isCustomized && (
                  <Badge variant="secondary" className="h-4 px-1.5 py-0 text-[11px] font-normal">
                    Customized
                  </Badge>
                )}
              </div>
              {persona.description && <p className="truncate text-xs text-muted-foreground">{persona.description}</p>}
            </div>
            <Link
              to={`/w/${workspaceId}/settings/personas/${persona.id}`}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}
            >
              <Pencil className="mr-1 h-3.5 w-3.5" />
              Edit
            </Link>
          </li>
        ))}
      </ul>
    )
  } else {
    body = <p className="text-xs text-muted-foreground">No personas available.</p>
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Personas</h3>
        <p className="text-xs text-muted-foreground">
          Edit a built-in AI companion&apos;s prompt, model, and tools for this workspace. Changes apply to every stream
          the persona takes part in.
        </p>
      </div>

      {body}
    </div>
  )
}
