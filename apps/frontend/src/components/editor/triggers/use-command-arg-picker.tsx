import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { createPortal } from "react-dom"
import type { Editor } from "@tiptap/react"
import type { CommandArgumentInfo, CommandArgumentSuggestion } from "@threahq/types"
import { rankMatches } from "@/lib/match-score"
import { CommandArgPicker } from "./command-arg-picker"
import type { CommandItem } from "./types"
import type { SuggestionListRef } from "./suggestion-list"

/**
 * The arguments a freshly-picked command offers options for, or null when it
 * offers none. A command is "pickable" when it inserts a chip (i.e. it's not a
 * client-action) and at least one argument carries advertised `suggestions` —
 * the model list on `/model`, the runtimes and their per-runtime overrides on
 * `/spawn`. Client-action entries (`/memo`, `/giphy`, `/snippet`) insert no
 * chip, so there is nothing to anchor a picker to.
 */
export function pickableArgs(item: CommandItem): CommandArgumentInfo[] | null {
  if (item.clientActionId) return null
  if (!item.args?.some((arg) => (arg.suggestions?.length ?? 0) > 0)) return null
  return item.args
}

/** An argument addressed by name rather than by position: `/spawn pi /model opus`. */
function isFlagArg(arg: CommandArgumentInfo): boolean {
  return arg.name.startsWith("/") || arg.name.startsWith("-")
}

interface ActiveArg {
  arg: CommandArgumentInfo
  /** The word being typed for it, which filters the options. */
  query: string
}

/**
 * The flag arguments in play, with a chosen positional value's own overriding
 * the command's where the names match — so `/spawn pi /model` offers Pi's
 * models and `/spawn claude /model` the desk's.
 */
function flagArgs(
  args: readonly CommandArgumentInfo[],
  chosen: CommandArgumentSuggestion | undefined
): CommandArgumentInfo[] {
  const merged = new Map<string, CommandArgumentInfo>()
  for (const arg of args) if (isFlagArg(arg)) merged.set(arg.name, arg)
  for (const arg of chosen?.args ?? []) if (isFlagArg(arg)) merged.set(arg.name, arg)
  return [...merged.values()]
}

/** The name of the synthetic argument whose options are the flags themselves. */
export const FLAG_CHOICE_ARG = "/"

/**
 * The flags not yet used, offered as options in their own right. Picking one
 * types the flag and hands the next word to that flag's own list — the only way
 * to reach an override by keyboard, since the composer's `/` palette carries
 * commands, not arguments.
 */
function flagChoice(flags: CommandArgumentInfo[], used: ReadonlySet<string>, query: string): ActiveArg | null {
  const remaining = flags.filter((flag) => !used.has(flag.name))
  if (remaining.length === 0) return null
  return {
    arg: {
      name: FLAG_CHOICE_ARG,
      suggestions: remaining.map((flag) => ({
        value: flag.name,
        ...(flag.description ? { description: flag.description } : {}),
      })),
    },
    query,
  }
}

/**
 * Which argument the caret is filling, given everything typed after the chip.
 *
 * The first word fills the leading positional argument (`/spawn <runtime>`,
 * `/model <model>`); after it, a word following a flag's own name fills that
 * flag (`/spawn pi /model <model>`), and a word that starts a flag — or the
 * empty word while the line is still nothing but runtime and overrides — picks
 * from the flags themselves. Free text (the session name) fills no argument and
 * closes the list.
 */
