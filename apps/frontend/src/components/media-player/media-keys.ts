export type MediaKeyAction =
  | { type: "toggle-play" }
  | { type: "nudge"; direction: -1 | 1; seconds: number }
  | { type: "step-frame"; direction: -1 | 1 }
  | { type: "toggle-mute" }
  | { type: "toggle-fullscreen" }
  | { type: "seek-fraction"; fraction: number }
  | { type: "step-rate"; direction: -1 | 1 }

export interface MediaKeyEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  target: EventTarget | null
}

const TYPING_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
const SELF_ACTIVATING_SELECTOR = 'button, [role="button"], [role="slider"], [role="menuitem"], [role="menuitemradio"]'

/**
 * Maps a key press to a player action. `scrubSelector` names the seek slider:
 * Space and arrows on it act on the player, on any other slider (volume) they
 * stay with that slider.
 */
export function mediaKeyAction(e: MediaKeyEvent, scrubSelector: string): MediaKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  const target = e.target instanceof Element ? e.target : null
  if (target?.closest(TYPING_SELECTOR)) return null

  switch (e.key) {
    case " ": {
      const selfActivating = !!target?.closest(SELF_ACTIVATING_SELECTOR) && !target.closest(scrubSelector)
      return selfActivating ? null : { type: "toggle-play" }
    }
    case "k":
    case "K":
      return { type: "toggle-play" }
    case "j":
    case "J":
      return { type: "nudge", direction: -1, seconds: 10 }
    case "l":
    case "L":
      return { type: "nudge", direction: 1, seconds: 10 }
    case "ArrowLeft":
    case "ArrowRight": {
      const onOtherSlider = !!target?.closest('[role="slider"]') && !target.closest(scrubSelector)
      if (onOtherSlider) return null
      return { type: "nudge", direction: e.key === "ArrowLeft" ? -1 : 1, seconds: 5 }
    }
    case ",":
      return { type: "step-frame", direction: -1 }
    case ".":
      return { type: "step-frame", direction: 1 }
    case "m":
    case "M":
      return { type: "toggle-mute" }
    case "f":
    case "F":
      return { type: "toggle-fullscreen" }
    case "<":
      return { type: "step-rate", direction: -1 }
    case ">":
      return { type: "step-rate", direction: 1 }
  }
  if (/^[0-9]$/.test(e.key)) return { type: "seek-fraction", fraction: Number(e.key) / 10 }
  return null
}
