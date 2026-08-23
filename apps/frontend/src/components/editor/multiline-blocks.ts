import type { JSONContent, Editor } from "@tiptap/react"
import { Fragment, Slice, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model"
import { NodeSelection, Selection, type Transaction, type EditorState } from "@tiptap/pm/state"
import { parseMarkdown, type EmojiLookup, type MentionTypeLookup, type ParseMarkdownOptions } from "./editor-markdown"

export interface BeforeInputEventLike {
  inputType: string
  data?: string | null
  dataTransfer?: { getData(format: string): string } | null
  getTargetRanges?(): readonly { collapsed: boolean }[]
  preventDefault(): void
}

interface GraphemeSegment {
  from: number
  to: number
  text: string
}

// `@`/`#` cover mention and channel refs — emails like `a@b` are safe because
// the parser only converts the strict `@slug` shape. `[` covers markdown-link
// pair start; `<` covers our pointer URL syntax.
const PASTE_STYLING_CHARS = /[*_~`[:<@#]/

interface AncestorInfo {
  depth: number
  node: ProseMirrorNode
  pos: number
}

interface SelectedBlockInfo {
  index: number
  node: ProseMirrorNode
  pos: number
}

interface SelectedBlockRange {
  blocks: SelectedBlockInfo[]
}

interface DeleteAdjacentInlineAtomOptions {
  allowDuringComposition?: boolean
}

interface EditorViewWithDomObserver {
  domObserver?: {
    flush?: () => void
    forceFlush?: () => void
  }
  input?: {
    lastIOSEnter?: number
  }
}

interface FlushPendingDomOptions {
  cancelDeferred?: boolean
}

interface IntlSegmenterLike {
  segment(text: string): Iterable<{ segment: string; index: number }>
}

type IntlWithSegmenter = typeof Intl & {
  Segmenter?: new (
    locale?: string | string[],
    options?: { granularity: "grapheme" | "word" | "sentence" }
  ) => IntlSegmenterLike
}

let graphemeSegmenter: IntlSegmenterLike | null | undefined

function getGraphemeSegmenter(): IntlSegmenterLike | null {
  if (graphemeSegmenter !== undefined) return graphemeSegmenter

  const Segmenter = (Intl as IntlWithSegmenter).Segmenter
  graphemeSegmenter = Segmenter ? new Segmenter(undefined, { granularity: "grapheme" }) : null
  return graphemeSegmenter
}

function codePointSize(codePoint: number): number {
  return codePoint > 0xffff ? 2 : 1
}

function codePointAt(text: string, index: number): number | null {
  return index < text.length ? (text.codePointAt(index) ?? null) : null
}

function isVariationSelector(codePoint: number): boolean {
  return codePoint === 0xfe0e || codePoint === 0xfe0f || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
}

function isEmojiModifier(codePoint: number): boolean {
  return codePoint >= 0x1f3fb && codePoint <= 0x1f3ff
}

function isRegionalIndicator(codePoint: number): boolean {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff
}

function isCombiningMark(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  )
}

function consumeGraphemeExtenders(text: string, index: number): number {
  let cursor = index

  while (cursor < text.length) {
    const codePoint = codePointAt(text, cursor)
    if (
      codePoint === null ||
      (!isVariationSelector(codePoint) &&
        !isEmojiModifier(codePoint) &&
        !isCombiningMark(codePoint) &&
        codePoint !== 0x20e3)
    ) {
      break
    }
    cursor += codePointSize(codePoint)
  }

  return cursor
}

function fallbackGraphemeSegments(text: string): GraphemeSegment[] {
  const segments: GraphemeSegment[] = []
  let index = 0

  while (index < text.length) {
    const from = index
    const firstCodePoint = codePointAt(text, index)
    if (firstCodePoint === null) break

    index += codePointSize(firstCodePoint)
    index = consumeGraphemeExtenders(text, index)

    // Flags are pairs of regional indicators.
    if (isRegionalIndicator(firstCodePoint)) {
      const nextCodePoint = codePointAt(text, index)
      if (nextCodePoint !== null && isRegionalIndicator(nextCodePoint)) {
        index += codePointSize(nextCodePoint)
        index = consumeGraphemeExtenders(text, index)
      }
    }

    // Emoji ZWJ sequences should delete as one visible character.
    while (text.charCodeAt(index) === 0x200d) {
      index += 1
      const joinedCodePoint = codePointAt(text, index)
      if (joinedCodePoint === null) break
      index += codePointSize(joinedCodePoint)
      index = consumeGraphemeExtenders(text, index)
    }

    segments.push({ from, to: index, text: text.slice(from, index) })
  }

  return segments
}

function getGraphemeSegments(text: string): GraphemeSegment[] {
  const segmenter = getGraphemeSegmenter()
  if (!segmenter) return fallbackGraphemeSegments(text)

  return Array.from(segmenter.segment(text), ({ index, segment }) => ({
    from: index,
    to: index + segment.length,
    text: segment,
  }))
}

function isMultiCodeUnitGrapheme(segment: GraphemeSegment): boolean {
  return segment.to - segment.from > 1
}

function findGraphemeForDelete(
  text: string,
  offset: number,
  direction: "backward" | "forward"
): GraphemeSegment | null {
  const safeOffset = Math.max(0, Math.min(offset, text.length))
  const segments = getGraphemeSegments(text)

  if (direction === "backward") {
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const segment = segments[i]
      if (segment.from < safeOffset && segment.to >= safeOffset) return segment
      if (segment.to < safeOffset) return segment
    }
    return null
  }

  for (const segment of segments) {
    if (segment.from <= safeOffset && segment.to > safeOffset) return segment
    if (segment.from > safeOffset) return segment
  }
  return null
}

function findSplitGraphemeBoundary(text: string, offset: number): GraphemeSegment | null {
  if (offset <= 0 || offset >= text.length) return null
  return getGraphemeSegments(text).find((segment) => segment.from < offset && segment.to > offset) ?? null
}

function isEmptyParagraphNode(node: ProseMirrorNode | null | undefined): boolean {
  return !!node && node.type.name === "paragraph" && node.content.size === 0
}

function isDeletableInlineAtom(node: ProseMirrorNode): boolean {
  // Text nodes are leaf/atom nodes in ProseMirror, but normal character
  // deletion must stay on the browser/ProseMirror text path.
  return !node.isText && node.isInline && node.isAtom
}

function rangeContainsInlineAtom(state: EditorState, from: number, to: number): boolean {
  const docEnd = state.doc.content.size
  const rangeFrom = Math.max(0, Math.min(from, docEnd))
  const rangeTo = Math.max(rangeFrom, Math.min(to, docEnd))
  let containsAtom = false

  state.doc.nodesBetween(rangeFrom, rangeTo, (node) => {
    if (isDeletableInlineAtom(node)) {
      containsAtom = true
      return false
    }
    return !containsAtom
  })

  return containsAtom
}

// `cancelDeferred`: ProseMirror's own Chrome Android `deleteContentBackward`
// handler schedules a 20 ms deferred flush, and while that timer is pending a
// plain `flush()` is a no-op — exactly the window Gboard's enter-and-pick
// (delete word → insert correction → Enter, one batch) lands in.
function flushPendingDomSelection(editor: Editor, options: FlushPendingDomOptions = {}): void {
  const domObserver = (editor.view as unknown as EditorViewWithDomObserver).domObserver
  if (options.cancelDeferred) domObserver?.forceFlush?.()
  domObserver?.flush?.()
}

function deleteSelectionContainingInlineAtom(editor: Editor): boolean {
  const { state, view } = editor
  const { selection } = state
  if (selection.empty) return false
  if (!rangeContainsInlineAtom(state, selection.from, selection.to)) return false

  view.dispatch(state.tr.deleteSelection().scrollIntoView())
  return true
}

function expandPositionToGraphemeBoundary(state: EditorState, pos: number, side: "from" | "to"): number {
  let expanded = pos

  state.doc.descendants((node, nodePos) => {
    if (!node.isText || !node.text) return true

    const start = nodePos
    const end = nodePos + node.text.length
    if (pos <= start || pos >= end) return true

    const splitGrapheme = findSplitGraphemeBoundary(node.text, pos - start)
    if (splitGrapheme) {
      expanded = start + (side === "from" ? splitGrapheme.from : splitGrapheme.to)
      return false
    }

    return true
  })

  return expanded
}

function selectedRangeContainsMultiCodeUnitGrapheme(state: EditorState, from: number, to: number): boolean {
  let containsGrapheme = false

  state.doc.nodesBetween(from, to, (node, nodePos) => {
    if (!node.isText || !node.text) return !containsGrapheme

    const textFrom = Math.max(0, from - nodePos)
    const textTo = Math.min(node.text.length, to - nodePos)
    const selectedText = node.text.slice(textFrom, textTo)

    if (
      getGraphemeSegments(selectedText).some(isMultiCodeUnitGrapheme) ||
      !!findSplitGraphemeBoundary(node.text, textFrom) ||
      !!findSplitGraphemeBoundary(node.text, textTo)
    ) {
      containsGrapheme = true
      return false
    }

    return !containsGrapheme
  })

  return containsGrapheme
}

function deleteSelectionContainingMultiCodeUnitGrapheme(editor: Editor): boolean {
  const { state, view } = editor
  const { selection } = state
  if (selection.empty) return false
  if (!selectedRangeContainsMultiCodeUnitGrapheme(state, selection.from, selection.to)) return false

  const from = expandPositionToGraphemeBoundary(state, selection.from, "from")
  const to = expandPositionToGraphemeBoundary(state, selection.to, "to")

  view.dispatch(state.tr.delete(from, to).scrollIntoView())
  return true
}

function deleteAdjacentMultiCodeUnitGrapheme(editor: Editor, direction: "backward" | "forward"): boolean {
  const { state, view } = editor
  const { selection } = state
  if (!selection.empty) return false

  const $from = selection.$from
  if (!$from.parent.isTextblock) return false

  const parentText = $from.parent.textBetween(0, $from.parent.content.size, undefined, "\ufffc")
  const target = findGraphemeForDelete(parentText, $from.parentOffset, direction)
  if (!target || !isMultiCodeUnitGrapheme(target)) return false

  const from = $from.start() + target.from
  const to = $from.start() + target.to
  view.dispatch(state.tr.delete(from, to).scrollIntoView())
  return true
}

function getSelectedBlockRange(editor: Editor): SelectedBlockRange | null {
  const { state } = editor
  const { selection } = state
  if (selection.empty) {
    return null
  }

  const selectionEnd = Math.max(selection.to - 1, selection.from)
  const $to = state.doc.resolve(selectionEnd)
  const range = selection.$from.blockRange($to)
  if (!range) {
    return null
  }

  const parentPos = range.depth === 0 ? -1 : range.$from.before(range.depth)
  const blocks: SelectedBlockInfo[] = []

  range.parent.forEach((node, offset, index) => {
    if (index < range.startIndex || index >= range.endIndex) {
      return
    }

    blocks.push({
      index,
      node,
      pos: parentPos + 1 + offset,
    })
  })

  return blocks.length > 0 ? { blocks } : null
}

function findAncestor(editor: Editor, nodeName: "codeBlock" | "blockquote"): AncestorInfo | null {
  const { state } = editor
  const { selection } = state
  const selectionEnd = selection.empty ? selection.to : Math.max(selection.to - 1, selection.from)
  const $from = selection.$from
  const $to = state.doc.resolve(selectionEnd)

  let fromInfo: AncestorInfo | null = null
  let toInfo: AncestorInfo | null = null

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === nodeName) {
      fromInfo = {
        depth,
        node: $from.node(depth),
        pos: $from.before(depth),
      }
      break
    }
  }

  for (let depth = $to.depth; depth > 0; depth -= 1) {
    if ($to.node(depth).type.name === nodeName) {
      toInfo = {
        depth,
        node: $to.node(depth),
        pos: $to.before(depth),
      }
      break
    }
  }

  if (!fromInfo || !toInfo) {
    return null
  }

  if (fromInfo.pos !== toInfo.pos || fromInfo.depth !== toInfo.depth) {
    return null
  }

  return fromInfo
}

function createParagraphNode(schema: Schema, text: string): ProseMirrorNode {
  return schema.nodes.paragraph.create(null, text ? schema.text(text) : null)
}

function createCodeBlockNode(schema: Schema, attrs: Record<string, unknown>, lines: string[]): ProseMirrorNode {
  const text = lines.join("\n")
  return schema.nodes.codeBlock.create(attrs, text ? schema.text(text) : null)
}

function setSelectionNearInsertedContent(tr: Transaction, nodePos: number, offset: number) {
  const targetPos = Math.min(nodePos + offset, tr.doc.content.size)
  tr.setSelection(Selection.near(tr.doc.resolve(Math.max(1, targetPos)), 1))
}

function getCodeBlockLineRange(text: string, startOffset: number, endOffset: number) {
  const lines = text.split("\n")
  let charCount = 0
  let startLine = 0
  let endLine = 0

  for (let i = 0; i < lines.length; i += 1) {
    const lineEnd = charCount + lines[i].length

    if (startOffset >= charCount && startOffset <= lineEnd) {
      startLine = i
    }

    if (endOffset >= charCount && endOffset <= lineEnd) {
      endLine = i
    }

    charCount = lineEnd + 1
  }

  return { endLine, lines, startLine }
}

function toggleCodeBlockOff(editor: Editor): boolean {
  const ancestor = findAncestor(editor, "codeBlock")
  if (!ancestor) {
    return false
  }

  const { selection, schema } = editor.state
  const contentStart = ancestor.pos + 1
  const startOffset = selection.from - contentStart
  const endOffset = (selection.empty ? selection.from : Math.max(selection.to - 1, selection.from)) - contentStart
  const { lines, startLine, endLine } = getCodeBlockLineRange(ancestor.node.textContent, startOffset, endOffset)
  const removeWholeBlock = selection.empty && startLine === 0

  const beforeLines = removeWholeBlock ? [] : lines.slice(0, startLine)
  const selectedLines = removeWholeBlock ? lines : lines.slice(startLine, endLine + 1)
  const afterLines = removeWholeBlock ? [] : lines.slice(endLine + 1)

  const replacementNodes: ProseMirrorNode[] = []

  if (!removeWholeBlock && beforeLines.length > 0) {
    replacementNodes.push(createCodeBlockNode(schema, ancestor.node.attrs, beforeLines))
  }

  const selectedNodeIndex = replacementNodes.length
  replacementNodes.push(...selectedLines.map((line) => createParagraphNode(schema, line)))

  if (!removeWholeBlock && afterLines.length > 0) {
    replacementNodes.push(createCodeBlockNode(schema, ancestor.node.attrs, afterLines))
  }

  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.replaceWith(ancestor.pos, ancestor.pos + ancestor.node.nodeSize, Fragment.fromArray(replacementNodes))

      const leadingSize = replacementNodes.slice(0, selectedNodeIndex).reduce((total, node) => total + node.nodeSize, 0)

      setSelectionNearInsertedContent(tr, ancestor.pos, leadingSize + 1)
      return true
    })
    .run()
}

function getSelectedBlockquoteChildRange(editor: Editor, ancestor: AncestorInfo) {
  const { selection } = editor.state
  const selectionStart = selection.from
  const selectionEnd = selection.empty ? selection.from : Math.max(selection.to - 1, selection.from)
  const children: Array<{ node: ProseMirrorNode; pos: number }> = []
  let startIndex = -1
  let endIndex = -1

  ancestor.node.forEach((child, offset, index) => {
    const pos = ancestor.pos + 1 + offset
    const end = pos + child.nodeSize - 1
    const intersects = selectionStart <= end && selectionEnd >= pos

    children.push({ node: child, pos })

    if (!intersects) {
      return
    }

    if (startIndex === -1) {
      startIndex = index
    }

    endIndex = index
  })

  return { children, endIndex, startIndex }
}

function createBlockquoteNode(
  schema: Schema,
  attrs: Record<string, unknown>,
  children: Array<{ node: ProseMirrorNode }>
): ProseMirrorNode {
  return schema.nodes.blockquote.create(attrs, Fragment.fromArray(children.map((child) => child.node)))
}

function getFragmentChildren(fragment: Fragment): ProseMirrorNode[] {
  const nodes: ProseMirrorNode[] = []
  fragment.forEach((node) => {
    nodes.push(node)
  })
  return nodes
}

function wrapSelectedBlocksInCodeBlock(editor: Editor, blocks: SelectedBlockInfo[]): boolean {
  const { schema } = editor.state
  const firstBlock = blocks[0]
  const lastBlock = blocks[blocks.length - 1]
  const lines = blocks.map((block) => block.node.textContent)
  const codeBlock = createCodeBlockNode(schema, {}, lines)

  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.replaceWith(firstBlock.pos, lastBlock.pos + lastBlock.node.nodeSize, codeBlock)
      setSelectionNearInsertedContent(tr, firstBlock.pos, 1)
      return true
    })
    .run()
}

function wrapSelectedBlocksInBlockquote(editor: Editor, blocks: SelectedBlockInfo[]): boolean {
  const { schema } = editor.state
  const firstBlock = blocks[0]
  const lastBlock = blocks[blocks.length - 1]
  const children = blocks.flatMap((block) =>
    block.node.type.name === "blockquote"
      ? getFragmentChildren(block.node.content).map((node) => ({ node }))
      : [{ node: block.node }]
  )
  const blockquote = createBlockquoteNode(schema, {}, children)

  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.replaceWith(firstBlock.pos, lastBlock.pos + lastBlock.node.nodeSize, blockquote)
      setSelectionNearInsertedContent(tr, firstBlock.pos, 1)
      return true
    })
    .run()
}

function toggleCodeBlockOffAcrossSelection(editor: Editor, selectedRange: SelectedBlockRange): boolean {
  const { schema } = editor.state
  const { blocks } = selectedRange
  if (!blocks.every((block) => block.node.type.name === "codeBlock") || blocks.length <= 1) {
    return false
  }

  const firstBlock = blocks[0]
  const lastBlock = blocks[blocks.length - 1]
  const replacementNodes = blocks.flatMap((block) =>
    block.node.textContent.split("\n").map((line) => createParagraphNode(schema, line))
  )

  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.replaceWith(firstBlock.pos, lastBlock.pos + lastBlock.node.nodeSize, Fragment.fromArray(replacementNodes))
      setSelectionNearInsertedContent(tr, firstBlock.pos, 1)
      return true
    })
    .run()
}

function toggleBlockquoteOffAcrossSelection(editor: Editor, selectedRange: SelectedBlockRange): boolean {
  const { blocks } = selectedRange
  if (!blocks.every((block) => block.node.type.name === "blockquote") || blocks.length <= 1) {
    return false
  }

  const firstBlock = blocks[0]
  const lastBlock = blocks[blocks.length - 1]
  const replacementNodes = blocks.flatMap((block) => getFragmentChildren(block.node.content))

  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.replaceWith(firstBlock.pos, lastBlock.pos + lastBlock.node.nodeSize, Fragment.fromArray(replacementNodes))
      setSelectionNearInsertedContent(tr, firstBlock.pos, 1)
      return true
    })
    .run()
}

function toggleBlockquoteOff(editor: Editor): boolean {
  const ancestor = findAncestor(editor, "blockquote")
  if (!ancestor) {
    return false
  }

  const { selection, schema } = editor.state
  const { children, startIndex, endIndex } = getSelectedBlockquoteChildRange(editor, ancestor)

  if (startIndex === -1 || endIndex === -1) {
    return false
  }

  const removeWholeBlock = selection.empty && startIndex === 0
  const beforeChildren = removeWholeBlock ? [] : children.slice(0, startIndex)
  const selectedChildren = removeWholeBlock ? children : children.slice(startIndex, endIndex + 1)
  const afterChildren = removeWholeBlock ? [] : children.slice(endIndex + 1)

  const replacementNodes: ProseMirrorNode[] = []

  if (!removeWholeBlock && beforeChildren.length > 0) {
    replacementNodes.push(createBlockquoteNode(schema, ancestor.node.attrs, beforeChildren))
  }

  const selectedNodeIndex = replacementNodes.length
  replacementNodes.push(...selectedChildren.map((child) => child.node))

  if (!removeWholeBlock && afterChildren.length > 0) {
    replacementNodes.push(createBlockquoteNode(schema, ancestor.node.attrs, afterChildren))
  }

  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.replaceWith(ancestor.pos, ancestor.pos + ancestor.node.nodeSize, Fragment.fromArray(replacementNodes))

      const leadingSize = replacementNodes.slice(0, selectedNodeIndex).reduce((total, node) => total + node.nodeSize, 0)

      setSelectionNearInsertedContent(tr, ancestor.pos, leadingSize + 1)
      return true
    })
    .run()
}

export function toggleMultilineBlock(editor: Editor, nodeName: "codeBlock" | "blockquote"): boolean {
  const selectedRange = getSelectedBlockRange(editor)

  if (nodeName === "codeBlock" && selectedRange && toggleCodeBlockOffAcrossSelection(editor, selectedRange)) {
    return true
  }

  if (nodeName === "blockquote" && selectedRange && toggleBlockquoteOffAcrossSelection(editor, selectedRange)) {
    return true
  }

  if (!editor.isActive(nodeName)) {
    if (selectedRange && selectedRange.blocks.length > 1) {
      if (nodeName === "codeBlock") {
        return wrapSelectedBlocksInCodeBlock(editor, selectedRange.blocks)
      }

      return wrapSelectedBlocksInBlockquote(editor, selectedRange.blocks)
    }

    if (nodeName === "codeBlock") {
      return editor.chain().focus().toggleCodeBlock().run()
    }

    return editor.chain().focus().toggleBlockquote().run()
  }

  if (nodeName === "codeBlock") {
    return toggleCodeBlockOff(editor)
  }

  return toggleBlockquoteOff(editor)
}

export function canonicalContentSlice(schema: Schema, contentJson: JSONContent): Slice | null {
  try {
    const doc = schema.nodeFromJSON(contentJson)
    const blocks = [...doc.content.content]
    if (blocks.length === 0) return null
    if (blocks.length === 1 && blocks[0].type.name === "paragraph") {
      return blocks[0].content.size ? new Slice(blocks[0].content, 0, 0) : null
    }
    const fragment = Fragment.fromArray(blocks)
    return new Slice(
      fragment,
      blocks.every((block) => block.type.name === "paragraph") ? 1 : 0,
      blocks.every((block) => block.type.name === "paragraph") ? 1 : 0
    )
  } catch {
    return null
  }
}

function getParsedContent(
  text: string,
  getMentionType?: MentionTypeLookup,
  getEmoji?: EmojiLookup,
  parseOptions?: ParseMarkdownOptions
): JSONContent[] | undefined {
  return parseMarkdown(text, getMentionType, getEmoji, { emojiAsText: true, ...parseOptions }).content
}

export function insertPastedText(
  editor: Editor,
  text: string,
  getMentionType?: MentionTypeLookup,
  getEmoji?: EmojiLookup,
  parseOptions?: ParseMarkdownOptions
): boolean {
  const normalizedText = text.replace(/\r\n?/g, "\n")

  if (editor.isActive("codeBlock")) {
    return editor.chain().focus().insertContent(normalizedText).run()
  }

  if (editor.isActive("blockquote") && normalizedText.includes("\n")) {
    const content = getParsedContent(normalizedText, getMentionType, getEmoji, parseOptions)
    if (!content || content.length === 0) {
      return false
    }

    return editor.chain().focus().insertContent(content).run()
  }

  const blocks = getParsedContent(normalizedText, getMentionType, getEmoji, parseOptions)
  if (!blocks || blocks.length === 0) {
    return false
  }

  // When the parsed markdown is a single paragraph (the common case for pasted
  // plain text), unwrap to its inline content. Inserting a paragraph node mid-
  // paragraph makes ProseMirror split the current paragraph, producing stray
  // newlines around the paste. Inserting inline content lets tiptap route plain
  // text through `tr.insertText`, which also preserves the cursor's active
  // marks (bold, inline code, link, ...).
  if (blocks.length === 1 && blocks[0].type === "paragraph") {
    const inline = blocks[0].content
    return inline?.length ? editor.commands.insertContent(inline) : false
  }

  const slice = canonicalContentSlice(editor.state.schema, { type: "doc", content: blocks })
  if (!slice) return false
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.replaceSelection(slice)
      return true
    })
    .run()
}

/**
 * Handle Enter key press for creating newlines / smart block exits.
 * Shared by keyboard shortcuts and mobile beforeinput handling.
 */
export function handleEnterTextBehavior(editor: Editor): boolean {
  const { $from } = editor.state.selection

  // Check for ``` code block trigger
  if ($from.parent.isTextblock && !editor.isActive("codeBlock")) {
    const lineText = $from.parent.textContent
    const match = lineText.match(/^```(\w*)$/)
    if (match) {
      const language = match[1] || "plaintext"
      const start = $from.start()
      const end = $from.end()
      return editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.delete(start, end)
          return true
        })
        .setCodeBlock({ language })
        .run()
    }
  }

  // In lists: exit on empty item, otherwise split to create new item
  if (editor.isActive("listItem")) {
    const listItem = $from.node($from.depth - 1)
    if (listItem?.type.name === "listItem") {
      const isEmpty =
        listItem.childCount === 1 &&
        listItem.firstChild?.type.name === "paragraph" &&
        listItem.firstChild.content.size === 0

      if (isEmpty) {
        return editor.chain().focus().liftListItem("listItem").run()
      }
    }

    return editor.chain().focus().splitListItem("listItem").run()
  }

  // In code blocks: keep one blank line inside the block, exit on the third newline.
  if (editor.isActive("codeBlock")) {
    const codeBlock = $from.parent
    const text = codeBlock.textContent
    const atEnd = $from.pos === $from.end()
    const trailingNewlineMatch = text.match(/\n+$/u)

    if (atEnd && trailingNewlineMatch && trailingNewlineMatch[0].length >= 2) {
      return editor
        .chain()
        .focus()
        .command(({ tr, state }: { tr: Transaction; state: EditorState }) => {
          const pos = state.selection.$from.pos
          tr.delete(pos - trailingNewlineMatch[0].length, pos)
          return true
        })
        .exitCode()
        .run()
    }

    return editor.chain().focus().insertContent("\n").run()
  }

  // In blockquotes: allow one blank quoted paragraph, then exit on the next empty line.
  if (editor.isActive("blockquote")) {
    const paragraph = $from.parent
    if (isEmptyParagraphNode(paragraph)) {
      const blockquote = findAncestor(editor, "blockquote")
      const childIndex = blockquote ? $from.index(blockquote.depth) : -1
      const previousChild = blockquote && childIndex > 0 ? blockquote.node.child(childIndex - 1) : null

      if (isEmptyParagraphNode(previousChild)) {
        return editor.chain().focus().lift("blockquote").run()
      }
    }
    return editor.chain().focus().splitBlock().run()
  }

  return editor.chain().focus().splitBlock().run()
}

interface HandleBeforeInputNewlineOptions {
  allowDuringComposition?: boolean
}

/**
 * Mobile Enter. Chrome Android drops `keydown` Enter inside ProseMirror, so the
 * keystroke only surfaces here. Re-dispatch it as a keydown so the popovers,
 * pickers and the Enter keymap see the same single keystroke desktop does.
 * Flush the DOM observer first: Gboard's enter-and-pick deletes the word,
 * inserts the correction and presses Enter in one batch, so editor state can
 * still trail the DOM by a word — acting on the stale word is what used to eat
 * it (and left ProseMirror's 50 ms lost-backspace hack to join the new item
 * back, since it never saw a DOM change). Mid-composition the native
 * path is left alone (ProseMirror's own Android handling); only an open
 * popover overrides that, since it must claim Enter or the newline closes it.
 */
export function handleBeforeInputNewline(
  editor: Editor,
  event: BeforeInputEventLike,
  options: HandleBeforeInputNewlineOptions = {}
): boolean {
  if (event.inputType !== "insertParagraph" && event.inputType !== "insertLineBreak") {
    return false
  }

  const { view } = editor
  if (view.composing && !options.allowDuringComposition) return false

  flushPendingDomSelection(editor, { cancelDeferred: true })

  const keydown = new KeyboardEvent("keydown", { key: "Enter", shiftKey: event.inputType === "insertLineBreak" })
  const handled = !!view.someProp("handleKeyDown", (handleKeyDown) => handleKeyDown(view, keydown))
  if (handled) {
    event.preventDefault()
    // iOS Safari: ProseMirror lets the Return keydown through and arms a 200 ms
    // fallback that re-dispatches Enter unless a DOM change was read. Claiming
    // the newline here means no DOM change is read, so clear the marker the
    // same way ProseMirror does when it handles the Enter itself.
    const input = (view as unknown as EditorViewWithDomObserver).input
    if (input?.lastIOSEnter) input.lastIOSEnter = 0
  }

  return handled
}

/**
 * Delete the inline atom adjacent to the caret (or already wrapped in a
 * `NodeSelection`). Covers Firefox Android's first-Backspace promote-to-
 * selection step so the second tap isn't needed.
 */
export function deleteAdjacentInlineAtom(
  editor: Editor,
  direction: "backward" | "forward",
  options: DeleteAdjacentInlineAtomOptions = {}
): boolean {
  const { state, view } = editor
  if (view.composing && !options.allowDuringComposition) return false

  const { selection } = state
  if (selection instanceof NodeSelection && isDeletableInlineAtom(selection.node)) {
    view.dispatch(state.tr.deleteSelection().scrollIntoView())
    return true
  }
  if (!selection.empty) return false

  const $from = selection.$from
  const adjacent = direction === "backward" ? $from.nodeBefore : $from.nodeAfter
  if (!adjacent || !isDeletableInlineAtom(adjacent)) return false

  const from = direction === "backward" ? $from.pos - adjacent.nodeSize : $from.pos
  const to = direction === "backward" ? $from.pos : $from.pos + adjacent.nodeSize
  view.dispatch(state.tr.delete(from, to).scrollIntoView())
  return true
}

/**
 * `beforeinput` adapter for {@link deleteAdjacentInlineAtom}. Needed because
 * Android Chrome skips `keydown` for Backspace, so the keymap-based path
 * never runs and the browser would otherwise blur the editor mid-flow.
 */
export function handleBeforeInputAtomDelete(editor: Editor, event: BeforeInputEventLike): boolean {
  if (event.inputType !== "deleteContentBackward" && event.inputType !== "deleteContentForward") return false
  const direction = event.inputType === "deleteContentBackward" ? "backward" : "forward"

  // Firefox Android can update the native selection around an inline atom
  // before ProseMirror has observed it. Flush first so a native atom/range
  // selection becomes editor state before deciding whether to intercept.
  flushPendingDomSelection(editor)

  if (
    !deleteSelectionContainingInlineAtom(editor) &&
    !deleteAdjacentInlineAtom(editor, direction, { allowDuringComposition: true })
  ) {
    return false
  }

  event.preventDefault()
  return true
}

/**
 * Firefox Android can delete a text emoji one UTF-16 code unit at a time,
 * leaving a broken surrogate/variation fragment that shows up as the square
 * highlight. Only intercept multi-code-unit graphemes so normal text deletion
 * stays on the native ProseMirror path.
 */
export function handleBeforeInputGraphemeDelete(editor: Editor, event: BeforeInputEventLike): boolean {
  if (event.inputType !== "deleteContentBackward" && event.inputType !== "deleteContentForward") return false
  const direction = event.inputType === "deleteContentBackward" ? "backward" : "forward"

  flushPendingDomSelection(editor)

  if (
    !deleteSelectionContainingMultiCodeUnitGrapheme(editor) &&
    !deleteAdjacentMultiCodeUnitGrapheme(editor, direction)
  ) {
    return false
  }

  event.preventDefault()
  return true
}

/**
 * Catch Gboard / SwiftKey clipboard-bar pastes that the browser surfaces as
 * `insertText`, not `paste` (Marijn confirmed this is unfixable upstream:
 * https://discuss.prosemirror.net/t/transformpasted-doesnt-catch-pasted/8157).
 * Heuristic: 3+ chars containing a newline or markdown styling char, outside
 * composition and code blocks. Once matched we never fall back to TipTap's
 * default insert, which would silently drop mention / channel / emoji parsing.
 */
export function handleBeforeInputKeyboardPaste(
  editor: Editor,
  event: BeforeInputEventLike,
  getMentionType?: MentionTypeLookup,
  getEmoji?: EmojiLookup,
  parseOptions?: ParseMarkdownOptions
): boolean {
  // `insertFromPaste` / `insertReplacementText` reaching this handler means no
  // `paste` event was intercepted upstream (Android IMEs commit clipboard
  // suggestions this way); they are definitively pastes, so the size/styling
  // heuristic below is skipped for them.
  const isPasteLike = event.inputType === "insertFromPaste" || event.inputType === "insertReplacementText"
  if (event.inputType !== "insertText" && !isPasteLike) return false
  // Android spellcheck (tap squiggled word → pick suggestion) also arrives as
  // `insertReplacementText`, distinguished by a non-collapsed target range over
  // the word being replaced; intercepting would insert at the caret and keep the
  // misspelled word. Fall through so the native replacement applies.
  if (event.inputType === "insertReplacementText" && event.getTargetRanges?.().some((range) => !range.collapsed)) {
    return false
  }
  if (editor.view.composing) return false
  // Chromium on Android delivers large IME clipboard payloads with `data`
  // null and the text on `dataTransfer` instead.
  const data = event.data ?? event.dataTransfer?.getData("text/plain")
  if (!data) return false
  if (!isPasteLike) {
    if (data.length < 3) return false
    if (!data.includes("\n") && !PASTE_STYLING_CHARS.test(data)) return false
  }
  if (editor.isActive("codeBlock")) return false

  // The event is prevented before inserting, so a parse/insert failure must
  // never eat the payload — both fallbacks insert the raw text via
  // `tr.insertText`, which cannot reject or reinterpret any content shape
  // (`insertContent` would parse strings as HTML).
  const insertRawText = () =>
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText(data)
        return true
      })
      .run()

  event.preventDefault()
  try {
    if (!insertPastedText(editor, data, getMentionType, getEmoji, parseOptions)) {
      insertRawText()
    }
  } catch {
    insertRawText()
  }
  return true
}
