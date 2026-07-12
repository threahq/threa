import { useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { ChevronDown, Pencil } from "lucide-react"
import { getPersonaAvatarUrl, type PersonaListItem } from "@threa/types"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { PersonaAvatar } from "@/components/persona-avatar"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { useArchivedPersonas, usePersonas, useUnarchivePersona } from "@/hooks/use-personas"
import { FollowUpLimitSection } from "./follow-up-limit-section"
import { PersonaForkDialog } from "./persona-fork-dialog"

interface PersonasTabProps {
  workspaceId: string
}

/**
 * Workspace "AI Agents" settings. The roster merges built-in personas (bounded
 * editing) and workspace customs (full editing, created by forking) — each links
 * out to the full editor (INV-40). "New agent" forks a source into a custom.
 * Customs archived this session sit behind an Archived disclosure with Unarchive.
 * Admin-gated by the dialog's `visibleTabs` filter.
 */
export function PersonasTab({ workspaceId }: PersonasTabProps) {
  const { data: personas, isLoading, isError, refetch } = usePersonas(workspaceId)
  const { data: archived } = useArchivedPersonas(workspaceId)
  const { toEmoji } = useWorkspaceEmoji(workspaceId)
  const unarchive = useUnarchivePersona(workspaceId)
  const [archivedOpen, setArchivedOpen] = useState(false)

  const emojiFallback = (persona: PersonaListItem) =>
    (persona.avatarEmoji && (toEmoji(persona.avatarEmoji) ?? persona.avatarEmoji)) || persona.name.charAt(0)

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
              avatarUrl={getPersonaAvatarUrl(workspaceId, persona.avatarUrl, 64)}
              fallback={emojiFallback(persona)}
              size="lg"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{persona.name}</span>
                {persona.kind === "builtin" && (
                  <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">Built-in</span>
                )}
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
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h3 className="text-sm font-medium">Agents</h3>
            <p className="text-xs text-muted-foreground">
              Built-in companions have bounded editing (tools, model, style); forked custom agents are fully editable.
              Changes apply to every stream the agent takes part in.
            </p>
          </div>
          {personas && <PersonaForkDialog workspaceId={workspaceId} sources={personas} />}
        </div>
        {personaList}

        {archived && archived.length > 0 && (
          <Collapsible open={archivedOpen} onOpenChange={setArchivedOpen}>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", archivedOpen && "rotate-180")} />
              Archived ({archived.length})
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <ul className="space-y-2">
                {archived.map((persona) => (
                  <li
                    key={persona.id}
                    className="flex items-center gap-3 rounded-lg border border-dashed border-input p-3"
                  >
                    <PersonaAvatar
                      slug={persona.slug}
                      avatarUrl={getPersonaAvatarUrl(workspaceId, persona.avatarUrl, 64)}
                      fallback={emojiFallback(persona)}
                      size="lg"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{persona.name}</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      disabled={unarchive.isPending}
                      onClick={() => unarchive.mutate(persona.id)}
                    >
                      Unarchive
                    </Button>
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}
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
