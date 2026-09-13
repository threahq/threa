/**
 * A cover is a view that a search param opens over the page (`?panel=`,
 * `?media=`, …): opening it pushes a history entry, closing it pops that entry
 * (`useCoverClose`). Each list is the params the cover owns, its identity
 * first; the others ride along and are cleared with it.
 */
export const PANEL_COVER = ["panel"] as const
export const MEDIA_COVER = ["media"] as const
export const TRACE_COVER = ["trace", "highlight"] as const
export const SETTINGS_COVER = ["settings"] as const
export const CONTEXT_COVER = ["context"] as const
export const CONVERSATION_OVERLAY_COVER = ["convOverlay"] as const

export type Cover = readonly [string, ...string[]]

/** Location state on a pushed entry attesting that the entry beneath is this
 *  view without the named cover, set where the push cannot be observed
 *  (the cold-launch rebuild commits its hops in one batch). */
export interface PopsToCloseState {
  popsToClose?: string
}
