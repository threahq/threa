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
 * only trace on the page is the `insertReplacementText` input its pick and its Delete both fire, so: a keyboard
 * drop that leaves the editor focused arms a watch, and the next such input with no touch or key press in
 * between blurs and refocuses the editor, which raises the keyboard again. `navigator.virtualKeyboard.show()` does not (tested on
 * Chrome 142), and nothing keeps the keyboard up while the popup is open.
 *
 * A menu swiped away sends the page nothing, and tapping back into the editor puts the caret on the same
 * squiggled word and opens the menu again, dropping the keyboard each time. So a tap on the editor while still
 * armed pauses spellcheck, which clears the squiggles, until the user types a space or a line break or leaves
 * the editor.
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
  // An editor mounted under an open keyboard must still see the popup's drop as growth.
  let keyboardOpenHeight = visualViewport.height
  let armedUntil = 0
  let restoreTimer = 0
  const disarm = () => {
    armedUntil = 0
  }
  const resumeSpellcheck = () => view.dom.removeAttribute("spellcheck")
  const onPointerDown = (event: PointerEvent) => {
    if (Date.now() <= armedUntil && view.dom.contains(event.target as Node)) {
      view.dom.setAttribute("spellcheck", "false")
    }
    disarm()
  }
  const onResize = () => {
    const height = visualViewport.height
    if (height < keyboardOpenHeight) {
      keyboardOpenHeight = height
      return
    }
    if (height <= keyboardOpenHeight + KEYBOARD_PX) return
    keyboardOpenHeight = height
    if (view.hasFocus()) armedUntil = Date.now() + ARMED_MS
  }
  const onBeforeInput = (event: InputEvent) => {
    if (view.dom.getAttribute("spellcheck") === "false" && movesPastWord(event)) {
      // After the input lands, so Chrome checks the word that was just finished along with the rest.
      setTimeout(resumeSpellcheck, 0)
    }
    if (event.inputType !== "insertReplacementText" || Date.now() > armedUntil) return
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
  view.dom.addEventListener("blur", resumeSpellcheck)
  document.addEventListener("pointerdown", onPointerDown, true)
  document.addEventListener("keydown", disarm, true)
  return {
    destroy() {
      clearTimeout(restoreTimer)
      visualViewport.removeEventListener("resize", onResize)
      view.dom.removeEventListener("beforeinput", onBeforeInput)
      view.dom.removeEventListener("blur", resumeSpellcheck)
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("keydown", disarm, true)
    },
  }
}

function movesPastWord(event: InputEvent): boolean {
  if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") return true
  return event.data !== null && /\s/.test(event.data)
}
