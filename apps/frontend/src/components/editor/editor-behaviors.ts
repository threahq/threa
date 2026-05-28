import { Extension, type Editor } from "@tiptap/react"
import type { Mark as ProseMirrorMark } from "@tiptap/pm/model"
import { TextSelection, type Transaction, Plugin } from "@tiptap/pm/state"
import type { EditorState } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"
import type { MessageSendMode } from "@threa/types"
import { deleteAdjacentInlineAtom, handleEnterTextBehavior, toggleMultilineBlock } from "./multiline-blocks"
import { matchesKeyBinding } from "@/lib/keyboard-shortcuts"

export interface EditorBehaviorsOptions {
  /** Ref to current send mode - using ref avoids stale closure in keyboard shortcuts */
  sendModeRef: { current: MessageSendMode }
  /** Ref to submit callback - using ref avoids stale closure in keyboard shortcuts */
  onSubmitRef: { current: () => void }
  /** Ref to effective editor formatting bindings (app-format: "mod+b"), with app-level conflicts already excluded */
  keyBindingsRef: { current: Record<string, string> }
}

// Tiptap's `.configure()` runs options through `mergeDeep`, which recursively
// clones plain `{ current: ... }` objects. That would detach the caller's
// React ref from the ref the extension reads inside its ProseMirror plugin,
// so later mutations to `ref.current` would never propagate. Wrapping the
// default in a prototype-less object makes `isPlainObject` return false for
// the target, causing `mergeDeep` to use the caller's ref by reference.
function createOptionRef<T>(initial: T): { current: T } {
  const ref = Object.create(null) as { current: T }
  ref.current = initial
  return ref
}

export function indentSelection(editor: Editor): boolean {
  if (editor.isActive("codeBlock")) {
    return handleCodeBlockTab(editor, false)
  }

  if (editor.isActive("listItem")) {
    return editor.chain().focus().sinkListItem("listItem").run()
  }

  return handleTextTab(editor, false)
}

export function dedentSelection(editor: Editor): boolean {
  if (editor.isActive("codeBlock")) {
    return handleCodeBlockTab(editor, true)
  }

  if (editor.isActive("listItem")) {
    return editor.chain().focus().liftListItem("listItem").run()
  }

  return handleTextTab(editor, true)
}

/**
 * Check if any suggestion popup is currently visible with items.
 *
 * Uses editor.storage.popupVisible (set by suggestion hooks) instead of raw
 * plugin state, so that dismissed popups (Escape) and zero-result queries
 * (e.g. `:)`) no longer block Enter from sending.
 */
export function isSuggestionActive(editor: Editor): boolean {
  const s = editor.storage as unknown as Record<string, { popupVisible?: boolean } | undefined>
  return !!(
    s.mention?.popupVisible ||
    s.channelLink?.popupVisible ||
    s.slashCommand?.popupVisible ||
    s.emoji?.popupVisible ||
    s.memoSearch?.popupVisible
  )
}

type EscapableInlineMarkName = "code" | "link"
type BoundaryNavigableInlineMarkName = "code"
type ArrowDirection = "left" | "right"
export type LinkToolbarAction = "opened" | "closed" | "exited"

interface CodeBoundaryDecorationState {
  pos: number
  edge: "start" | "end"
  mode: "inside" | "outside"
  side: -1 | 1
}

interface CodeBoundaryContext {
  codeMark: ProseMirrorMark
  edge: "start" | "end"
}

interface MeasuredCaretRect {
  height: number
  left: number
  top: number
}

function isTransparentColor(value: string | null | undefined): boolean {
  if (!value) {
    return false
  }

  return value === "transparent" || /^rgba?\([^)]*,\s*0\)$/.test(value)
}

function getEffectiveCursorMarks(state: EditorState): readonly ProseMirrorMark[] {
  return state.storedMarks ?? state.selection.$from.marks()
}

function findMarkByName(
  marks: readonly ProseMirrorMark[] | null | undefined,
  markName: EscapableInlineMarkName | BoundaryNavigableInlineMarkName
): ProseMirrorMark | undefined {
  return marks?.find((mark) => mark.type.name === markName)
}

