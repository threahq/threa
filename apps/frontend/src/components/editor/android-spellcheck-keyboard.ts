import { Extension, isAndroid } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"
import { KEYBOARD_VIEWPORT_THRESHOLD_PX } from "@/hooks/use-visual-viewport"

/** The menu opens a double-tap timeout after the tap on the word; a drop later than this was not caused by it. */
const TAP_TO_DROP_MS = 3_000
/** The suggestion menu is answered within seconds; an older drop was a Back gesture. */
const ARMED_MS = 15_000

/**
 * Chrome on Android's spelling menu is a focusable popup that drops the keyboard while the editor keeps DOM focus,
 * and the keyboard stays down after a pick or Delete. The menu's only trace on the page is the
 * `insertReplacementText` input both fire, so a drop right after a tap on the editor arms a blur+refocus for that
 * input (`navigator.virtualKeyboard.show()` does not raise the keyboard, Chrome 142). A swiped-away menu sends
 * nothing and reopens on the next tap of the same word, so that tap pauses spellcheck, which clears spelling
 * squiggles, until the user moves past the word or leaves the editor.
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

  let lowestHeight = visualViewport.height
  let lastEditorTapAt = 0
  let armedUntil = 0
  let restoreTimer = 0

  const isArmed = () => Date.now() <= armedUntil
  const disarm = () => {
    armedUntil = 0
  }

  const isSpellcheckPaused = () => view.dom.getAttribute("spellcheck") === "false"
  const pauseSpellcheck = () => view.dom.setAttribute("spellcheck", "false")
  const resumeSpellcheck = () => view.dom.removeAttribute("spellcheck")

  const onResize = () => {
    const height = visualViewport.height
    if (height < lowestHeight) {
      lowestHeight = height
      return
    }
    if (height <= lowestHeight + KEYBOARD_VIEWPORT_THRESHOLD_PX) return

    lowestHeight = height
    if (view.hasFocus() && Date.now() - lastEditorTapAt <= TAP_TO_DROP_MS) armedUntil = Date.now() + ARMED_MS
  }

  const isInEditor = (event: Event) => view.dom.contains(event.target as Node)
  const onPointerDown = (event: PointerEvent) => {
    if (isInEditor(event)) return
    lastEditorTapAt = 0
    disarm()
  }
  // A scroll ends in pointercancel instead, so only a tap on the editor gets here.
  const onPointerUp = (event: PointerEvent) => {
    if (!isInEditor(event)) return
    lastEditorTapAt = Date.now()
    if (isArmed()) pauseSpellcheck()
    disarm()
  }

  const onWordFinished = (event: InputEvent) => {
    if (!isSpellcheckPaused() || !movesPastWord(event)) return
    // After the input lands, so Chrome checks the word that was just finished along with the rest.
    setTimeout(resumeSpellcheck, 0)
  }

  const onSuggestionApplied = (event: InputEvent) => {
    if (event.inputType !== "insertReplacementText" || !isArmed()) return
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
  view.dom.addEventListener("beforeinput", onWordFinished)
  view.dom.addEventListener("beforeinput", onSuggestionApplied)
  view.dom.addEventListener("blur", resumeSpellcheck)
  document.addEventListener("pointerdown", onPointerDown, true)
  document.addEventListener("pointerup", onPointerUp, true)
  document.addEventListener("keydown", disarm, true)

  return {
    destroy() {
      clearTimeout(restoreTimer)
      visualViewport.removeEventListener("resize", onResize)
      view.dom.removeEventListener("beforeinput", onWordFinished)
      view.dom.removeEventListener("beforeinput", onSuggestionApplied)
      view.dom.removeEventListener("blur", resumeSpellcheck)
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("pointerup", onPointerUp, true)
      document.removeEventListener("keydown", disarm, true)
    },
  }
}

function movesPastWord(event: InputEvent): boolean {
  if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") return true
  return event.data !== null && /\s/.test(event.data)
}
