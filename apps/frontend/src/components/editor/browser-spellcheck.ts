import { isAndroid } from "@tiptap/core"

/**
 * Chrome on Android opens its spelling-suggestion menu as a focusable popup window that declares the keyboard
 * unneeded (`SuggestionsPopupWindow`: `setFocusable(true)` + `INPUT_METHOD_NOT_NEEDED`), so a tap on a squiggled
 * word drops the keyboard on every page, not just ours. Browser spellcheck is off there; the keyboard's own
 * corrections and suggestion strip still apply. Other platforms keep the browser's squiggles.
 */
export function browserSpellcheckAttributes(): Record<string, string> {
  return isAndroid() ? { spellcheck: "false" } : {}
}