function setStoredMarks(editor: Editor, marks: readonly ProseMirrorMark[] | null): boolean {
  const tr = editor.state.tr
  tr.setStoredMarks(marks ? [...marks] : null)
  editor.view.dispatch(tr)
  return true
}

function getCodeBoundaryContext(state: EditorState, pos: number): CodeBoundaryContext | null {
  const $pos = state.doc.resolve(pos)
  const beforeCode = findMarkByName($pos.nodeBefore?.marks ?? [], "code")
  const afterCode = findMarkByName($pos.nodeAfter?.marks ?? [], "code")

  if (!!beforeCode === !!afterCode) {
    return null
  }

  if (beforeCode) {
    return {
      codeMark: beforeCode,
      edge: "end",
    }
  }

  return {
    codeMark: afterCode!,
    edge: "start",
  }
}

function enterInlineMark(editor: Editor, boundaryMark: ProseMirrorMark): boolean {
  const currentMarks = getEffectiveCursorMarks(editor.state).filter((mark) => mark.type !== boundaryMark.type)
  return setStoredMarks(editor, [...currentMarks, boundaryMark])
}

function getCodeBoundaryDecorationState(state: EditorState): CodeBoundaryDecorationState | null {
  const { selection } = state

  if (!selection.empty) {
    return null
  }

  const { from } = selection
  const boundary = getCodeBoundaryContext(state, from)
  const isInsideCode = !!findMarkByName(getEffectiveCursorMarks(state), "code")

  if (!boundary) {
    return null
  }

  if (boundary.edge === "end") {
    return {
      pos: from,
      edge: "end",
      mode: isInsideCode ? "inside" : "outside",
      side: isInsideCode ? -1 : 1,
    }
  }

  return {
    pos: from,
    edge: boundary.edge,
    mode: isInsideCode ? "inside" : "outside",
    side: isInsideCode ? 1 : -1,
  }
}

function isSyntheticInlineCodeBoundary(
  boundary: CodeBoundaryDecorationState
): boundary is CodeBoundaryDecorationState & ({ edge: "start"; mode: "inside" } | { edge: "end"; mode: "outside" }) {
  return (
    (boundary.edge === "start" && boundary.mode === "inside") ||
    (boundary.edge === "end" && boundary.mode === "outside")
  )
}

function findNearestCodeElement(node: Node | null | undefined): HTMLElement | null {
  if (!node) {
    return null
  }

  if (node.nodeType === Node.TEXT_NODE) {
    return node.parentElement?.closest("code") ?? null
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null
  }

  const element = node as Element
  const closest = element.closest("code")
  if (closest instanceof HTMLElement) {
    return closest
  }

  const nested = element.querySelector("code")
  return nested instanceof HTMLElement ? nested : null
}

function getBoundaryCodeElement(view: EditorView, boundary: CodeBoundaryDecorationState): HTMLElement | null {
  const insideSide = boundary.edge === "start" ? 1 : -1
  const { node, offset } = view.domAtPos(boundary.pos, insideSide)
  const candidates: Node[] = [node]

  if (node.nodeType === Node.ELEMENT_NODE) {
    const element = node as Element
    const indexes = boundary.edge === "start" ? [offset, offset - 1, offset + 1] : [offset - 1, offset, offset - 2]

    for (const index of indexes) {
      if (index < 0 || index >= element.childNodes.length) {
        continue
      }

      candidates.push(element.childNodes[index])
    }
  }

  for (const candidate of candidates) {
    const codeElement = findNearestCodeElement(candidate)
    if (codeElement) {
      return codeElement
    }
  }

  return null
}

function getCodeBoundaryTextNodes(codeElement: HTMLElement): Text[] {
  const textNodes: Text[] = []
  const walker = codeElement.ownerDocument.createTreeWalker(codeElement, NodeFilter.SHOW_TEXT)
  let current: Node | null

  while ((current = walker.nextNode())) {
    if ((current.textContent?.length ?? 0) > 0) {
      textNodes.push(current as Text)
    }
  }

  return textNodes
}

function getRenderableClientRects(target: { getClientRects: () => DOMRectList }): DOMRect[] {
  return Array.from(target.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0)
}

