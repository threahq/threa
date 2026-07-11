import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import type { PersonaConfigPatch, PersonaConfigResponse, PersonaListItem } from "@threa/types"
import { personasApi } from "@/api"

export const personaKeys = {
  all: ["personas"] as const,
  list: (workspaceId: string) => [...personaKeys.all, "list", workspaceId] as const,
  config: (workspaceId: string, personaId: string) => [...personaKeys.all, "config", workspaceId, personaId] as const,
  revisions: (workspaceId: string, personaId: string) =>
    [...personaKeys.all, "revisions", workspaceId, personaId] as const,
}

/**
 * The single committed-override cache reconcile shared by Save and Restore: the
 * committed patch becomes the saved baseline (resolved = defaults + patch), the
 * draft clears, the list row adopts the returned persona, and the revisions list
 * is invalidated (both operations append a new revision). One home so a new field
 * that must reset on commit, or a change to the resolved-merge rule, can't be
 * applied to one writer and missed by the other. The form's `applyOverrideConflict`
 * is deliberately a different shape (no draft reset, adopts the other admin's
 * patch) and stays separate.
 */
function applyCommittedOverride(
  queryClient: QueryClient,
  workspaceId: string,
  personaId: string,
  committed: { patch: PersonaConfigPatch; updatedAt: string; persona: PersonaListItem }
) {
  queryClient.setQueryData<PersonaConfigResponse>(personaKeys.config(workspaceId, personaId), (old) =>
    old
      ? {
          ...old,
          overridePatch: committed.patch,
          overrideUpdatedAt: committed.updatedAt,
          resolved: { ...old.defaults, ...committed.patch },
          draft: null,
        }
      : old
  )
  queryClient.setQueryData<PersonaListItem[]>(personaKeys.list(workspaceId), (old) =>
    old?.map((persona) => (persona.id === personaId ? committed.persona : persona))
  )
  void queryClient.invalidateQueries({ queryKey: personaKeys.revisions(workspaceId, personaId) })
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
 * The persona's committed override revisions (newest-first), for the editor's
 * History panel. Admin-only like the config detail; `enabled` gates the fetch so
 * a non-admin never fires the admin request. Opened lazily by the panel, so it
 * only runs when the caller enables it.
 */
export function useRevisions(workspaceId: string, personaId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: personaKeys.revisions(workspaceId, personaId),
    queryFn: () => personasApi.listRevisions(workspaceId, personaId),
    enabled: !!workspaceId && !!personaId && (options?.enabled ?? true),
    staleTime: 30_000,
  })
}

/**
 * Re-commit an older revision's patch as the current override. Shares Save's
 * committed-override cache reconcile (via {@link applyCommittedOverride}) so the
 * editor re-seeds to the restored values and the revisions list refreshes (a
 * restore appends a new revision). The caller handles `PERSONA_OVERRIDE_CONFLICT`
 * (409) inline (INV-63) and `PERSONA_REVISION_INCOMPATIBLE` (422) as a toast.
 * `patch` rides on the input so the cache write reflects the restored config
 * without a refetch.
 */
export function useRestoreRevision(workspaceId: string, personaId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { revisionId: string; patch: PersonaConfigPatch; expectedUpdatedAt: string | null }) =>
      personasApi.restoreRevision(workspaceId, personaId, input.revisionId, {
        expectedUpdatedAt: input.expectedUpdatedAt,
      }),
    onSuccess: (result, input) => {
      applyCommittedOverride(queryClient, workspaceId, personaId, {
        patch: input.patch,
        updatedAt: result.updatedAt,
        persona: result.persona,
      })
    },
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
 * clears, the list row flips to customized, and the revisions list refreshes (the
 * commit appended a new revision) — the shared {@link applyCommittedOverride}.
 */
export function useUpdatePersonaOverride(workspaceId: string, personaId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { patch: PersonaConfigPatch; expectedUpdatedAt: string | null }) =>
      personasApi.putOverride(workspaceId, personaId, input),
    onSuccess: (result, input) => {
      applyCommittedOverride(queryClient, workspaceId, personaId, {
        patch: input.patch,
        updatedAt: result.updatedAt,
        persona: result.persona,
      })
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
