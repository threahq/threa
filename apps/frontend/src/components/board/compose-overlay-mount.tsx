import { BoardOverlayComposer } from "./board-overlay-composer"
import { useComposeOverlay, closeCompose, notifyComposePosted } from "@/stores/compose-overlay-store"

/**
 * The single app-level instance of the board authoring overlay, mounted once in
 * the workspace layout and driven by {@link useComposeOverlay}. Every entry point
 * (board button, quick-switcher command) toggles the store, so there is exactly
 * one overlay — never two competing dialogs or divergent target state.
 */
export function ComposeOverlayMount({ workspaceId }: { workspaceId: string }) {
  const { open, defaultTarget } = useComposeOverlay()
  return (
    <BoardOverlayComposer
      workspaceId={workspaceId}
      open={open}
      defaultTarget={defaultTarget}
      onOpenChange={(next) => {
        if (!next) closeCompose()
      }}
      onPosted={notifyComposePosted}
    />
  )
}