function measureCollapsedCaretRect(document: Document, node: Node, offset: number): MeasuredCaretRect | null {
  const range = document.createRange()

  try {
    range.setStart(node, offset)
    range.setEnd(node, offset)
  } catch {
    return null
  }

  if (typeof range.getBoundingClientRect !== "function" || typeof range.getClientRects !== "function") {
    return null
  }

  const rect = range.getBoundingClientRect()
  if (rect.height > 0) {
    return {
      left: rect.left,
      top: rect.top,
      height: rect.height,
    }
  }

  const fallbackRect = range.getClientRects()[0]
  if (!fallbackRect || fallbackRect.height <= 0) {
    return null
  }

  return {
    left: fallbackRect.left,
    top: fallbackRect.top,
    height: fallbackRect.height,
  }
}

function getSyntheticInlineCodeBoundaryCaretRect(
  view: EditorView,
  boundary: CodeBoundaryDecorationState
): MeasuredCaretRect | null {
  if (!isSyntheticInlineCodeBoundary(boundary)) {
    return null
  }

  const codeElement = getBoundaryCodeElement(view, boundary)
  if (!codeElement) {
    return null
  }

  const document = codeElement.ownerDocument
  const textNodes = getCodeBoundaryTextNodes(codeElement)
  const codeRect = codeElement.getBoundingClientRect()
  const lastCodeRect = getRenderableClientRects(codeElement).at(-1) ?? codeRect
  const computedStyle = document.defaultView?.getComputedStyle(codeElement)
  const fallbackHeight =
    Number.parseFloat(computedStyle?.lineHeight ?? "") ||
    Number.parseFloat(computedStyle?.fontSize ?? "") ||
    codeRect.height ||
    16
  const fallbackTop = codeRect.top

  if (boundary.edge === "start") {
    const firstTextNode = textNodes[0]
    if (firstTextNode) {
      const firstCaretRect = measureCollapsedCaretRect(document, firstTextNode, 0)
      if (firstCaretRect) {
        return firstCaretRect
      }
    }

    return {
      left: codeRect.left + (Number.parseFloat(computedStyle?.paddingLeft ?? "") || 0),
      top: fallbackTop,
      height: fallbackHeight,
    }
  }

  const nextSibling = codeElement.nextSibling
  if (nextSibling instanceof Text) {
    const nextCaretRect = measureCollapsedCaretRect(document, nextSibling, 0)
    if (nextCaretRect) {
      return nextCaretRect
    }
  }

  const lastTextNode = textNodes[textNodes.length - 1]
  const insideEndRect = lastTextNode
    ? measureCollapsedCaretRect(document, lastTextNode, lastTextNode.data.length)
    : null

  if (insideEndRect) {
    return {
      left: lastCodeRect.right,
      top: insideEndRect.top,
      height: insideEndRect.height,
    }
  }

  return {
    left: lastCodeRect.right,
    top: lastCodeRect.top || fallbackTop,
    height: lastCodeRect.height || fallbackHeight,
  }
}

export function exitInlineMark(editor: Editor, markName: EscapableInlineMarkName): boolean {
  const { state } = editor

  if (!state.selection.empty) {
    return false
  }

  const currentMark = findMarkByName(getEffectiveCursorMarks(state), markName)
  if (!currentMark) {
    return false
  }

  const remainingMarks = getEffectiveCursorMarks(state).filter((mark) => mark.type !== currentMark.type)
  return setStoredMarks(editor, remainingMarks)
}

export function handleEscapableInlineMarkArrow(editor: Editor, direction: ArrowDirection): boolean {
  const { state } = editor
  const { selection } = state

  if (!selection.empty) {
    return false
  }

  const { $from } = selection
  const beforeMarks = $from.nodeBefore?.marks ?? []
  const afterMarks = $from.nodeAfter?.marks ?? []
  const effectiveMarks = getEffectiveCursorMarks(state)

  for (const markName of ["code"] as const satisfies readonly BoundaryNavigableInlineMarkName[]) {
    const beforeMark = findMarkByName(beforeMarks, markName)
    const afterMark = findMarkByName(afterMarks, markName)
    const isInsideMark = !!findMarkByName(effectiveMarks, markName)

    if (direction === "right") {
      if (beforeMark && !afterMark && isInsideMark) {
        return exitInlineMark(editor, markName)
      }

      if (!beforeMark && afterMark && !isInsideMark) {
        return enterInlineMark(editor, afterMark)
      }
    } else {
      if (beforeMark && !afterMark && !isInsideMark) {
        return enterInlineMark(editor, beforeMark)
      }

      if (!beforeMark && afterMark && isInsideMark) {
        return exitInlineMark(editor, markName)
      }
    }
  }

  return false
}

