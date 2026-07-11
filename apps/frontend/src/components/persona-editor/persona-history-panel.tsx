import { useState } from "react"
import { History, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import type { PersonaConfigPatch, PersonaConfigRevision } from "@threa/types"
import { ApiError } from "@/api/client"
import type { PersonaOverrideConflict } from "@/api"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@/components/ui/responsive-dialog"
import { useActors } from "@/hooks/use-actors"
import { useRestoreRevision, useRevisions } from "@/hooks/use-personas"
import { formatFullDateTime, formatRelativeTime } from "@/lib/dates"
import { changedPatchFields, PERSONA_FIELD_LABELS } from "./persona-form"

interface PersonaHistoryPanelProps {
  workspaceId: string
  personaId: string
  /** The `overrideUpdatedAt` a restore asserts against (same OCC token as Save). */
  expectedUpdatedAt: string | null
  /**
   * Reuse the form's inline amber conflict banner when a restore 409s — hand the
   * other admin's committed override up so the next Save/restore asserts against
   * it (INV-63, nothing lost silently).
   */
  onOverrideConflict: (current: PersonaOverrideConflict | null) => void
}

/**
 * Compose the one-line change summary for a revision: the editable fields whose
 * value differs from the previous (older) revision. `prevPatch` is `{}` for the
 * oldest revision, so its summary lists every field it set over the defaults.
 */
function changeSummary(patch: PersonaConfigPatch, prevPatch: PersonaConfigPatch): string {
  const fields = changedPatchFields(prevPatch, patch)
  if (fields.length === 0) return "No field changes"
  return `Changed: ${fields.map((field) => PERSONA_FIELD_LABELS[field]).join(", ")}`
}

interface PersonaRevisionRowProps {
  revision: PersonaConfigRevision
  /** The older revision's patch (`{}` for the oldest) — the change-summary baseline. */
  prevPatch: PersonaConfigPatch
  isCurrent: boolean
  who: string
  restorePending: boolean
  onRestore: (revision: PersonaConfigRevision) => void
}

/** One revision row: version, who/when (local time, INV-42), change summary, and
 *  a confirm-gated Restore for every non-current version. */
function PersonaRevisionRow({
  revision,
  prevPatch,
  isCurrent,
  who,
  restorePending,
  onRestore,
}: PersonaRevisionRowProps) {
  const createdAt = new Date(revision.createdAt)
  return (
    <li className="rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Version {revision.version}</span>
          {isCurrent && <Badge variant="secondary">Current</Badge>}
        </div>
        {!isCurrent && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={restorePending}>
                <RotateCcw className="mr-1 h-3 w-3" />
                Restore
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Restore version {revision.version}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This re-commits this version as the persona's live configuration. It becomes a new revision, so the
                  current version stays in history.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => onRestore(revision)}>Restore</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {who} ·{" "}
        <time dateTime={revision.createdAt} title={formatFullDateTime(createdAt)}>
          {formatRelativeTime(createdAt)}
        </time>
      </p>
      <p className="mt-1 text-xs">{changeSummary(revision.patch, prevPatch)}</p>
    </li>
  )
}

/**
 * The persona editor's revision history: every committed override, newest-first,
 * with who/when and a concise change summary, each older revision restorable
 * (re-commits its patch as a new revision — never destructive). Opened lazily so
 * the admin-only revisions fetch only fires when the panel is shown. A restore
 * re-seeds the form via the shared config cache (the parent refetch adopts it);
 * a 409 surfaces the form's inline conflict banner, a 422 toasts (the revision
 * no longer parses). No success toast — the form reflecting the restored config
 * is the confirmation (INV-63).
 */
export function PersonaHistoryPanel({
  workspaceId,
  personaId,
  expectedUpdatedAt,
  onOverrideConflict,
}: PersonaHistoryPanelProps) {
  const [open, setOpen] = useState(false)
  const { getActorName } = useActors(workspaceId)
  const revisionsQuery = useRevisions(workspaceId, personaId, { enabled: open })
  const restore = useRestoreRevision(workspaceId, personaId)
  const revisions = revisionsQuery.data ?? []

  const handleRestore = (revision: PersonaConfigRevision) => {
    if (restore.isPending) return
    restore.mutate(
      { revisionId: revision.id, patch: revision.patch, expectedUpdatedAt },
      {
        onSuccess: () => setOpen(false),
        onError: (error) => {
          if (ApiError.isApiError(error) && error.code === "PERSONA_OVERRIDE_CONFLICT") {
            onOverrideConflict((error.details?.current ?? null) as PersonaOverrideConflict | null)
            setOpen(false)
            return
          }
          if (ApiError.isApiError(error) && error.code === "PERSONA_REVISION_INCOMPATIBLE") {
            toast.error("This revision is out of date and can no longer be restored.")
            return
          }
          toast.error(error instanceof Error ? error.message : "Failed to restore revision")
        },
      }
    )
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={setOpen}>
      <ResponsiveDialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="text-muted-foreground">
          <History className="mr-1 h-3.5 w-3.5" />
          History
        </Button>
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent className="flex max-h-[80vh] flex-col sm:max-w-lg">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Revision history</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Every saved configuration, newest first. Restoring re-commits an earlier version as the current one —
            nothing is lost.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="py-2">
          {revisionsQuery.isLoading && <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>}
          {!revisionsQuery.isLoading && revisions.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">No saved revisions yet.</p>
          )}
          {!revisionsQuery.isLoading && revisions.length > 0 && (
            <ul className="space-y-3">
              {revisions.map((revision, index) => (
                <PersonaRevisionRow
                  key={revision.id}
                  revision={revision}
                  prevPatch={revisions[index + 1]?.patch ?? {}}
                  isCurrent={index === 0}
                  who={getActorName(revision.createdById, revision.createdByKind === "persona" ? "persona" : "user")}
                  restorePending={restore.isPending}
                  onRestore={handleRestore}
                />
              ))}
            </ul>
          )}
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
