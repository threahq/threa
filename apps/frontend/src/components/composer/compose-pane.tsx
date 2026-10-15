import { useContext, useMemo, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { ArrowDownToLine, ArrowRight } from "lucide-react"
import { usePanel, usePaneFocusLanding, createComposePanelId, parseComposeDraft } from "@/contexts"
import { AsideCoversPanesContext } from "@/components/aside/aside-presentation"
import { PaneFocusContext, useComposeSlot, type ComposeSlot } from "@/components/panes"
import { landFocus } from "@/components/layout/pane-shortcuts"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useStableCallback } from "@/hooks/use-stable-callback"
import { collapsedComposerPreview } from "@/lib/drafts/collapsed-composer-preview"
import { panelIdsOf } from "@/lib/panel-tabs"
import type { JSONContent } from "@threahq/types"

export interface ComposePane {
  id: string
  /** The draft's pane is open: its composer renders there, and a bar holds its place here. */
  open: boolean
  /** Where this composer renders while the pane is open, or null while another composer writes the draft. */
  slot: ComposeSlot | null
  close: () => void
  goTo: () => void
  /** Links that open the pane in focus or beside, where the page lays panes out and nothing covers them. */
  expandHref: string | undefined
  sideHref: string | undefined
}

/** `draftKey`'s draft is open in a pane of its own: whatever hosts its composer keeps it mounted meanwhile. */
export function useComposePaneOpen(draftKey: string): boolean {
  const { layout } = usePanel()
  return panelIdsOf(layout).includes(createComposePanelId(draftKey))
}

/** The draft keys open in panes of their own, for a host of several composers to keep each one mounted. */
export function useComposePaneDraftKeys(): ReadonlySet<string> {
  const { layout } = usePanel()
  // Keyed on the keys, not the layout, so a pane resized or switched leaves the hosts' callbacks alone.
  const keys = JSON.stringify(panelIdsOf(layout).flatMap((id) => parseComposeDraft(id) ?? []))
  return useMemo(() => new Set<string>(JSON.parse(keys)), [keys])
}

/** `draftKey`'s draft in a pane of its own (`compose:<draftKey>`), for the composer that owns the draft. */
export function useComposePane(draftKey: string, { claim, offer }: { claim: boolean; offer: boolean }): ComposePane {
  const { hasTabs, getPanelUrl, getFocusedPanelUrl, closeTab, setCurrentPane } = usePanel()
  const asideCoversPanes = useContext(AsideCoversPanesContext)
  const paneLanding = usePaneFocusLanding()
  const id = createComposePanelId(draftKey)
  const open = useComposePaneOpen(draftKey)
  const slot = useComposeSlot(draftKey, open && claim)
  const close = useStableCallback(() => {
    if (open) closeTab(id)
  })
  const goTo = useStableCallback(() => {
    setCurrentPane(id)
    landFocus(paneLanding, id)
  })
  const offered = offer && hasTabs && !asideCoversPanes
  return {
    id,
    open,
    slot,
    close,
    goTo,
    expandHref: offered ? getFocusedPanelUrl(id) : undefined,
    sideHref: offered ? getPanelUrl(id) : undefined,
  }
}

/** Renders the composer into its draft's pane, reading pane state from there rather than from where it is mounted. */
export function ComposePanePortal({ id, slot, children }: { id: string; slot: ComposeSlot; children: ReactNode }) {
  const { setCurrentPane } = usePanel()
  return createPortal(
    <PaneFocusContext.Provider value={slot.paneFocus}>
      {/* Its events bubble through the pane it is mounted in, which claims them first; the draft's pane takes them back. */}
      <div
        className="flex min-h-0 flex-1 flex-col"
        onClickCapture={() => setCurrentPane(id)}
        onFocusCapture={() => setCurrentPane(id)}
      >
        {children}
      </div>
    </PaneFocusContext.Provider>,
    slot.node
  )
}

/** Holds the composer's place while its draft is open in a pane: one line of the draft, leading to it. */
export function ComposingInPaneBar({
  draft,
  onGoTo,
  onWriteHere,
}: {
  draft: JSONContent
  onGoTo: () => void
  onWriteHere: () => void
}) {
  const preview = useMemo(() => collapsedComposerPreview(draft), [draft])
  return (
    <div className="flex h-10 items-center gap-1 rounded-xl border border-input bg-card/75 pr-1 backdrop-blur-md">
      <button
        type="button"
        aria-label="Go to draft"
        className="flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-l-xl pl-3 text-left text-sm text-muted-foreground hover:text-foreground"
        onClick={onGoTo}
      >
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
        <span className="min-w-0 flex-1 truncate">{preview}</span>
        <ArrowRight className="h-4 w-4 shrink-0" />
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            aria-label="Write here"
            onClick={onWriteHere}
          >
            <ArrowDownToLine className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          Write here
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
