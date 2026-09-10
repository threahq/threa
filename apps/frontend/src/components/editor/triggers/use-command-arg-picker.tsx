import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type RefObject } from "react"
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

export interface ActiveArg {
  arg: CommandArgumentInfo
  /** The word being typed for it, which filters the options. */
  query: string
}

/**
 * The flag arguments worth offering, with a chosen positional value's own
 * overriding the command's where the names match — so `/spawn pi /model` offers
 * Pi's models and `/spawn claude /model` the desk's.
 *
 * A flag whose list came back empty is dropped: the runtime that would fill it
 * never advertised one, and offering `/model` only to open nothing behind it is
 * a dead end the user can't tell from a broken picker.
 */
function flagArgs(
  args: readonly CommandArgumentInfo[],
  chosen: CommandArgumentSuggestion | undefined
): CommandArgumentInfo[] {
  const merged = new Map<string, CommandArgumentInfo>()
  for (const arg of args) if (isFlagArg(arg)) merged.set(arg.name, arg)
  for (const arg of chosen?.args ?? []) if (isFlagArg(arg)) merged.set(arg.name, arg)
  return [...merged.values()].filter((arg) => (arg.suggestions?.length ?? 0) > 0)
}

/** The name of the synthetic argument whose options are the flags themselves. */
const FLAG_CHOICE_ARG = "/"

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
  // Walk what's finished: a flag claims the word after it, anything else is the
  // session name. The first word is the runtime's only when it named one, so
  // `/spawn /model opus` still reads as an override.
  const used = new Set<string>()
  let awaitingValue: CommandArgumentInfo | undefined
  let freeText = false
  for (const token of chosen ? completed.slice(1) : completed) {
    if (awaitingValue) {
      awaitingValue = undefined
      continue
    }
    const flag = flags.find((arg) => arg.name === token)
    if (!flag) {
      freeText = true
      continue
    }
    used.add(flag.name)
    awaitingValue = flag
  }
  if (awaitingValue) return { arg: awaitingValue, query }
  const offersFlags = query.startsWith("/") || (!freeText && query === "")
  return offersFlags ? flagChoice(flags, used, query) : null
}

/**
 * Whether the list opens with no row armed, leaving Enter to the editor.
 *
 * A typed filter arms its best match, so Enter picks what the list is showing;
 * an untouched menu arms nothing, so Enter still sends what is written. Only an
 * optional argument gets that second half — a required one has nothing sensible
 * to send yet.
 */
