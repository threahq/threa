import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import katex from "katex"
import "katex/dist/katex.min.css"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { KATEX_OPTIONS } from "@/lib/markdown/katex-options"
import { cn } from "@/lib/utils"
import type { MathAttrs, MathCaretSide, MathExitSide } from "./math-extension"

/**
 * An equation in the composer: KaTeX until the caret arrives, a TeX field while
 * it is being written. Open, it takes the footprint of the code it is — inline
 * code in a sentence, a code block on its own line — and the equation is drawn
 * live in a popover above, so what will be sent is visible the whole time
 * without the message reflowing on every keystroke.
 *
 * An inline equation is finished by Enter. A display one takes lines the way a
 * code block does — Enter adds one, Enter on an empty last line finishes it —
 * which is the only path a phone has, since its keyboard has no Shift. The
 * toggle beside the field is how an equation becomes display without one.
 * An empty field finishes by deleting the node, so there is no way to leave an
 * invisible equation behind.
 */
export function MathNodeView({ node, editor, getPos, decorations }: NodeViewProps) {
  const attrs = node.attrs as MathAttrs
  const editingDecoration = decorations.find((decoration) => decoration.spec?.mathEditing === true)
  const editing = editingDecoration !== undefined
  const caret: MathCaretSide = editingDecoration?.spec?.mathCaret === "start" ? "start" : "end"

  const [draft, setDraft] = useState(attrs.tex)
  const [display, setDisplay] = useState(attrs.display)
  const field = useRef<HTMLTextAreaElement>(null)
  // The last committed value, so the blur that follows a commit cannot commit
  // the field a second time against a node that is already gone.
  const committed = useRef(false)

  useLayoutEffect(() => {
    if (!editing) return
    setDraft(attrs.tex)
    setDisplay(attrs.display)
    committed.current = false
    // Focusing is what makes the toolbar button an edit block rather than an
    // insertion: the caret is in the TeX, not in the message. It lands on the
    // side the caret came in from, so arrowing through an equation reads as one
    // continuous move. Claimed again on the next frame because the editor
    // writes the node selection to the DOM after this view mounts, which takes
    // the focus straight back.
    const claim = () => {
      const input = field.current
      if (!input) return
      const offset = caret === "start" ? 0 : input.value.length
      input.focus()
      input.setSelectionRange(offset, offset)
    }
    claim()
    const frame = requestAnimationFrame(claim)
    return () => cancelAnimationFrame(frame)
  }, [editing, caret, attrs.tex, attrs.display])

  /**
   * `refocus` is false for the blur that ends editing because the click that
   * caused it is on its way somewhere else — taking the focus back would undo
   * the user's next action.
   */
  const commit = useCallback(
    (tex: string, asDisplay: boolean, exit: MathExitSide, refocus: boolean) => {
      if (committed.current) return
      const pos = getPos()
      if (pos === undefined) return
      committed.current = true
      editor.commands.commitMath(pos, { tex, display: asDisplay }, exit)
      if (refocus) editor.commands.focus()
    },
    [editor, getPos]
  )

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Nothing typed here is message input. Without this the composer's own
      // Enter would send the half-written equation.
      event.stopPropagation()
      const input = event.currentTarget
      const collapsed = input.selectionStart === input.selectionEnd
      const atStart = collapsed && input.selectionStart === 0
      const atEnd = collapsed && input.selectionEnd === draft.length

      if (event.key === "Enter" && !event.shiftKey) {
        // In a display equation Enter is a line break until the last line is
        // empty, which is the rule code blocks already use here.
        const finishing = !display || (atEnd && /(?:^|\n)[ \t]*$/.test(draft))
        if (!finishing) return
        event.preventDefault()
        commit(draft, display, "after", true)
        return
      }
      if (event.key === "Enter" && event.shiftKey) {
        // The textarea inserts the newline itself; an equation across lines is
        // a display one, which is what `$$…$$` renders as.
        setDisplay(true)
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        commit(draft, display, "after", true)
        return
      }
      if (event.key === "Backspace" && draft === "") {
        event.preventDefault()
        commit("", display, "after", true)
        return
      }
      // Arrowing off either end leaves the equation on that side, so the caret
      // passes through it rather than getting stuck inside.
      const onFirstLine = !draft.slice(0, input.selectionStart).includes("\n")
      const onLastLine = !draft.slice(input.selectionEnd).includes("\n")
      if ((event.key === "ArrowLeft" && atStart) || (event.key === "ArrowUp" && onFirstLine)) {
        event.preventDefault()
        commit(draft, display, "before", true)
        return
      }
      if ((event.key === "ArrowRight" && atEnd) || (event.key === "ArrowDown" && onLastLine)) {
        event.preventDefault()
        commit(draft, display, "after", true)
      }
    },
    [commit, draft, display]
  )

  const tex = editing ? draft : attrs.tex
  const drawn = editing ? display : attrs.display
  const html = useMemo(
    () => (tex.trim() ? katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: drawn }) : ""),
    [tex, drawn]
  )

  const lines = draft.split("\n")
  const columns = Math.max(8, ...lines.map((line) => line.length + 1))
  // A multi-line equation has no inline form, so the toggle offers only the
  // direction that exists.
  const multiline = draft.includes("\n")

  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      suppressContentEditableWarning
      data-type="math"
      data-display={drawn ? "true" : "false"}
      className={cn("math-node", drawn && "math-node-display", editing && "math-node-editing")}
    >
      {editing ? (
        // Inline, the equation floats over the field so the sentence does not
        // reflow on every keystroke. A display equation already owns its line,
        // so there it is drawn in the card, under the TeX — a popover would
        // cover the sentence above it.
        <Popover open={!display}>
          <PopoverAnchor asChild>
            <span className="math-card">
              <textarea
                ref={field}
                className="math-field"
                aria-label="Equation TeX"
                placeholder="TeX"
                wrap="off"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                rows={lines.length}
                style={display ? undefined : { width: `${columns}ch` }}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onKeyDown}
                onBlur={() => commit(draft, display, "after", false)}
              />
              {display ? (
                <span className="math-card-preview" onMouseDown={(event) => event.preventDefault()}>
                  <span className="math-preview-drawn" dangerouslySetInnerHTML={{ __html: html }} />
                  <MathDisplayToggle display disabled={multiline} onToggle={() => setDisplay(false)} />
                </span>
              ) : null}
            </span>
          </PopoverAnchor>
          <PopoverContent
            side="top"
            align="start"
            className="math-preview"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onMouseDown={(event) => event.preventDefault()}
          >
            <span className="math-preview-drawn" dangerouslySetInnerHTML={{ __html: html }} />
            <MathDisplayToggle display={false} disabled={false} onToggle={() => setDisplay(true)} />
          </PopoverContent>
        </Popover>
      ) : (
        <MathEquation html={html} onOpen={() => editor.commands.openMathEditor(getPos() ?? 0)} />
      )}
    </NodeViewWrapper>
  )
}

/**
 * Inline or display without a Shift key, which a phone does not have. Every
 * surface that holds it prevents `mousedown`: the field keeps the focus for as
 * long as the equation is open, or the tap would commit it out from under
 * itself.
 */
function MathDisplayToggle({
  display,
  disabled,
  onToggle,
}: {
  display: boolean
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className="math-display-toggle"
      disabled={disabled}
      aria-label={display ? "Make this an inline equation" : "Make this a display equation"}
      aria-pressed={display}
      onClick={onToggle}
    >
      Block
    </button>
  )
}

/**
 * A tap opens the TeX, on a phone as on a desktop. `mousedown` is prevented so
 * the editor does not first place a caret beside the node and then take the
 * focus back from the field.
 */
function MathEquation({ html, onOpen }: { html: string; onOpen: () => void }) {
  return (
    <span
      className="math-drawn"
      role="button"
      tabIndex={-1}
      aria-label="Edit equation"
      onMouseDown={(event) => {
        event.preventDefault()
        onOpen()
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
