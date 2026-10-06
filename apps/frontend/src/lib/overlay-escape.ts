/**
 * Whether an open overlay owns the Escape key. Radix overlays (the move dialog,
 * dropdowns, the reaction popover) listen in the capture phase and do not stop
 * propagation, so a page-level Escape handler would act on the same keypress.
 * Dialogs and menus match by role; other popovers match the popper wrapper (only
 * in the DOM while open, no forceMount). Hover tooltips render in a popper
 * wrapper too but never own Escape, so wrappers holding a tooltip don't count.
 */
export function overlayOwnsEscape(): boolean {
  return (
    document.querySelector(
      '[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"],[role="menu"][data-state="open"]'
    ) != null ||
    Array.from(document.querySelectorAll("[data-radix-popper-content-wrapper]")).some(
      (wrapper) => wrapper.querySelector('[role="tooltip"]') == null
    )
  )
}