function moveCursorOntoInlineCodeBoundary(editor: Editor, direction: ArrowDirection): boolean {
  const { state } = editor
  const { selection } = state

  if (!selection.empty) {
    return false
  }

  const currentBoundary = getCodeBoundaryDecorationState(state)
  if (currentBoundary) {
    const movingAwayFromBoundaryIntoRealContent =
      (currentBoundary.edge === "start" && currentBoundary.mode === "inside" && direction === "right") ||
      (currentBoundary.edge === "end" && currentBoundary.mode === "inside" && direction === "left") ||
      (currentBoundary.edge === "start" && currentBoundary.mode === "outside" && direction === "left") ||
      (currentBoundary.edge === "end" && currentBoundary.mode === "outside" && direction === "right")

    if (movingAwayFromBoundaryIntoRealContent) {
      const targetPos = selection.from + (direction === "right" ? 1 : -1)
      if (targetPos >= 1 && targetPos <= state.doc.content.size) {
        const tr = state.tr
        tr.setSelection(TextSelection.create(state.doc, targetPos))
        tr.setStoredMarks(null)
        editor.view.dispatch(tr)
        return true
      }
    }
  }

  const targetPos = selection.from + (direction === "right" ? 1 : -1)
  if (targetPos < 1 || targetPos > state.doc.content.size) {
    return false
  }

  const boundary = getCodeBoundaryContext(state, targetPos)
  if (!boundary) {
    return false
  }

  const marksWithoutCode = getEffectiveCursorMarks(state).filter((mark) => mark.type.name !== "code")
  const shouldBeInside = direction === "right" ? boundary.edge === "end" : boundary.edge === "start"
  const nextMarks = shouldBeInside ? [...marksWithoutCode, boundary.codeMark] : marksWithoutCode
  const tr = state.tr

  tr.setSelection(TextSelection.create(state.doc, targetPos))
  tr.setStoredMarks(nextMarks)
  editor.view.dispatch(tr)
  return true
}

export function handleLinkToolbarAction(
  editor: Editor,
  linkPopoverOpen: boolean,
  onLinkPopoverOpenChange?: (open: boolean) => void
): LinkToolbarAction {
  if (linkPopoverOpen) {
    onLinkPopoverOpenChange?.(false)
    editor.commands.focus()
    return "closed"
  }

  if (exitInlineMark(editor, "link")) {
    return "exited"
  }

  onLinkPopoverOpenChange?.(true)
  return "opened"
}

/**
 * Dedent a single line - remove leading tab or up to 2 spaces
 */
function dedentLine(line: string): string {
  if (line.startsWith("\t")) {
    return line.slice(1)
  }
  const match = line.match(/^( {1,2})/)
  if (match) {
    return line.slice(match[1].length)
  }
  return line
}

/**
 * Handle tab/shift-tab in code blocks with VS Code-like behavior:
 * - No selection: Tab inserts tab, Shift+Tab dedents current line
 * - With selection: Tab/Shift+Tab indents/dedents all affected lines
 */
