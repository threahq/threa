import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { PersonaConfigPatch, PersonaConfigResponse, PersonaListItem } from "@threa/types"
import { personasApi } from "@/api"

export const personaKeys = {
  all: ["personas"] as const,
  list: (workspaceId: string) => [...personaKeys.all, "list", workspaceId] as const,
  config: (workspaceId: string, personaId: string) => [...personaKeys.all, "config", workspaceId, personaId] as const,
}

/** Member-visible persona list (no systemPrompt). Powers the settings tab. */
export function usePersonas(workspaceId: string) {
  return useQuery({
    queryKey: personaKeys.list(workspaceId),
    queryFn: () => personasApi.list(workspaceId),
    enabled: !!workspaceId,
    staleTime: 30_000,
  })
}

/**
 * Admin config detail for one persona: defaults, override, resolved, own draft.
 * `enabled` gates the fetch on the caller's admin check so a non-admin never
 * fires the admin-only request (it would 403).
 */
export function usePersonaConfig(workspaceId: string, personaId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: personaKeys.config(workspaceId, personaId),
    queryFn: () => personasApi.getConfig(workspaceId, personaId),
    enabled: !!workspaceId && !!personaId && (options?.enabled ?? true),
    staleTime: 30_000,
  })
}

/**
 * Debounced draft write (the draft is what the test chat runs). On success the
 * fresh draft lands in the config cache so a reload picks up where the editor
 * left off; the bound `testStreamId` is preserved by the server.
 */
export function useSavePersonaDraft(workspaceId: string, personaId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: PersonaConfigPatch) => personasApi.putDraft(workspaceId, personaId, patch),
    onSuccess: (draft) => {
      queryClient.setQueryData<PersonaConfigResponse>(personaKeys.config(workspaceId, personaId), (old) =>
        old ? { ...old, draft } : old
      )
    },
  })
}

/**
 * Commit the override. The caller handles a `PERSONA_OVERRIDE_CONFLICT` inline
 * (INV-63); on success the committed patch becomes the saved baseline, the draft
 * clears, and the list row flips to customized.
 */
export function useUpdatePersonaOverride(workspaceId: string, personaId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { patch: PersonaConfigPatch; expectedUpdatedAt: string | null }) =>
      personasApi.putOverride(workspaceId, personaId, input),
    onSuccess: (result, input) => {
      queryClient.setQueryData<PersonaConfigResponse>(personaKeys.config(workspaceId, personaId), (old) =>
        old
          ? {
              ...old,
              overridePatch: input.patch,
              overrideUpdatedAt: result.updatedAt,
              resolved: { ...old.defaults, ...input.patch },
              draft: null,
            }
          : old
      )
      queryClient.setQueryData<PersonaListItem[]>(personaKeys.list(workspaceId), (old) =>
        old?.map((persona) => (persona.id === personaId ? result.persona : persona))
      )
    },
  })
}

/**
 * Idempotently create-or-return the caller's bound test scratchpad and record its
 * id on the config cache's `draft.testStreamId` so the test-chat pane mounts
 * immediately (and a reload rebinds to the same stream). The server binds an
 * empty-patch draft when the editor hasn't saved one yet, so seed a minimal draft
 * in the cache when none exists — a later edit's debounced save overwrites it.
 */
export function useCreateTestStream(workspaceId: string, personaId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => personasApi.createTestStream(workspaceId, personaId),
    onSuccess: ({ streamId }) => {
      queryClient.setQueryData<PersonaConfigResponse>(personaKeys.config(workspaceId, personaId), (old) =>
        old
          ? {
              ...old,
              draft: old.draft
                ? { ...old.draft, testStreamId: streamId }
                : { patch: {}, testStreamId: streamId, updatedAt: new Date().toISOString() },
            }
          : old
      )
    },
  })
}

/** Discard the caller's draft (archives the bound test stream server-side). */
export function useDiscardPersonaDraft(workspaceId: string, personaId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => personasApi.deleteDraft(workspaceId, personaId),
    onSuccess: () => {
      queryClient.setQueryData<PersonaConfigResponse>(personaKeys.config(workspaceId, personaId), (old) =>
        old ? { ...old, draft: null } : old
      )
    },
  })
}
