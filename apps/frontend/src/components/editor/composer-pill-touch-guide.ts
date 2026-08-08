import type { Node as ProseMirrorNode } from "@tiptap/pm/model"

const GUIDE_GAP_PX = 40
const GUIDE_VIEWPORT_MARGIN_PX = 12
const GUIDE_LABEL_MAX_LENGTH = 18

interface DropGuideContext {
  before: string
  after: string
}

const DROP_GUIDE_CONTEXT_CACHE = new WeakMap<ProseMirrorNode, Map<number, DropGuideContext>>()

function truncateGuideLabel(label: string, fromEnd: boolean): string {
  const characters = Array.from(label)
  if (characters.length <= GUIDE_LABEL_MAX_LENGTH) return label
  const kept = GUIDE_LABEL_MAX_LENGTH - 1
  return fromEnd ? `…${characters.slice(-kept).join("")}` : `${characters.slice(0, kept).join("")}…`
}

function guideLabelForText(text: string, fromEnd: boolean, rangeStart = 0, rangeEnd = text.length): string {
  let start = Math.max(0, rangeStart)
  let end = Math.min(text.length, rangeEnd)
  if (fromEnd) {
    while (end > start && /\s/u.test(text[end - 1] ?? "")) end--
    start = end
    while (start > rangeStart && !/\s/u.test(text[start - 1] ?? "")) start--
  } else {
    while (start < end && /\s/u.test(text[start] ?? "")) start++
    end = start
    while (end < rangeEnd && !/\s/u.test(text[end] ?? "")) end++
  }
  return truncateGuideLabel(text.slice(start, end), fromEnd)
}

function guideLabelForNode(node: ProseMirrorNode | null, fromEnd: boolean): string {
  if (!node) return ""
  if (node.isText) return guideLabelForText(node.text ?? "", fromEnd)

  let label = ""
  switch (node.type.name) {
    case "mention":
      label = typeof node.attrs.slug === "string" ? `@${node.attrs.slug}` : "Mention"
      break
    case "channelLink":
      label = typeof node.attrs.slug === "string" ? `#${node.attrs.slug}` : "Stream"
      break
    case "slashCommand":
      label = typeof node.attrs.name === "string" ? `/${node.attrs.name}` : "Command"
      break
    case "attachmentReference":
      label = typeof node.attrs.filename === "string" ? node.attrs.filename : "File"
      break
    case "memoEmbed":
      label = typeof node.attrs.title === "string" && node.attrs.title ? node.attrs.title : "Memory"
      break
    case "inAppLink":
      label = typeof node.attrs.name === "string" && node.attrs.name ? node.attrs.name : "Link"
      break
    case "giphyEmbed":
      label = typeof node.attrs.title === "string" && node.attrs.title ? node.attrs.title : "GIF"
      break
    case "emoji":
      label = typeof node.attrs.emoji === "string" ? node.attrs.emoji : "Emoji"
      break
  }
  return truncateGuideLabel(label, fromEnd)
}

function guideLabelBefore(parent: ProseMirrorNode, parentOffset: number): string {
  let searchOffset = parentOffset
  while (searchOffset > 0) {
    const { node, offset } = parent.childBefore(searchOffset)
    if (!node) return ""
    let label = ""
    if (node.isText) {
      label = guideLabelForText(node.text ?? "", true, 0, Math.min(node.nodeSize, searchOffset - offset))
    } else if (offset + node.nodeSize <= searchOffset) {
      label = guideLabelForNode(node, true)
    }
    if (label) return label
    if (offset >= searchOffset) return ""
    searchOffset = offset
  }
  return ""
}

function guideLabelAfter(parent: ProseMirrorNode, parentOffset: number): string {
  let searchOffset = parentOffset
  while (searchOffset < parent.content.size) {
    const { node, offset } = parent.childAfter(searchOffset)
    if (!node) return ""
    let label = ""
    if (node.isText) {
      label = guideLabelForText(node.text ?? "", false, Math.max(0, searchOffset - offset))
    } else if (offset >= searchOffset) {
      label = guideLabelForNode(node, false)
    }
    if (label) return label
    const nextOffset = offset + node.nodeSize
    if (nextOffset <= searchOffset) return ""
    searchOffset = nextOffset
  }
  return ""
}

