import { Extension, isAndroid } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"
import { KEYBOARD_VIEWPORT_THRESHOLD_PX } from "@/hooks/use-visual-viewport"

/** The menu opens a double-tap timeout after the tap on the word; a drop later than this was not caused by it. */
const TAP_TO_DROP_MS = 3_000
/** The suggestion menu is answered within seconds; an older drop was a Back gesture. */
const ARMED_MS = 15_000
/** A touch that travels further than this was a scroll or a drag, not a tap on a word. */
const TAP_SLOP_PX = 10

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

type Phase = { kind: "idle" } | { kind: "tapped"; at: number } | { kind: "armed"; until: number }

const IDLE: Phase = { kind: "idle" }

function watchKeyboardDrop(view: EditorView) {
  const visualViewport = window.visualViewport
  if (!visualViewport) return {}

  let lowestHeight = visualViewport.height
  let phase: Phase = IDLE
  let restoreTimer = 0

  const isArmed = () => phase.kind === "armed" && Date.now() <= phase.until

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
    const tapCausedDrop = phase.kind === "tapped" && Date.now() - phase.at <= TAP_TO_DROP_MS
    if (view.hasFocus() && tapCausedDrop) phase = { kind: "armed", until: Date.now() + ARMED_MS }
  }

  const stopWatchingTaps = watchTaps(view.dom, {
    tap: () => {
      if (isArmed()) pauseSpellcheck()
      phase = { kind: "tapped", at: Date.now() }
    },
    touchElsewhere: () => {
      phase = IDLE
    },
  })
  const onKeyDown = () => {
    if (phase.kind === "armed") phase = IDLE
  }

  const onWordFinished = (event: InputEvent) => {
    if (!isSpellcheckPaused() || !movesPastWord(event)) return
    // After the input lands, so Chrome checks the word that was just finished along with the rest.
    setTimeout(resumeSpellcheck, 0)
  }

  const onSuggestionApplied = (event: InputEvent) => {
    if (event.inputType !== "insertReplacementText" || !isArmed()) return
    phase = IDLE
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
  document.addEventListener("keydown", onKeyDown, true)

  return {
    destroy() {
      clearTimeout(restoreTimer)
      stopWatchingTaps()
      visualViewport.removeEventListener("resize", onResize)
      view.dom.removeEventListener("beforeinput", onWordFinished)
      view.dom.removeEventListener("beforeinput", onSuggestionApplied)
      view.dom.removeEventListener("blur", resumeSpellcheck)
      document.removeEventListener("keydown", onKeyDown, true)
    },
  }
}

/** Reports a touch that starts and ends in `target` without travelling; a pan ends in pointercancel instead. */
function watchTaps(target: HTMLElement, on: { tap: () => void; touchElsewhere: () => void }) {
  let start: { x: number; y: number } | null = null

  const onPointerDown = (event: PointerEvent) => {
    if (target.contains(event.target as Node)) {
      start = { x: event.clientX, y: event.clientY }
      return
    }
    start = null
    on.touchElsewhere()
  }
  const onPointerUp = (event: PointerEvent) => {
    if (!start || !target.contains(event.target as Node)) return
    const travel = Math.hypot(event.clientX - start.x, event.clientY - start.y)
    start = null
    if (travel <= TAP_SLOP_PX) on.tap()
  }
  const onPointerCancel = () => {
    start = null
  }

  document.addEventListener("pointerdown", onPointerDown, true)
  document.addEventListener("pointerup", onPointerUp, true)
  document.addEventListener("pointercancel", onPointerCancel, true)

  return () => {
    document.removeEventListener("pointerdown", onPointerDown, true)
    document.removeEventListener("pointerup", onPointerUp, true)
    document.removeEventListener("pointercancel", onPointerCancel, true)
  }
}

function movesPastWord(event: InputEvent): boolean {
  if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") return true
  return event.data !== null && /\s/.test(event.data)
}
