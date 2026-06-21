import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { createPortal } from "react-dom"
import type { Editor } from "@tiptap/react"
import type { CommandArgumentInfo, CommandArgumentSuggestion } from "@threa/types"
import { rankMatches } from "@/lib/match-score"
import { CommandArgPicker } from "./command-arg-picker"
import type { CommandItem } from "./types"
import type { SuggestionListRef } from "./suggestion-list"

/**
 * The argument a freshly-picked command opens an option picker for, or null
 * when the command takes no pickable argument. A command is "pickable" when it
 * inserts a chip (i.e. it's not a client-action) and its first argument carries
 * advertised `suggestions` — the model list on `/model`, the levels on
 * `/thinking`. Client-action entries (`/memo`, `/giphy`, `/snippet`) insert no
 * chip, so there is nothing to anchor a picker to.
 */
export function findPickableArg(item: CommandItem): CommandArgumentInfo | null {
  if (item.clientActionId) return null
  return item.args?.find((arg) => (arg.suggestions?.length ?? 0) > 0) ?? null
}

/** Rank the option list by the text typed after the command, label first. */
export function filterArgSuggestions(
  suggestions: readonly CommandArgumentSuggestion[],
  query: string
): CommandArgumentSuggestion[] {
  return rankMatches(suggestions, query.trim(), (s) => ({
    labels: [s.label ?? s.value, s.value],
    keywords: [s.description ?? ""],
  }))
}

interface ArgPickerState {
  arg: CommandArgumentInfo
  /** Doc position right after the inserted `/command ` chip+space — the start of the argument text. */
  anchorPos: number
  /** Text typed between `anchorPos` and the caret, used to filter the options. */
  query: string
}

/**
 * Rect of a fixed doc position. The picker anchors to `anchorPos` (the start of
 * the argument, just after the `/command ` chip) rather than the live caret, so
 * it stays put as the user types the filter — matching the trigger-anchored
 * @mention / /command popovers instead of marching right per keystroke (INV-21).
 * Measured live, so it still follows scroll.
 */
function posClientRect(editor: Editor | null, pos: number): DOMRect | null {
  if (!editor || editor.isDestroyed) return null
  try {
    const coords = editor.view.coordsAtPos(pos)
    return new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top)
  } catch {
    return null
  }
}

export interface UseCommandArgPickerResult {
  /** Open the picker for a command's argument; call right after the chip is inserted. */
  openArgPicker: (arg: CommandArgumentInfo) => void
  /** Render the picker portal — call in the editor's JSX. */
  renderArgPicker: () => React.ReactNode
  /**
   * Keyboard entry point for the host editor. Returns true when the picker
   * consumed the key (arrows, enter/tab to pick, escape to dismiss) so the host
   * can preempt send / caret movement, exactly as the suggestion plugins do for
   * the @/slash popups. Returns false when closed or for keys it doesn't own.
   */
  handleArgPickerKeyDown: (event: KeyboardEvent) => boolean
}

/**
 * Drives the command-argument option picker (see {@link CommandArgPicker}).
 *
 * The picker is not a TipTap trigger — it opens programmatically once a command
 * is picked, so there's no trigger character to anchor a suggestion plugin to.
 * Instead it lives in React state, tracks the argument text by reading the doc
 * between a captured anchor and the caret, and routes keys through
 * `handleArgPickerKeyDown` which the host wires into `editorProps.handleKeyDown`
 * (which runs before the editor's keymaps).
 */
export function useCommandArgPicker(editorRef: RefObject<Editor | null>): UseCommandArgPickerResult {
  const [state, setState] = useState<ArgPickerState | null>(null)
  const stateRef = useRef<ArgPickerState | null>(null)
  stateRef.current = state
  const listRef = useRef<SuggestionListRef>(null)
  const isOpen = state !== null

  const openArgPicker = useCallback(
    (arg: CommandArgumentInfo) => {
      const editor = editorRef.current
      if (!editor || editor.isDestroyed) return
      setState({ arg, anchorPos: editor.state.selection.from, query: "" })
    },
    [editorRef]
  )

  const select = useCallback(
    (value: string) => {
      const editor = editorRef.current
      const current = stateRef.current
      if (!editor || editor.isDestroyed || !current) return
      const caret = editor.state.selection.from
      const from = Math.min(current.anchorPos, caret)
      const to = Math.max(current.anchorPos, caret)
      // Replace whatever the user has typed for the argument with the chosen
      // value, leaving the caret after it so Enter sends `/command <value>`.
      editor.chain().focus().deleteRange({ from, to }).insertContent(value).run()
      setState(null)
    },
    [editorRef]
  )

  // Keep the query in sync with the text after the command, and close when the
  // caret leaves the argument region (deleted back past the command, moved to a
  // new line). Subscribes once per open via the boolean dep; reads live state
  // from the ref so it isn't torn down on every keystroke.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || editor.isDestroyed || !isOpen) return
    const sync = () => {
      const ed = editorRef.current
      const current = stateRef.current
      if (!ed || ed.isDestroyed || !current) return
      const caret = ed.state.selection.from
      if (caret < current.anchorPos || caret > ed.state.doc.content.size) {
        setState(null)
        return
      }
      const text = ed.state.doc.textBetween(current.anchorPos, caret, "\n", "")
      if (text.includes("\n")) {
        setState(null)
        return
      }
      if (text !== current.query) setState({ ...current, query: text })
    }
    editor.on("update", sync)
    editor.on("selectionUpdate", sync)
    return () => {
      editor.off("update", sync)
      editor.off("selectionUpdate", sync)
    }
  }, [isOpen, editorRef])

  // A pointer down anywhere outside the option list closes the picker. Capture
  // phase so clicking into the editor closes before the caret moves; clicks on
  // an option land inside the listbox and pass through to its button handler.
  useEffect(() => {
    if (!isOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('[role="listbox"]')) return
      setState(null)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [isOpen])

  const handleArgPickerKeyDown = useCallback((event: KeyboardEvent): boolean => {
    if (!stateRef.current) return false
    if (event.key === "Escape") {
      setState(null)
      return true
    }
    return listRef.current?.onKeyDown(event) ?? false
  }, [])

  const items = useMemo(() => (state ? filterArgSuggestions(state.arg.suggestions ?? [], state.query) : []), [state])

  const renderArgPicker = useCallback(() => {
    if (!state) return null
    return createPortal(
      <CommandArgPicker
        ref={listRef}
        items={items}
        clientRect={() => posClientRect(editorRef.current, state.anchorPos)}
        command={(suggestion) => select(suggestion.value)}
      />,
      document.body
    )
  }, [state, items, select, editorRef])

  return { openArgPicker, renderArgPicker, handleArgPickerKeyDown }
}
