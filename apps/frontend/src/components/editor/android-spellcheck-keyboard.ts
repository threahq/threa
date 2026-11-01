import { Extension, isAndroid } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"

/** A visual-viewport growth smaller than this is URL-bar movement, not a keyboard leaving. */
const KEYBOARD_PX = 100
/** The suggestion menu is read and answered within seconds; an older drop is a Back gesture or a tap elsewhere. */
const ARMED_MS = 15_000

/**
 * Chrome on Android shows its spelling-suggestion menu as a focusable popup window that declares the keyboard
 * unneeded (`SuggestionsPopupWindow`: `setFocusable(true)` + `INPUT_METHOD_NOT_NEEDED`), so the keyboard drops
 * while the editor keeps DOM focus, and Chrome does not bring it back once a suggestion is applied. The menu's
 * only trace on the page is the `beforeinput` of its replacement or deletion, so: a keyboard drop that leaves
 * the editor focused arms a watch, and the next `beforeinput` with no touch or key press in between blurs and
 * refocuses the editor, which raises the keyboard again. `navigator.virtualKeyboard.show()` does not (tested on
 * Chrome 142), and nothing keeps the keyboard up while the popup is open.
 */
export const AndroidSpellcheckKeyboard = Extension.create({
  name: "androidSpellcheckKeyboard",
  addProseMirrorPlugins() {
    if (!isAndroid()) return []
    return [new Plugin({ key: new PluginKey("androidSpellcheckKeyboard"), view: watchKeyboardDrop })]
  },
})

function watchKeyboardDrop(view: EditorView) {
  const visualViewport = window.visualViewport
  if (!visualViewport) return {}
  let keyboardOpenHeight = Number.POSITIVE_INFINITY
  let armedUntil = 0
  let restoreTimer = 0
  const disarm = () => {
    armedUntil = 0
  }
  const onResize = () => {
    const height = visualViewport.height
    if (height < keyboardOpenHeight) {
      keyboardOpenHeight = height
      return
    }
    if (height <= keyboardOpenHeight + KEYBOARD_PX) return
    keyboardOpenHeight = Number.POSITIVE_INFINITY
    if (view.hasFocus()) armedUntil = Date.now() + ARMED_MS
  }
  const onBeforeInput = () => {
    if (Date.now() > armedUntil) return
    disarm()
    clearTimeout(restoreTimer)
    // After ProseMirror has read the replacement from the DOM; a blur inside the input event would strand it.
    restoreTimer = window.setTimeout(() => {
      if (view.isDestroyed || !view.hasFocus()) return
      view.dom.blur()
      view.focus()
    }, 0)
  }
  visualViewport.addEventListener("resize", onResize)
  view.dom.addEventListener("beforeinput", onBeforeInput)
  document.addEventListener("pointerdown", disarm, true)
  document.addEventListener("keydown", disarm, true)
  return {
    destroy() {
      clearTimeout(restoreTimer)
      visualViewport.removeEventListener("resize", onResize)
      view.dom.removeEventListener("beforeinput", onBeforeInput)
      document.removeEventListener("pointerdown", disarm, true)
      document.removeEventListener("keydown", disarm, true)
    },
  }
}
