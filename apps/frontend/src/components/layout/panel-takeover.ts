import { cn } from "@/lib/utils"

/**
 * Classes for a page whose side panel takes over the whole viewport on mobile
 * (the stream page and the board both do this).
 *
 * The main column keeps rendering behind the panel — `invisible` leaves its
 * scroller's box, and therefore its scroll offset, alive. Unmounting the column
 * or hiding it with `display: none` destroys the box, so closing the panel
 * re-enters the feed at the top. Paired with `inert` on the same element so the
 * hidden column can't take focus or a tap.
 *
 * Callers keep their own JSX rather than getting a layout component, because the
 * other half of the rule is structural: the main column must hold the SAME
 * position in the element tree in both modes, or React remounts it and the
 * offset is gone however it was hidden. That's visible in a page's own return
 * and invisible behind a wrapper.
 */
export function panelTakeoverClasses(takeover: boolean) {
  return {
    // Always positioned: a surface that takes the whole content region (the
    // aside's fullscreen stage) anchors to this row, and it must stop at the
    // sidebar rather than at the viewport.
    container: cn("relative h-full", !takeover && "flex"),
    main: cn("min-w-0 overflow-hidden", takeover ? "invisible absolute inset-0" : "flex-1"),
    /** `undefined` rather than `false` — React omits the attribute entirely. */
    mainInert: takeover || undefined,
    panel: "absolute inset-0 flex flex-col bg-background",
  }
}
