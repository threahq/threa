import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { Pencil } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { PersonaAvatar } from "@/components/persona-avatar"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { usePersonas } from "@/hooks/use-personas"
import { FollowUpLimitSection } from "./follow-up-limit-section"

interface PersonasTabProps {
  workspaceId: string
}

/**
 * Workspace "AI Agents" settings. Two sections: the editable built-in personas
 * (v1: Ariadne) that link out to the full editor (INV-40 — navigation is a link),
 * and workspace-level assistant behavior knobs. Admin-gated by the dialog's
 * `visibleTabs` filter.
 */
export function PersonasTab({ workspaceId }: PersonasTabProps) {
  const { data: personas, isLoading, isError, refetch } = usePersonas(workspaceId)
  const { toEmoji } = useWorkspaceEmoji(workspaceId)

  let personaList: ReactNode
  if (isLoading) {
    personaList = <p className="text-xs text-muted-foreground">Loading agents…</p>
  } else if (isError) {
    // A failed fetch must not read as "no agents".
    personaList = (
      <p className="text-xs text-muted-foreground">
        Couldn&apos;t load agents.{" "}
        <button type="button" className="underline underline-offset-2" onClick={() => void refetch()}>
          Retry
        </button>
      </p>
    )
  } else if (personas && personas.length > 0) {
    personaList = (
      <ul className="space-y-2">
        {personas.map((persona) => (
          <li key={persona.id} className="flex items-center gap-3 rounded-lg border border-input bg-card p-3">
            <PersonaAvatar
              slug={persona.slug}
              fallback={
                (persona.avatarEmoji && (toEmoji(persona.avatarEmoji) ?? persona.avatarEmoji)) || persona.name.charAt(0)
              }
              size="lg"
            />
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
    personaList = <p className="text-xs text-muted-foreground">No agents available.</p>
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Agents</h3>
          <p className="text-xs text-muted-foreground">
            Edit a built-in AI companion&apos;s prompt, model, and tools for this workspace. Changes apply to every
            stream the agent takes part in.
          </p>
        </div>
        {personaList}
      </div>

      <Separator />

      <div className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Assistant behavior</h3>
          <p className="text-xs text-muted-foreground">
            Workspace-wide limits on what the assistants may do on their own.
          </p>
        </div>
        <FollowUpLimitSection workspaceId={workspaceId} />
      </div>
    </div>
  )
}
