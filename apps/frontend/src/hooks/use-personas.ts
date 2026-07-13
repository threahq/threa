import { useEffect } from "react"
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import type {
  PersonaConfigPatch,
  PersonaConfigResponse,
  PersonaCustomConfig,
  PersonaKind,
  PersonaListItem,
} from "@threa/types"
import { personasApi } from "@/api"

export const personaKeys = {
  all: ["personas"] as const,
  list: (workspaceId: string) => [...personaKeys.all, "list", workspaceId] as const,
  archived: (workspaceId: string) => [...personaKeys.all, "archived", workspaceId] as const,
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
  committed: { patch: PersonaConfigPatch; updatedAt: string | null; persona: PersonaListItem }
) {
  queryClient.setQueryData<PersonaConfigResponse>(personaKeys.config(workspaceId, personaId), (old) =>
    old
      ? {
          ...old,
          overridePatch: committed.patch,
          overrideUpdatedAt: committed.updatedAt,
          // Built-in commit path (defaults always present); customs get their own updater later.
          resolved: { ...old.defaults!, ...committed.patch },
          draft: null,
        }
      : old
  )
  queryClient.setQueryData<PersonaListItem[]>(personaKeys.list(workspaceId), (old) =>
    old?.map((persona) => (persona.id === personaId ? committed.persona : persona))
  )
  void queryClient.invalidateQueries({ queryKey: personaKeys.revisions(workspaceId, personaId) })
}

/**
 * The single committed-write cache reconcile for a CUSTOM persona (shared by Save
 * and Restore): the full config becomes the saved baseline (resolved = the config
 * merged over identity fields), the draft clears, `overrideUpdatedAt` advances to
 * the new row token, the list row adopts the returned persona, and the revisions
 * list is invalidated. The custom analogue of {@link applyCommittedOverride} — a
 * custom has no defaults baseline, so it writes the whole config rather than a
 * defaults-plus-patch merge.
 */
function applyCommittedCustom(
  queryClient: QueryClient,
  workspaceId: string,
  personaId: string,
  committed: { config: PersonaCustomConfig; updatedAt: string | null; persona: PersonaListItem }
) {
  queryClient.setQueryData<PersonaConfigResponse>(personaKeys.config(workspaceId, personaId), (old) =>
    old
      ? {
          ...old,
          overridePatch: null,
          overrideUpdatedAt: committed.updatedAt,
          resolved: { ...old.resolved, ...committed.config },
          draft: null,
        }
      : old
  )
  queryClient.setQueryData<PersonaListItem[]>(personaKeys.list(workspaceId), (old) =>
    old?.map((persona) => (persona.id === personaId ? committed.persona : persona))
  )
  void queryClient.invalidateQueries({ queryKey: personaKeys.revisions(workspaceId, personaId) })
}

/**
 * Adopt a custom persona's new avatar (upload/remove): patch the list row, the
 * config's resolved avatarUrl, AND the OCC token — the row's updated_at bumped,
 * so a Save asserting the stale token inside the broadcast-refetch window would
 * 409 spuriously.
 */
function applyCustomAvatar(
  queryClient: QueryClient,
  workspaceId: string,
  personaId: string,
  persona: PersonaListItem,
  updatedAt: string
) {
  queryClient.setQueryData<PersonaListItem[]>(personaKeys.list(workspaceId), (old) =>
    old?.map((p) => (p.id === personaId ? persona : p))
  )
  queryClient.setQueryData<PersonaConfigResponse>(personaKeys.config(workspaceId, personaId), (old) =>
    old ? { ...old, overrideUpdatedAt: updatedAt, resolved: { ...old.resolved, avatarUrl: persona.avatarUrl } } : old
  )
}

/** Insert a row into a persona list cache if absent (fork adds an active custom; archive adds to the archived list). */
function upsertIntoList(queryClient: QueryClient, key: readonly unknown[], persona: PersonaListItem) {
  queryClient.setQueryData<PersonaListItem[]>(key, (old) => {
    const base = old ?? []
    if (base.some((p) => p.id === persona.id)) return base.map((p) => (p.id === persona.id ? persona : p))
    return [...base, persona]
  })
}

/** Remove a row from a persona list cache by id (archive drops from active; unarchive drops from archived). */
function removeFromList(queryClient: QueryClient, key: readonly unknown[], personaId: string) {
  queryClient.setQueryData<PersonaListItem[]>(key, (old) => old?.filter((p) => p.id !== personaId))
}

const PERSONA_LIST_STALE_TIME = 30_000
/** Session-long retention: the roster is tiny, every companion picker needs it
 *  instantly on open, and mutation reconciles keep the cached rows fresh — so
 *  don't let the default 5-min gc evict it between picker opens. */
const PERSONA_LIST_GC_TIME = 60 * 60_000

