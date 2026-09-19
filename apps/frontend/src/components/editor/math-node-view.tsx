import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import katex from "katex"
import "katex/dist/katex.min.css"
import { KATEX_OPTIONS } from "@/lib/markdown/katex-options"
import { cn } from "@/lib/utils"
import type { MathAttrs } from "./math-extension"

/**
 * An equation in the composer: KaTeX until it is tapped, a TeX field while it
 * is being written, with the equation drawn live beside the field so what will
 * be sent is visible the whole time.
 *
 * Enter finishes it, Shift+Enter adds a line and makes it a display equation
 * (the only form that can hold one), and an empty field finishes by deleting
 * the node — so there is no way to leave an invisible equation behind.
 */
export function MathNodeView({ node, editor, getPos, decorations }: NodeViewProps) {
  const attrs = node.attrs as MathAttrs
  const editing = decorations.some((decoration) => decoration.spec?.mathEditing === true)

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
    // insertion: the caret is in the TeX, not in the message. Claimed again on
    // the next frame because the editor writes the node selection to the DOM
    // after this view mounts, which takes the focus straight back.
    const claim = () => {
      const input = field.current
      if (!input) return
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    }
    claim()
    const frame = requestAnimationFrame(claim)
    return () => cancelAnimationFrame(frame)
  }, [editing, attrs.tex, attrs.display])

  /**
   * `refocus` is false for the blur that ends editing because the click that
   * caused it is on its way somewhere else — taking the focus back would undo
   * the user's next action.
   */
  const commit = useCallback(
    (tex: string, asDisplay: boolean, refocus: boolean) => {
      if (committed.current) return
      const pos = getPos()
      if (pos === undefined) return
      committed.current = true
      editor.commands.commitMath(pos, { tex, display: asDisplay })
      if (refocus) editor.commands.focus()
    },
    [editor, getPos]
  )

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Nothing typed here is message input. Without this the composer's own
      // Enter would send the half-written equation.
      event.stopPropagation()
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        commit(draft, display, true)
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
        commit(draft, display, true)
        return
      }
      if (event.key === "Backspace" && draft === "") {
        event.preventDefault()
        commit("", display, true)
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
        <>
          <textarea
            ref={field}
            className="math-field"
            aria-label="Equation TeX"
            placeholder="TeX"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            rows={lines.length}
            style={display ? undefined : { width: `${columns}ch` }}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => commit(draft, display, false)}
          />
          {html ? <span className="math-drawn" dangerouslySetInnerHTML={{ __html: html }} /> : null}
        </>
      ) : (
        <MathEquation html={html} onOpen={() => editor.commands.openMathEditor(getPos() ?? 0)} />
      )}
    </NodeViewWrapper>
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