export function defersSelection(active: ActiveArg): boolean {
  return !active.arg.required && active.query.trim() === ""
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

/** The argument region of the command a message opens with. */
interface ArgSession {
  /** Every argument the command takes, so a flag typed later opens the list for it. */
  args: readonly CommandArgumentInfo[]
  /** Doc position right after the leading `/command` chip — the start of the argument text. */
  anchorPos: number
  /** Everything between `anchorPos` and the caret. */
  text: string
}

/**
 * Read the argument region out of the doc, or null when the caret isn't in one.
 *
 * Derived on every change rather than captured when the command was picked: an
 * argument the user comes back to — `/model` corrected after the whole prompt is
 * typed — must open its list again, and a session captured at pick time can only
 * ever close. The command a message opens with is the one it dispatches
 * (`extractCommandNode`), so that leading chip is the only one with arguments.
 */
export function resolveArgSession(
  editor: Editor | null,
  pickableArgsFor: (name: string) => readonly CommandArgumentInfo[] | null
): ArgSession | null {
  // Focus-gated because the session is derived, not opened: a restored draft
  // that starts with a command would otherwise float its option list over an
  // editor nobody is typing in.
  if (!editor || editor.isDestroyed || !editor.isFocused) return null
  const block = editor.state.doc.firstChild
  const chip = block?.firstChild
  if (!block || !chip || chip.type.name !== "slashCommand") return null
  const args = pickableArgsFor(String(chip.attrs.name ?? ""))
  if (!args) return null
  const anchorPos = 1 + chip.nodeSize
  const { $from, from } = editor.state.selection
  if ($from.index(0) !== 0 || from < anchorPos) return null
  const text = editor.state.doc.textBetween(anchorPos, from, "\n", "")
  return text.includes("\n") ? null : { args, anchorPos, text }
}

/**
 * Rect of a fixed doc position. The picker anchors to `anchorPos` (the start of
 * the argument, just after the `/command` chip) rather than the live caret, so
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
 * The picker is not a TipTap trigger — the arguments follow a command chip
 * rather than a trigger character, so there's no suggestion plugin to anchor to.
 * It reads the argument region out of the doc on every editor change
 * ({@link resolveArgSession}) and routes keys through `handleArgPickerKeyDown`,
 * which the host wires into `editorProps.handleKeyDown` (running before the
 * editor's own keymaps).
 */
export function useCommandArgPicker(
  editorRef: RefObject<Editor | null>,
  pickableArgsFor: (name: string) => readonly CommandArgumentInfo[] | null
): UseCommandArgPickerResult {
  const [, bump] = useReducer((tick: number) => tick + 1, 0)
  // The argument whose list was escaped; it stays shut until the caret fills
  // another one.
  const [dismissed, setDismissed] = useState<string | null>(null)
  const listRef = useRef<SuggestionListRef>(null)
  const editor = editorRef.current

  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.on("update", bump)
    editor.on("selectionUpdate", bump)
    editor.on("focus", bump)
    editor.on("blur", bump)
    return () => {
      editor.off("update", bump)
      editor.off("selectionUpdate", bump)
      editor.off("focus", bump)
      editor.off("blur", bump)
    }
  }, [editor])

  const session = resolveArgSession(editor, pickableArgsFor)
  const resolved = session ? resolveActiveArg(session.args, session.text) : null
  const active = resolved && resolved.arg.name !== dismissed ? resolved : null

  useEffect(() => {
    if (dismissed !== null && resolved?.arg.name !== dismissed) setDismissed(null)
  }, [dismissed, resolved?.arg.name])

  const select = useCallback(
    (value: string, query: string, anchorPos: number) => {
      const ed = editorRef.current
      if (!ed || ed.isDestroyed) return
      const caret = ed.state.selection.from
      // Replace only the word being typed for this argument — the rest of the
      // line is another argument's — and follow the value with a space, which
      // both ends the option list and starts whatever comes next.
      const from = Math.max(anchorPos, caret - query.length)
      ed.chain().focus().deleteRange({ from, to: caret }).insertContent(`${value} `).run()
    },
    [editorRef]
  )

  // A pointer down anywhere outside the option list closes the picker. Capture
  // phase so clicking into the editor closes before the caret moves; clicks on
  // an option land inside the listbox and pass through to its button handler.
  useEffect(() => {
    if (!active) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('[role="listbox"]')) return
      setDismissed(active.arg.name)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [active])

  const items = useMemo(
    () => (active ? filterArgSuggestions(active.arg.suggestions ?? [], active.query) : []),
    [active]
  )

  // Re-created per render rather than kept stable: the host reads it through a
  // ref it reassigns on every render, so identity buys nothing.
  const handleArgPickerKeyDown = (event: KeyboardEvent): boolean => {
    // A filter that matches nothing renders no list, so it owns no keys either.
    if (!active || items.length === 0) return false
    if (event.key === "Escape") {
      setDismissed(active.arg.name)
      return true
    }
    return listRef.current?.onKeyDown(event) ?? false
  }

  const renderArgPicker = useCallback(() => {
    if (!session || !active) return null
    return createPortal(
      <CommandArgPicker
        ref={listRef}
        items={items}
        clientRect={() => posClientRect(editorRef.current, session.anchorPos)}
        command={(suggestion) => select(suggestion.value, active.query, session.anchorPos)}
        deferSelection={defersSelection(active)}
      />,
      document.body
    )
  }, [session, active, items, select, editorRef])

  return { renderArgPicker, handleArgPickerKeyDown }
}
