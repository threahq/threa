/**
 * The one size for every line under a row's label: descriptions, meta lines,
 * empty notes, twin links, reasons, notices and errors. In rem, so Text size scales it.
 */
export const SETTING_NOTE_TEXT = "text-[0.8125rem] leading-snug"

/** The one frame for long user text in a row body, editable or read-only: descriptions, briefs, instructions. */
export const SETTING_INPUT_FRAME = "rounded-lg border border-input bg-background p-3"

/** Muted text on settings surfaces: the 11–13px lines need more than the app-wide 4.5:1. */
export const SETTING_LEGIBLE_MUTED = "[--muted-foreground:var(--muted-foreground-strong)]"

/** The one section heading in settings, over a page's cards and the overview's groups alike. */
export const SETTING_SECTION_HEADING_TEXT = "text-xs font-semibold uppercase tracking-wide text-muted-foreground"

/** The muted note line: SETTING_NOTE_TEXT in the muted colour, the default for hints and meta. */
export const SETTING_MUTED_NOTE_TEXT = `text-muted-foreground ${SETTING_NOTE_TEXT}`

/** The one icon-button size in settings rows: 44px touch target, 36px on fine-pointer desktops. */
export const SETTING_ICON_BUTTON = "size-11 shrink-0 sm:size-9 [@media(pointer:coarse)]:size-11"