/** Member-visible persona list (no systemPrompt). Powers the settings tab. */
export function usePersonas(workspaceId: string, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: personaKeys.list(workspaceId),
    queryFn: () => personasApi.list(workspaceId),
    enabled: !!workspaceId && (opts?.enabled ?? true),
    staleTime: PERSONA_LIST_STALE_TIME,
    gcTime: PERSONA_LIST_GC_TIME,
  })
}

/**
 * Warm the roster cache at workspace mount so the companion pickers (stream
 * popover/sheet, draft settings, settings tabs) render their options on first
 * open instead of popping in after a fetch — the pop-in is user-visible on
 * mobile latency.
 */
export function usePrefetchPersonas(workspaceId: string | undefined) {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!workspaceId) return
    void queryClient.prefetchQuery({
      queryKey: personaKeys.list(workspaceId),
      queryFn: () => personasApi.list(workspaceId),
      staleTime: PERSONA_LIST_STALE_TIME,
      gcTime: PERSONA_LIST_GC_TIME,
    })
  }, [queryClient, workspaceId])
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
export function useRestoreRevision(workspaceId: string, personaId: string, kind: PersonaKind) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { revisionId: string; patch: PersonaConfigPatch; expectedUpdatedAt: string | null }) =>
      personasApi.restoreRevision(workspaceId, personaId, input.revisionId, {
        expectedUpdatedAt: input.expectedUpdatedAt,
      }),
    onSuccess: (result, input) => {
      if (kind === "custom") {
        // A custom revision's `patch` is the full config snapshot; the server
        // re-commits it through the custom update path (a new revision).
        applyCommittedCustom(queryClient, workspaceId, personaId, {
          config: input.patch as PersonaCustomConfig,
          updatedAt: result.updatedAt,
          persona: result.persona,
        })
        return
      }
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

/**
 * Fork a source persona into a new workspace custom. On success the new custom
 * lands in the active roster cache immediately (so the roster reflects it before
 * the broadcast-driven refetch); the caller navigates to its editor.
 */
export function useForkPersona(workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { sourcePersonaId: string | null; name: string }) => personasApi.fork(workspaceId, input),
    onSuccess: (persona) => {
      upsertIntoList(queryClient, personaKeys.list(workspaceId), persona)
    },
  })
}

/**
 * Commit a custom persona's full config. The caller handles a
 * `PERSONA_OVERRIDE_CONFLICT` inline (INV-63); on success the config becomes the
 * saved baseline, the draft clears, and the revisions list refreshes — the shared
 * {@link applyCommittedCustom}.
 */
export function useUpdatePersonaCustom(workspaceId: string, personaId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { config: PersonaCustomConfig; expectedUpdatedAt: string | null }) =>
      personasApi.updateCustom(workspaceId, personaId, input),
    onSuccess: (result, input) => {
      applyCommittedCustom(queryClient, workspaceId, personaId, {
        config: input.config,
        updatedAt: result.updatedAt,
        persona: result.persona,
      })
    },
  })
}

/** Archive a custom persona: drop it from the active roster and move it to the archived list (Unarchive-able). */
export function useArchivePersona(workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (personaId: string) => personasApi.archive(workspaceId, personaId),
    onSuccess: (persona) => {
      removeFromList(queryClient, personaKeys.list(workspaceId), persona.id)
      upsertIntoList(queryClient, personaKeys.archived(workspaceId), persona)
    },
  })
}

/** Restore an archived custom persona to the active roster. */
export function useUnarchivePersona(workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (personaId: string) => personasApi.unarchive(workspaceId, personaId),
    onSuccess: (persona) => {
      removeFromList(queryClient, personaKeys.archived(workspaceId), persona.id)
      upsertIntoList(queryClient, personaKeys.list(workspaceId), persona)
    },
  })
}

/**
 * Archived custom personas (admin fetch). The archive/unarchive mutations also
 * write this cache directly so the disclosure updates without a refetch; the
 * fetch makes it durable across reloads.
 */
export function useArchivedPersonas(workspaceId: string) {
  return useQuery({
    queryKey: personaKeys.archived(workspaceId),
    queryFn: () => personasApi.listArchived(workspaceId),
    enabled: !!workspaceId,
  })
}

/** Upload a custom persona's avatar image; the list row and config resolved avatar adopt it. */
export function useUploadPersonaAvatar(workspaceId: string, personaId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (file: File) => personasApi.uploadAvatar(workspaceId, personaId, file),
    onSuccess: ({ persona, updatedAt }) => applyCustomAvatar(queryClient, workspaceId, personaId, persona, updatedAt),
  })
}

/** Remove a custom persona's avatar image (falls back to emoji/initials). */
export function useRemovePersonaAvatar(workspaceId: string, personaId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => personasApi.removeAvatar(workspaceId, personaId),
    onSuccess: ({ persona, updatedAt }) => applyCustomAvatar(queryClient, workspaceId, personaId, persona, updatedAt),
  })
}
