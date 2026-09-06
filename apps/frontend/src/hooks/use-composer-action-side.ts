import { usePreferencesOptional } from "@/contexts"
import { DEFAULT_ACCESSIBILITY, type ComposerActionSide } from "@threahq/types"

/**
 * Which end of the composer's action row holds Send.
 *
 * The action bars take this as a prop (they stay pure and width-testable), but
 * the drafts/schedule pickers are constructed by the hosts — stream panel,
 * timeline, board — and handed to the bar as opaque nodes, so the bar cannot
 * reach their popover alignment. They read it here instead of adding the prop
 * to three hosts. Falls back to the default outside a provider (markdown
 * previews, component tests) and for a cached preferences blob written before
 * this field existed.
 */
export function useComposerActionSide(): ComposerActionSide {
  return (
    usePreferencesOptional()?.preferences?.accessibility?.composerActionSide ?? DEFAULT_ACCESSIBILITY.composerActionSide
  )
}

/**
 * Alignment for a popover anchored to the composer card by a trigger sitting at
 * `side` — the popover hugs the same edge its trigger does.
 */
export function composerPopoverAlign(side: ComposerActionSide): "start" | "end" {
  return side === "left" ? "start" : "end"
}