export function resolveActiveArg(args: readonly CommandArgumentInfo[], text: string): ActiveArg | null {
  const positional = args.find((arg) => !isFlagArg(arg) && (arg.suggestions?.length ?? 0) > 0)
  const words = text.split(/\s+/)
  const trailingSpace = text.length > 0 && /\s$/.test(text)
  const query = trailingSpace ? "" : (words[words.length - 1] ?? "")
  const completed = (trailingSpace ? words : words.slice(0, -1)).filter(Boolean)
  if (completed.length === 0) return positional ? { arg: positional, query } : null
  const chosen = positional?.suggestions?.find((suggestion) => suggestion.value === completed[0])
  const flags = flagArgs(args, chosen)
  const named = flags.find((arg) => arg.name === completed[completed.length - 1])
  if (named) return { arg: named, query }
  const used = new Set<string>()
  let freeText = false
  // The positional word is consumed only when it named one of its options;
  // `/spawn /model opus` gives the runtime implicitly and starts at the flag.
  for (let index = chosen ? 1 : 0; index < completed.length; index += 1) {
    const token = completed[index] as string
    if (flags.some((flag) => flag.name === token)) {
      used.add(token)
      index += 1
      continue
    }
    freeText = true
  }
  if (!query.startsWith("/") && (freeText || query !== "")) return null
  return flagChoice(flags, used, query)
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
  /** Every argument the command takes, so a flag typed later reopens the list for it. */
  args: readonly CommandArgumentInfo[]
  /** Doc position right after the inserted `/command ` chip+space — the start of the argument text. */
  anchorPos: number
  /** Everything typed between `anchorPos` and the caret. */
  text: string
  /** Name of the argument whose list was escaped; it stays shut until another argument takes over. */
  dismissed: string | null
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
  /** Start an argument session for a command; call right after the chip is inserted. */
  openArgPicker: (args: readonly CommandArgumentInfo[]) => void
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
    (args: readonly CommandArgumentInfo[]) => {
      const editor = editorRef.current
      if (!editor || editor.isDestroyed) return
      setState({ args, anchorPos: editor.state.selection.from, text: "", dismissed: null })
    },
    [editorRef]
  )

  const select = useCallback(
    (value: string, query: string) => {
      const editor = editorRef.current
      const current = stateRef.current
      if (!editor || editor.isDestroyed || !current) return
      const caret = editor.state.selection.from
      // Replace only the word being typed for this argument — the rest of the
      // line is another argument's — and follow the value with a space, which
      // both ends the option list and starts whatever comes next.
      const from = Math.max(current.anchorPos, caret - query.length)
      editor.chain().focus().deleteRange({ from, to: caret }).insertContent(`${value} `).run()
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
      if (text === current.text) return
      // A dismissal only covers the argument it was made on; moving to another
      // one (typing `/model` after escaping the runtime list) re-arms the list.
      const dismissed = resolveActiveArg(current.args, text)?.arg.name === current.dismissed ? current.dismissed : null
      setState({ ...current, text, dismissed })
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

  // The argument the list is currently for, or null while the caret sits between
  // arguments (typing the session name) or after the list was escaped.
  const active = useMemo(() => {
    if (!state) return null
    const resolved = resolveActiveArg(state.args, state.text)
    return resolved && resolved.arg.name !== state.dismissed ? resolved : null
  }, [state])
  const activeRef = useRef<ActiveArg | null>(null)
  activeRef.current = active

  const items = useMemo(
    () => (active ? filterArgSuggestions(active.arg.suggestions ?? [], active.query) : []),
    [active]
  )
  const itemsRef = useRef(items)
  itemsRef.current = items

  const handleArgPickerKeyDown = useCallback((event: KeyboardEvent): boolean => {
    const current = stateRef.current
    const open = activeRef.current
    // A filter that matches nothing renders no list, so it owns no keys either.
    if (!current || !open || itemsRef.current.length === 0) return false
    if (event.key === "Escape") {
      setState({ ...current, dismissed: open.arg.name })
      return true
    }
    return listRef.current?.onKeyDown(event) ?? false
  }, [])

  const renderArgPicker = useCallback(() => {
    if (!state || !active || items.length === 0) return null
    return createPortal(
      <CommandArgPicker
        ref={listRef}
        items={items}
        clientRect={() => posClientRect(editorRef.current, state.anchorPos)}
        command={(suggestion) => select(suggestion.value, active.query)}
        deferSelection={!active.arg.required}
      />,
      document.body
    )
  }, [state, active, items, select, editorRef])

  return { openArgPicker, renderArgPicker, handleArgPickerKeyDown }
}