function dropGuideContext(doc: ProseMirrorNode, pos: number): DropGuideContext {
  const $pos = doc.resolve(pos)
  let parentCache = DROP_GUIDE_CONTEXT_CACHE.get($pos.parent)
  if (!parentCache) {
    parentCache = new Map()
    DROP_GUIDE_CONTEXT_CACHE.set($pos.parent, parentCache)
  }
  const cached = parentCache.get($pos.parentOffset)
  if (cached) return cached

  const context = {
    before: guideLabelBefore($pos.parent, $pos.parentOffset),
    after: guideLabelAfter($pos.parent, $pos.parentOffset),
  }
  parentCache.set($pos.parentOffset, context)
  return context
}

/** Fixed contextual loupe that mirrors a touch drag's real document caret. */
export class ComposerPillTouchGuide {
  private guide: HTMLDivElement | null = null
  private before: HTMLSpanElement | null = null
  private after: HTMLSpanElement | null = null
  private contextKey = ""
  private width = 0
  private height = 32
  private x: number | null = null
  private y: number | null = null

  constructor(
    private readonly doc: Document,
    private readonly win: Window
  ) {}

  update(editorDoc: ProseMirrorNode, dropPos: number | null, x: number, y: number) {
    this.x = x
    this.y = y
    const guide = this.ensureGuide()
    if (dropPos === null) {
      guide.classList.add("composer-pill-touch-guide--hidden")
      return
    }

    const context = dropGuideContext(editorDoc, dropPos)
    const contextKey = `${context.before.length}:${context.before}${context.after}`
    const contextChanged = contextKey !== this.contextKey
    if (contextChanged) {
      this.before!.textContent = context.before
      this.after!.textContent = context.after
      this.contextKey = contextKey
    }
    guide.classList.remove("composer-pill-touch-guide--hidden")
    guide.style.left = `${x}px`

    if (this.width === 0 || contextChanged) {
      const rect = guide.getBoundingClientRect()
      this.width = rect.width
      this.height = rect.height || 32
    }
    const viewportWidth = this.win.innerWidth || this.doc.documentElement.clientWidth
    if (this.width > 0 && viewportWidth > 0) {
      const halfWidth = Math.min(this.width / 2, Math.max(0, (viewportWidth - GUIDE_VIEWPORT_MARGIN_PX * 2) / 2))
      const left = Math.max(
        GUIDE_VIEWPORT_MARGIN_PX + halfWidth,
        Math.min(x, viewportWidth - GUIDE_VIEWPORT_MARGIN_PX - halfWidth)
      )
      guide.style.left = `${left}px`
    }

    const placeBelow = y < this.height + GUIDE_GAP_PX + GUIDE_VIEWPORT_MARGIN_PX
    guide.classList.toggle("composer-pill-touch-guide--below", placeBelow)
    guide.style.top = `${placeBelow ? y + GUIDE_GAP_PX : y - GUIDE_GAP_PX}px`
  }

  refresh(editorDoc: ProseMirrorNode, dropPos: number | null) {
    if (this.x === null || this.y === null) return
    this.update(editorDoc, dropPos, this.x, this.y)
  }

  destroy() {
    this.guide?.remove()
    this.guide = null
    this.before = null
    this.after = null
    this.contextKey = ""
    this.width = 0
    this.height = 32
    this.x = null
    this.y = null
  }

  private ensureGuide(): HTMLDivElement {
    if (this.guide) return this.guide

    const guide = this.doc.createElement("div")
    guide.className = "composer-pill-touch-guide"
    guide.setAttribute("aria-hidden", "true")
    const before = this.doc.createElement("span")
    before.className = "composer-pill-touch-guide__context"
    const cursor = this.doc.createElement("span")
    cursor.className = "composer-pill-touch-guide__cursor"
    const after = this.doc.createElement("span")
    after.className = "composer-pill-touch-guide__context"
    guide.append(before, cursor, after)
    this.doc.body.appendChild(guide)
    this.guide = guide
    this.before = before
    this.after = after
    return guide
  }
}