function handleCodeBlockTab(editor: Editor, dedent: boolean): boolean {
  const { state } = editor
  const { selection } = state
  const { from, to, empty } = selection

  const $from = selection.$from
  const codeBlockDepth = $from.depth
  const codeBlockStart = $from.start(codeBlockDepth)
  const codeBlockEnd = $from.end(codeBlockDepth)
  const codeBlock = $from.parent
  const text = codeBlock.textContent

  const startOffset = from - codeBlockStart
  const endOffset = to - codeBlockStart

  const originalLines = text.split("\n")
  const lines = [...originalLines]
  let charCount = 0
  let startLine = 0
  let endLine = 0
  const lineStarts: number[] = []

  for (let i = 0; i < lines.length; i++) {
    lineStarts.push(charCount)
    const lineEnd = charCount + lines[i].length

    if (startOffset >= charCount && startOffset <= lineEnd) {
      startLine = i
    }
    if (endOffset >= charCount && endOffset <= lineEnd) {
      endLine = i
    }
    charCount = lineEnd + 1
  }

  let totalDelta = 0

  if (empty) {
    if (dedent) {
      const original = lines[startLine]
      lines[startLine] = dedentLine(original)
      if (lines[startLine] === original) {
        return true
      }
      totalDelta = -(original.length - lines[startLine].length)
    } else {
      return editor.chain().focus().insertContent("\t").run()
    }
  } else {
    for (let i = startLine; i <= endLine; i++) {
      const original = lines[i]
      if (dedent) {
        lines[i] = dedentLine(original)
        const removed = original.length - lines[i].length
        totalDelta -= removed
      } else {
        if (original.length > 0) {
          lines[i] = "\t" + original
          totalDelta += 1
        }
      }
    }
  }

  const newText = lines.join("\n")
  const firstLineStart = codeBlockStart + lineStarts[startLine]

  return editor
    .chain()
    .focus()
    .command(({ tr, state: cmdState }: { tr: Transaction; state: EditorState }) => {
      const schema = cmdState.schema
      const newCodeBlock = schema.nodes.codeBlock.create(codeBlock.attrs, newText ? schema.text(newText) : null)

      tr.replaceWith(codeBlockStart - 1, codeBlockEnd + 1, newCodeBlock)

      if (empty) {
        const newPos = Math.max(codeBlockStart, from + totalDelta)
        tr.setSelection(TextSelection.create(tr.doc, newPos))
      } else {
        const newFrom = firstLineStart
        const newTo = Math.max(newFrom, to + totalDelta)
        tr.setSelection(TextSelection.create(tr.doc, newFrom, newTo))
      }

      return true
    })
    .run()
}

/**
 * Handle tab/shift-tab in regular text (paragraphs, headings, etc.)
 * - No selection: Tab inserts tab, Shift+Tab dedents current line
 * - With selection: Tab/Shift+Tab indents/dedents all affected blocks
 */
function handleTextTab(editor: Editor, dedent: boolean): boolean {
  const { state } = editor
  const { selection } = state
  const { from, to, empty } = selection
  const $from = selection.$from

  if (empty) {
    const textBlock = $from.parent
    if (!textBlock.isTextblock) {
      return false
    }

    const blockStart = $from.start()
    const text = textBlock.textContent

    if (dedent) {
      const newText = dedentLine(text)
      if (newText === text) {
        return true
      }
      const removed = text.length - newText.length

      return editor
        .chain()
        .focus()
        .command(({ tr }: { tr: Transaction }) => {
          tr.delete(blockStart, blockStart + removed)
          const newPos = Math.max(blockStart, from - removed)
          tr.setSelection(TextSelection.create(tr.doc, newPos))
          return true
        })
        .run()
    } else {
      return editor.chain().focus().insertContent("\t").run()
    }
  }

  return editor
    .chain()
    .focus()
    .command(({ tr, state: cmdState }: { tr: Transaction; state: EditorState }) => {
      const { doc } = cmdState

      const blocks: { start: number; text: string }[] = []
      doc.nodesBetween(from, to, (node, pos) => {
        if (node.isTextblock) {
          const start = pos + 1
          blocks.push({ start, text: node.textContent })
        }
      })

      if (blocks.length === 0) {
        return true
      }

      const firstBlockStart = blocks[0].start
      let totalDelta = 0

      for (let i = blocks.length - 1; i >= 0; i--) {
        const { start, text: blockText } = blocks[i]

        if (dedent) {
          const newText = dedentLine(blockText)
          if (newText !== blockText) {
            const removed = blockText.length - newText.length
            tr.delete(start, start + removed)
            totalDelta -= removed
          }
        } else {
          if (blockText.length > 0 || blocks.length === 1) {
            tr.insertText("\t", start)
            totalDelta += 1
          }
        }
      }

      const newFrom = firstBlockStart
      const newTo = Math.max(newFrom, to + totalDelta)
      tr.setSelection(TextSelection.create(tr.doc, newFrom, newTo))

      return true
    })
    .run()
}

