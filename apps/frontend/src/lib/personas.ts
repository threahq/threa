import type { PersonaKind, PersonaListItem } from "@threa/types"
import type { CachedPersona } from "@/db"

/**
 * Map a store persona's `managedBy` discriminator to the roster `kind`: `system`
 * → built-in, `workspace` → a shared custom, `user` → a personal persona visible
 * only to its owner (user-scoped-personas). Mirrors the backend `mapRowToConfig`
 * kind derivation so store-backed surfaces (companion pickers, "My personas")
 * carry the same discriminator the API roster does.
 */
export function personaKindFromManagedBy(managedBy: "system" | "workspace" | "user"): PersonaKind {
  if (managedBy === "system") return "builtin"
  if (managedBy === "user") return "personal"
  return "custom"
}

function managedByFromKind(kind: PersonaKind): CachedPersona["managedBy"] {
  if (kind === "custom") return "workspace"
  if (kind === "personal") return "user"
  return "system"
}

/**
 * Synthesize a store-shaped persona row from the light `PersonaListItem` that
 * rides the `agent_config:updated` broadcast and the fork response. The display
 * fields are real; the heavy config fields (systemPrompt, tools, temperature, …)
 * are null until a bootstrap resync fills them, matching what the broadcast
 * handler writes. A custom/personal row is workspace-scoped; a personal row is
 * owned. Single source for the two callers that turn a list item into a store row
 * (the sync broadcast handler and the fork mutation's optimistic seed).
 */
export function cachedPersonaFromListItem(item: PersonaListItem, workspaceId: string): CachedPersona {
  const isWorkspaceScoped = item.kind === "custom" || item.kind === "personal"
  const nowIso = new Date().toISOString()
  return {
    id: item.id,
    workspaceId: isWorkspaceScoped ? workspaceId : null,
    slug: item.slug,
    name: item.name,
    description: item.description,
    avatarEmoji: item.avatarEmoji,
    avatarUrl: item.avatarUrl,
    systemPrompt: null,
    model: item.model,
    temperature: null,
    maxTokens: null,
    enabledTools: null,
    managedBy: managedByFromKind(item.kind),
    ownerUserId: item.ownerUserId ?? null,
    status: item.status,
    createdAt: nowIso,
    updatedAt: nowIso,
    _cachedAt: Date.now(),
  }
}
