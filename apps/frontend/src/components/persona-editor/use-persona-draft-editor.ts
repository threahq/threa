import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { PersonaConfigPatch, PersonaResolvedConfig } from "@threa/types"
import { useDiscardPersonaDraft, useSavePersonaDraft } from "@/hooks/use-personas"
import {
  applyPatch,
  computeSparsePatch,
  patchesEqual,
  valuesEqual,
  type PersonaFormField,
  type PersonaFormValues,
  type SyncState,
} from "./persona-form"

interface UsePersonaDraftEditorParams {
  workspaceId: string
  personaId: string
  /**
   * The baseline the sparse draft/dirty diff is computed against: the code
   * defaults for a built-in (its override is a sparse patch over them), or the
   * persona row's own resolved config for a custom (its draft is a sparse diff
   * over the row).
   */
  baseline: PersonaResolvedConfig
  /**
   * The committed patch over the baseline (a built-in's active override, or
   * `null` for a custom whose baseline IS the saved row). Seeds the saved values.
   */
  savedPatch: PersonaConfigPatch | null
  /** The caller's own unsaved draft patch to seed initial values from, or null. */
  draftPatch: PersonaConfigPatch | null
  /** The fields that may enter the draft/dirty patch (built-in vs custom subset). */
  editableFields: readonly PersonaFormField[]
  /** The OCC token the current baseline was read at (advances on a concurrent commit). */
  overrideUpdatedAt: string | null
  onSyncStateChange?: (sync: SyncState) => void
}

/**
 * The shared editor machinery both persona editors (restricted built-in, full
 * custom) run on: resolved form values, the debounced draft write (~700ms) that
 * feeds the test chat, dirty/sparse-patch derivation restricted to the editor's
 * writable fields, and reconciliation of a concurrent admin's commit that arrives
 * via the `agent_config:updated` broadcast (adopt when pristine, surface the
 * conflict banner when the form holds unsynced work — never a silent clobber,
 * INV-63). The two editors differ only in their baseline, writable field set,
 * commit mutation, and conflict shape — all passed in or handled by the caller.
 */
export function usePersonaDraftEditor({
  workspaceId,
  personaId,
  baseline,
  savedPatch,
  draftPatch,
  editableFields,
  overrideUpdatedAt,
  onSyncStateChange,
}: UsePersonaDraftEditorParams) {
  const savedValues = useMemo(() => applyPatch(baseline, savedPatch), [baseline, savedPatch])

  const [values, setValues] = useState<PersonaFormValues>(() =>
    draftPatch ? applyPatch(baseline, draftPatch) : savedValues
  )
  const [conflict, setConflict] = useState(false)
  const [sync, setSync] = useState<SyncState>("idle")
  const notifySync = useCallback(
    (next: SyncState) => {
      setSync(next)
      onSyncStateChange?.(next)
    },
    [onSyncStateChange]
  )

  // Only a real edit triggers draft sync — mounting with a loaded draft must not
  // re-POST it, and a broadcast-driven config refetch must not look like typing.
  const editedRef = useRef(false)
  // The saved baseline (updatedAt + the values it resolved to) this form last
  // reconciled against. A concurrent admin's commit advances `overrideUpdatedAt`
  // under our still-local `values`; reconciling against this ref keeps that from
  // silently re-arming the OCC token and clobbering them.
  const ackRef = useRef<{ updatedAt: string | null; values: PersonaFormValues }>({
    updatedAt: overrideUpdatedAt,
    values: savedValues,
  })

  const sparsePatch = useMemo(
    () => computeSparsePatch(values, baseline, editableFields),
    [values, baseline, editableFields]
  )
  const isDirty = !patchesEqual(sparsePatch, savedPatch ?? {})

  const saveDraft = useSavePersonaDraft(workspaceId, personaId)
  const discardDraft = useDiscardPersonaDraft(workspaceId, personaId)

  // Debounced draft sync. The ref holds the latest patch so the timeout always
  // sends the current value without re-subscribing the effect.
  const patchRef = useRef(sparsePatch)
  patchRef.current = sparsePatch
  const patchKey = JSON.stringify(sparsePatch)
  useEffect(() => {
    if (!editedRef.current) return
    notifySync("syncing")
    const timer = setTimeout(() => {
      // Save/Discard may have landed while this timer was pending (both reset
      // editedRef); firing then would re-insert a ghost draft row right after
      // the commit transaction deleted it. The at-fire re-check upholds the
      // "commit leaves no draft" invariant under any edit/Save interleaving.
      if (!editedRef.current) return
      saveDraft.mutate(patchRef.current, {
        onSuccess: () => notifySync("synced"),
        onError: () => notifySync("error"),
      })
    }, 700)
    return () => clearTimeout(timer)
  }, [patchKey])

  // Reconcile an externally-advanced saved baseline (a concurrent admin's commit,
  // delivered via the broadcast that refetches this config query). If the form
  // holds no unsynced work, adopt the new baseline; otherwise surface the conflict
  // banner rather than advancing the OCC token under stale values (INV-63). Our
  // own commit advances `ackRef` in the caller's save handler, so this no-ops.
  useEffect(() => {
    if (overrideUpdatedAt === ackRef.current.updatedAt) return
    // A token advance that leaves the saved baseline unchanged over our editable
    // fields is NOT a foreign edit to reconcile — it is a side effect that bumped
    // the row's `updated_at` and rebroadcast without touching any field we edit
    // (an avatar-image upload/remove: `avatarUrl` is not a form field). Adopt the
    // new OCC token so the next Save asserts against it, and never fabricate a
    // conflict or clobber local edits over it (INV-63).
    const savedBaselineChanged = !valuesEqual(savedValues, ackRef.current.values, editableFields)
    const holdsUnsyncedWork = !valuesEqual(values, ackRef.current.values, editableFields)
    ackRef.current = { updatedAt: overrideUpdatedAt, values: savedValues }
    if (!savedBaselineChanged) return
    if (holdsUnsyncedWork) {
      setConflict(true)
      return
    }
    setValues(savedValues)
    editedRef.current = false
    setConflict(false)
  }, [overrideUpdatedAt, savedValues, editableFields, values])

  const setField = useCallback(<K extends keyof PersonaFormValues>(field: K, value: PersonaFormValues[K]) => {
    editedRef.current = true
    setValues((prev) => ({ ...prev, [field]: value }))
  }, [])

  const resetField = useCallback(
    <K extends keyof PersonaFormValues>(field: K) => {
      editedRef.current = true
      setValues((prev) => ({ ...prev, [field]: baseline[field] as PersonaFormValues[K] }))
    },
    [baseline]
  )

  /** Advance the reconciled baseline to a just-committed snapshot (our own commit). */
  const commitAck = useCallback((updatedAt: string | null, committed: PersonaFormValues) => {
    ackRef.current = { updatedAt, values: committed }
    editedRef.current = false
  }, [])

  /** Drop local edits back to the saved baseline (discard / load-their-changes). */
  const resetToSaved = useCallback(() => {
    setValues(savedValues)
    editedRef.current = false
    setConflict(false)
  }, [savedValues])

  return {
    values,
    setValues,
    setField,
    resetField,
    savedValues,
    sparsePatch,
    isDirty,
    sync,
    notifySync,
    conflict,
    setConflict,
    editedRef,
    commitAck,
    resetToSaved,
    saveDraft,
    discardDraft,
  }
}
