import type { PersonaKind } from "@threa/types"
import type { PersonaCustomConflict, PersonaOverrideConflict } from "@/api"
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
import { Button } from "@/components/ui/button"
import { syncHintText, type SyncState } from "./persona-form"
import { PersonaHistoryPanel } from "./persona-history-panel"

interface PersonaEditorFooterProps {
  workspaceId: string
  personaId: string
  kind: PersonaKind
  /** The `overrideUpdatedAt` a restore asserts against (same OCC token as Save). */
  expectedUpdatedAt: string | null
  onOverrideConflict: (current: PersonaOverrideConflict | PersonaCustomConflict | null) => void
  sync: SyncState
  discardDisabled: boolean
  onDiscard: () => void
  saveDisabled: boolean
  savePending: boolean
  onSave: () => void
}

/**
 * The sticky editor footer shared by both persona editors (restricted built-in,
 * full custom): the History panel, the draft-sync hint, the Discard confirmation
 * dialog, and the Save button. The two editors differ only in their Save/Discard
 * enablement predicates and pending flags — passed in — so the dialog copy and
 * layout live in one place and can't drift between them.
 */
export function PersonaEditorFooter({
  workspaceId,
  personaId,
  kind,
  expectedUpdatedAt,
  onOverrideConflict,
  sync,
  discardDisabled,
  onDiscard,
  saveDisabled,
  savePending,
  onSave,
}: PersonaEditorFooterProps) {
  return (
    <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t bg-background py-3">
      <div className="flex items-center gap-3">
        <PersonaHistoryPanel
          workspaceId={workspaceId}
          personaId={personaId}
          kind={kind}
          expectedUpdatedAt={expectedUpdatedAt}
          onOverrideConflict={onOverrideConflict}
        />
        <span className="text-[11px] text-muted-foreground" aria-live="polite">
          {syncHintText(sync)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button type="button" variant="ghost" size="sm" disabled={discardDisabled}>
              Discard
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Discard draft changes?</AlertDialogTitle>
              <AlertDialogDescription>
                All unsaved edits revert to the last saved configuration, and any open test chat ends. This cannot be
                undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction onClick={onDiscard}>Discard</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <Button type="button" size="sm" onClick={onSave} disabled={saveDisabled}>
          {savePending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  )
}
