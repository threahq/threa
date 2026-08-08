import { useCallback, useMemo } from "react"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { ActionDrawerList } from "@/components/actions/action-drawer-list"
import { groupVisibleActions } from "@/components/actions/action-model"
import { type DraftAction, type DraftActionContext, getVisibleDraftActions } from "./draft-actions"

/**
 * Long-press bottom sheet for a drafts-explorer row. The timeline's
 * `MessageActionDrawer` wraps the same `ActionDrawerList` rows in message
 * chrome (author preview, emoji bar, quote selection) — none of which a draft
 * has — so this sheet is that shared list under the row's own label.
 */
export function DraftActionDrawer({
  open,
  onOpenChange,
  context,
  label,
  preview,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  context: DraftActionContext
  label: string
  preview?: string
}) {
  const actions = getVisibleDraftActions(context)
  const groupedActions = useMemo(() => groupVisibleActions(actions), [actions])

  const handleAction = useCallback(
    (action: DraftAction) => {
      onOpenChange(false)
      action.action?.(context)
    },
    [context, onOpenChange]
  )

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[85dvh]">
        <DrawerTitle className="sr-only">Draft actions</DrawerTitle>

        <div className="px-4 pt-1 pb-3">
          <div className="rounded-xl bg-muted/60 px-3.5 py-2.5">
            <p className="mb-0.5 truncate text-[13px] font-medium text-muted-foreground">{label}</p>
            {preview && <p className="truncate text-sm leading-snug text-foreground/80">{preview}</p>}
          </div>
        </div>

        <div
          data-vaul-no-drag
          className="flex-1 min-h-0 overflow-y-auto px-2 pb-[max(12px,env(safe-area-inset-bottom))]"
        >
          <ActionDrawerList
            items={groupedActions}
            context={context}
            onClose={() => onOpenChange(false)}
            onAction={handleAction}
          />
        </div>
      </DrawerContent>
    </Drawer>
  )
}
