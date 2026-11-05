import type { ReactNode } from "react"
import { toast } from "sonner"
import { Link } from "react-router-dom"
import { Pencil } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { PersonaListAvatar } from "@/components/persona-avatar"
import {
  SETTING_CONTROL_HEIGHT,
  SettingEmptyNote,
  SettingRow,
  SettingStateAction,
  SettingsDisclosure,
  SettingsSection,
  settingIds,
  SettingBadge,
  SETTING_ITEM_DIVIDERS,
} from "@/components/settings/setting-primitives"
import { SETTING_NOTE_TEXT } from "@/components/settings/setting-text"
import { useArchivedPersonas, usePersonas, useUnarchivePersona } from "@/hooks/use-personas"
import { FollowUpLimitSection } from "./follow-up-limit-section"
import { SandboxInternetSection } from "./sandbox-internet-section"
import { DefaultCompanionSection } from "./default-companion-section"
import { SubagentModelsSection } from "./subagent-models-section"
import { PersonaForkDialog } from "./persona-fork-dialog"

interface PersonasTabProps {
  workspaceId: string
}

/** Admin-only page: `useSettingsVisibility` hides it from everyone else. */
export function PersonasTab({ workspaceId }: PersonasTabProps) {
  const { data: personas, isLoading, isError, refetch } = usePersonas(workspaceId)
  const { data: archivedAll } = useArchivedPersonas(workspaceId)
  const unarchive = useUnarchivePersona(workspaceId)

  // `GET /personas/archived` returns an admin's OWN personal archived personas
  // alongside the workspace customs; the workspace roster only manages shared
  // agents, so a personal persona never belongs here (it lives in personal
  // Settings → AI → My personas).
  const archived = archivedAll?.filter((persona) => persona.kind !== "personal")

  let personaList: ReactNode
  if (isLoading) {
    personaList = <SettingEmptyNote>Loading agents…</SettingEmptyNote>
  } else if (isError) {
    // A failed fetch must not read as "no agents".
    personaList = (
      <SettingStateAction live action={{ children: "Retry", onClick: () => void refetch() }}>
        Couldn&apos;t load agents.
      </SettingStateAction>
    )
  } else if (personas && personas.length > 0) {
    personaList = (
      <ul aria-labelledby={settingIds("workspace-personas").label} className={SETTING_ITEM_DIVIDERS}>
        {personas.map((persona) => (
          <li key={persona.id} className="flex min-h-11 items-center gap-3 py-2">
            <PersonaListAvatar workspaceId={workspaceId} persona={persona} size="lg" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate text-sm font-medium">{persona.name}</span>
                {persona.kind === "builtin" && <SettingBadge>Built-in</SettingBadge>}
                {persona.isCustomized && <SettingBadge>Customized</SettingBadge>}
              </div>
              {persona.description && (
                <p className={cn("mt-0.5 truncate text-muted-foreground", SETTING_NOTE_TEXT)}>{persona.description}</p>
              )}
            </div>
            <Link
              to={`/w/${workspaceId}/settings/personas/${persona.id}`}
              aria-label={`Edit ${persona.name}`}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0", SETTING_CONTROL_HEIGHT)}
            >
              <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden />
              Edit
            </Link>
          </li>
        ))}
      </ul>
    )
  } else {
    personaList = <SettingEmptyNote>No agents yet.</SettingEmptyNote>
  }

  return (
    <div className="space-y-8">
      <SettingsSection section="workspace-agents">
        <SettingRow
          setting="workspace-personas"
          labelFor={false}
          control={personas && <PersonaForkDialog workspaceId={workspaceId} sources={personas} />}
        >
          {personaList}
        </SettingRow>
        {archived && archived.length > 0 && (
          <SettingsDisclosure label="Archived agents" settings={[]} summary={`${archived.length} archived`}>
            <ul aria-label="Archived agents" className={SETTING_ITEM_DIVIDERS}>
              {archived.map((persona) => (
                <li key={persona.id} className="flex min-h-11 items-center gap-3 px-4 py-2">
                  <PersonaListAvatar workspaceId={workspaceId} persona={persona} size="lg" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{persona.name}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={cn("shrink-0", SETTING_CONTROL_HEIGHT)}
                    aria-label={`Unarchive ${persona.name}`}
                    disabled={unarchive.isPending}
                    onClick={() =>
                      unarchive.mutate(persona.id, { onError: () => toast.error("Failed to unarchive agent") })
                    }
                  >
                    Unarchive
                  </Button>
                </li>
              ))}
            </ul>
          </SettingsDisclosure>
        )}
      </SettingsSection>

      <SettingsSection section="workspace-assistant">
        <DefaultCompanionSection workspaceId={workspaceId} />
        <FollowUpLimitSection workspaceId={workspaceId} />
        <SubagentModelsSection workspaceId={workspaceId} />
        <SandboxInternetSection workspaceId={workspaceId} />
      </SettingsSection>
    </div>
  )
}