/**
 * Keyboard behaviors for the rich text editor:
 * - Formatting shortcuts (Mod-B/I/E/etc) toggle marks
 * - Tab/Shift-Tab indent/dedent (VS Code-like with selection support)
 * - Enter handles list continuation, block exit, and send modes
 * - Shift+Enter has identical text behavior to Enter, but never sends
 */
export const EditorBehaviors = Extension.create<EditorBehaviorsOptions>({
  name: "editorBehaviors",

  // High priority ensures our keyboard shortcuts run before list/block extensions
  priority: 1000,

  addOptions() {
    return {
      sendModeRef: createOptionRef<MessageSendMode>("enter"),
      onSubmitRef: createOptionRef<() => void>(() => {}),
      keyBindingsRef: createOptionRef<Record<string, string>>({}),
    }
  },

  addProseMirrorPlugins() {
    const editor = this.editor
    const keyBindingsRef = this.options.keyBindingsRef

    const formattingPlugin = new Plugin({
      props: {
        handleKeyDown(_view: EditorView, event: KeyboardEvent) {
          const bindings = keyBindingsRef.current
          for (const [actionId, binding] of Object.entries(bindings)) {
            if (!matchesKeyBinding(event, binding)) continue

            switch (actionId) {
              case "formatBold":
                editor.chain().focus().toggleBold().run()
                return true
              case "formatItalic":
                editor.chain().focus().toggleItalic().run()
                return true
              case "formatStrike":
                editor.chain().focus().toggleStrike().run()
                return true
              case "formatCode":
                editor.chain().focus().toggleCode().run()
                return true
              case "formatCodeBlock":
                toggleMultilineBlock(editor, "codeBlock")
                return true
            }
          }
          return false
        },
      },
    })

    return [
      formattingPlugin,
      new Plugin({
        view(view) {
          const defaultView = view.dom.ownerDocument.defaultView
          let rafId: number | null = null
          const overlay = view.dom.ownerDocument.createElement("div")

          overlay.dataset.inlineCodeBoundaryOverlay = "true"
          overlay.style.position = "fixed"
          overlay.style.pointerEvents = "none"
          overlay.style.display = "none"
          overlay.style.width = "0"
          overlay.style.borderLeft = "1px solid currentColor"
          overlay.style.zIndex = "2147483647"
          overlay.style.transform = "translateX(-0.5px)"
          overlay.style.animation = "threa-inline-code-boundary-caret-blink 1.1s step-end infinite"
          view.dom.ownerDocument.body.append(overlay)

          const clearOverlay = () => {
            overlay.style.display = "none"
            view.dom.style.caretColor = ""
          }

          const syncNow = () => {
            const boundary = getCodeBoundaryDecorationState(view.state)

            if (!boundary || !view.hasFocus() || !view.editable || !isSyntheticInlineCodeBoundary(boundary)) {
              clearOverlay()
              return
            }

            const caretRect = getSyntheticInlineCodeBoundaryCaretRect(view, boundary)
            if (!caretRect) {
              clearOverlay()
              return
            }

            const computedStyle = defaultView?.getComputedStyle(view.dom)
            const caretColor =
              computedStyle?.caretColor &&
              computedStyle.caretColor !== "auto" &&
              !isTransparentColor(computedStyle.caretColor)
                ? computedStyle.caretColor
                : (computedStyle?.color ?? "currentColor")

            overlay.style.left = `${caretRect.left}px`
            overlay.style.top = `${caretRect.top}px`
            overlay.style.height = `${caretRect.height}px`
            overlay.style.borderLeftColor = caretColor
            overlay.style.display = "block"
            view.dom.style.caretColor = "transparent"
          }

          const scheduleSync = () => {
            syncNow()

            if (!defaultView) {
              return
            }

            if (rafId !== null) {
              defaultView.cancelAnimationFrame(rafId)
            }

            rafId = defaultView.requestAnimationFrame(() => {
              rafId = null
              syncNow()
            })
          }

          view.dom.addEventListener("focus", scheduleSync)
          view.dom.addEventListener("blur", clearOverlay)
          view.dom.ownerDocument.addEventListener("selectionchange", scheduleSync)
          defaultView?.addEventListener("resize", scheduleSync)
          defaultView?.addEventListener("scroll", scheduleSync, true)
          defaultView?.visualViewport?.addEventListener("resize", scheduleSync)
          defaultView?.visualViewport?.addEventListener("scroll", scheduleSync)

          scheduleSync()

          return {
            update: scheduleSync,
            destroy() {
              if (rafId !== null) {
                defaultView?.cancelAnimationFrame(rafId)
              }

              view.dom.removeEventListener("focus", scheduleSync)
              view.dom.removeEventListener("blur", clearOverlay)
              view.dom.ownerDocument.removeEventListener("selectionchange", scheduleSync)
              defaultView?.removeEventListener("resize", scheduleSync)
              defaultView?.removeEventListener("scroll", scheduleSync, true)
              defaultView?.visualViewport?.removeEventListener("resize", scheduleSync)
              defaultView?.visualViewport?.removeEventListener("scroll", scheduleSync)
              clearOverlay()
              overlay.remove()
            },
          }
        },
      }),
    ]
  },

  addKeyboardShortcuts() {
    return {
      ArrowLeft: () => {
        if (isSuggestionActive(this.editor)) {
          return false
        }

        return (
          handleEscapableInlineMarkArrow(this.editor, "left") || moveCursorOntoInlineCodeBoundary(this.editor, "left")
        )
      },
      ArrowRight: () => {
        if (isSuggestionActive(this.editor)) {
          return false
        }

        return (
          handleEscapableInlineMarkArrow(this.editor, "right") || moveCursorOntoInlineCodeBoundary(this.editor, "right")
        )
      },

      // Tab: VS Code-style indent (always trapped to prevent focus escape).
      // Inside a table cell we delegate to prosemirror-tables' Tab command so
      // the keyboard moves between cells (and adds a row at the last cell)
      // instead of inserting an indent character.
      Tab: () => {
        if (isSuggestionActive(this.editor)) {
          return false
        }

        if (this.editor.isActive("table")) {
          if (this.editor.commands.goToNextCell()) return true
          if (!this.editor.can().addRowAfter()) return true
          this.editor.chain().addRowAfter().goToNextCell().run()
          return true
        }

        indentSelection(this.editor)
        return true
      },

      // Shift+Tab: VS Code-style dedent (always trapped to prevent focus escape)
      "Shift-Tab": () => {
        if (this.editor.isActive("table")) {
          this.editor.commands.goToPreviousCell()
          return true
        }
        dedentSelection(this.editor)
        return true
      },

      // Cmd/Ctrl+A: select all within code block if inside one
      "Mod-a": () => {
        if (this.editor.isActive("codeBlock")) {
          const { selection } = this.editor.state
          const $from = selection.$from
          const codeBlockStart = $from.start($from.depth)
          const codeBlockEnd = $from.end($from.depth)

          const alreadySelectingAll = selection.from === codeBlockStart && selection.to === codeBlockEnd

          if (!alreadySelectingAll) {
            this.editor.chain().focus().setTextSelection({ from: codeBlockStart, to: codeBlockEnd }).run()
            return true
          }
        }
        return false
      },

      // Cmd/Ctrl+Enter: always send
      "Mod-Enter": () => {
        this.options.onSubmitRef.current()
        return true
      },

      // Shift+Enter: same text behavior as Enter, but never sends
      "Shift-Enter": () => {
        if (isSuggestionActive(this.editor)) {
          return false
        }
        return handleEnterTextBehavior(this.editor)
      },

      // Enter: in cmdEnter mode, creates newlines (same as Shift+Enter)
      // Note: "enter" send mode is handled in handleKeyDown (rich-editor.tsx) for fresh refs
      Enter: () => {
        if (isSuggestionActive(this.editor)) {
          return false
        }
        // cmdEnter mode: Enter creates newlines
        return handleEnterTextBehavior(this.editor)
      },

      // Backspace / Delete: collapse the browser's two-step atom selection on
      // Firefox Android (and any keydown-based mobile path) into one keystroke.
      // Returning false lets ProseMirror's default deletion run when the caret
      // isn't adjacent to an atom.
      Backspace: () => deleteAdjacentInlineAtom(this.editor, "backward"),
      Delete: () => deleteAdjacentInlineAtom(this.editor, "forward"),
    }
  },
})
