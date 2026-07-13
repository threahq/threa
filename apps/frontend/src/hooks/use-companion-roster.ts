import { useMemo } from "react"
import type { CompanionPersona } from "@/components/stream-settings/companion-agent-select"
import { personaKindFromManagedBy } from "@/lib/personas"
import { useWorkspacePersonas } from "@/stores/workspace-store"

/**
 * Active personas for the companion pickers, read from the bootstrap-backed
 * workspace store (IndexedDB + `agent_config:updated` broadcasts) — instant on
 * open and offline-capable, no per-surface fetch. The bootstrap ships active
 * rows with built-in overrides already resolved; the broadcast flips `status`
 * on archive/unarchive, so filtering here keeps mid-session archives out.
 * Ordering mirrors the API roster: built-ins first, then customs by name.
 */
export function useCompanionRoster(workspaceId: string | undefined): CompanionPersona[] {
  const personas = useWorkspacePersonas(workspaceId)
  return useMemo(
    () =>
      personas
        .filter((p) => p.status === "active")
        .sort((a, b) => {
          if (a.managedBy !== b.managedBy) return a.managedBy === "system" ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        .map((p) => ({
          id: p.id,
          slug: p.slug,
          name: p.name,
          avatarEmoji: p.avatarEmoji,
          avatarUrl: p.avatarUrl,
          kind: personaKindFromManagedBy(p.managedBy),
        })),
    [personas]
  )
}
