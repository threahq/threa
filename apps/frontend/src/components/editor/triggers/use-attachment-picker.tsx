import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { createPortal } from "react-dom"
import type { Editor } from "@tiptap/react"
import { AttachmentPicker } from "./attachment-picker"
import {
  buildAttachmentPickerOptions,
  filterAttachmentPickerOptions,
  type AttachmentPickerOption,
} from "./attachment-picker-options"
import type { SuggestionListRef } from "./suggestion-list"
import type { PendingAttachment } from "@/hooks/use-attachments"
import type { AttachmentReferenceAttrs } from "../attachment-reference-extension"
import { composerPillDragNode, createComposerPillInsertTransaction } from "../composer-pill-drag-extension"

interface AttachmentPickerState {
  /** Doc position the `/attachment` text was removed from — where the reference lands. */
  anchorPos: number
  /** Text typed between `anchorPos` and the caret, used to filter the tray. */
  query: string
}

/** Rect of a fixed doc position, so the picker stays put as the filter is typed (INV-21). */
function posClientRect(editor: Editor | null, pos: number): DOMRect | null {
  if (!editor || editor.isDestroyed) return null
  try {
    const coords = editor.view.coordsAtPos(pos)
    return new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top)
  } catch {
    return null
  }
}

/**
 * Insert one attachment reference at `pos` through the tray drag's own
 * transaction, so a slash-inserted chip is the node a drop would have produced.
 */
export function insertAttachmentReferenceAt(editor: Editor, attrs: AttachmentReferenceAttrs, pos: number): boolean {
  const node = composerPillDragNode(editor.state, { kind: "tray", attachmentId: attrs.id, attrs })
  if (!node) return false
  const tr = createComposerPillInsertTransaction(editor.state, node, pos)
  if (!tr) return false
  editor.view.dispatch(tr)
  editor.commands.focus()
  return true
}

export function attachmentReferenceAttrs(attachment: PendingAttachment, imageIndex: number | null) {
  return {
    id: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    status: "uploaded" as const,
    imageIndex,
    error: null,
  }
}

export interface UseAttachmentPickerResult {
  /** Open the picker at the caret; call once the typed `/attachment` is removed. */
  openAttachmentPicker: () => void
  /** Render the picker portal — call in the editor's JSX. */
  renderAttachmentPicker: () => React.ReactNode
  /** Keyboard entry point for the host editor; true when the picker consumed the key. */
  handleAttachmentPickerKeyDown: (event: KeyboardEvent) => boolean
}

/**
 * Drives the `/attachment` picker. Like the command-argument picker it is not a
 * TipTap trigger: it opens programmatically after the slash entry is chosen,
 * tracks the filter by reading the doc between its anchor and the caret, and
 * routes keys through the host's `editorProps.handleKeyDown`.
 *
 * `onRequestUpload` hands the anchor position back to the host, which opens the
 * composer's file input and inserts the uploaded file there — the same upload
 * path the paperclip and pasted files use.
 */
export function useAttachmentPicker(
  editorRef: RefObject<Editor | null>,
  {
    attachments,
    onRequestUpload,
  }: {
    attachments: readonly PendingAttachment[]
    onRequestUpload?: (anchorPos: number) => void
  }
): UseAttachmentPickerResult {
  const [state, setState] = useState<AttachmentPickerState | null>(null)
  const stateRef = useRef<AttachmentPickerState | null>(null)
  stateRef.current = state
  const listRef = useRef<SuggestionListRef>(null)
  const onRequestUploadRef = useRef(onRequestUpload)
  onRequestUploadRef.current = onRequestUpload
  const isOpen = state !== null

  const openAttachmentPicker = useCallback(() => {
    const editor = editorRef.current
    if (!editor || editor.isDestroyed) return
    setState({ anchorPos: editor.state.selection.from, query: "" })
  }, [editorRef])

  const select = useCallback(
    (option: AttachmentPickerOption) => {
      const editor = editorRef.current
      const current = stateRef.current
      if (!editor || editor.isDestroyed || !current) return
      setState(null)

      // Drop the typed filter text; the reference lands where the command was.
      const caret = editor.state.selection.from
      const from = Math.min(current.anchorPos, caret)
      const to = Math.max(current.anchorPos, caret)
      if (to > from) editor.chain().focus().deleteRange({ from, to }).run()

      if (option.kind === "upload") {
        onRequestUploadRef.current?.(from)
        return
      }
      insertAttachmentReferenceAt(editor, attachmentReferenceAttrs(option.attachment, option.imageIndex), from)
    },
    [editorRef]
  )

  // Keep the filter in sync with what's typed after the command, and close when
  // the caret leaves the region. Same shape as the command-argument picker.
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

  const handleAttachmentPickerKeyDown = useCallback((event: KeyboardEvent): boolean => {
    if (!stateRef.current) return false
    if (event.key === "Escape") {
      setState(null)
      return true
    }
    return listRef.current?.onKeyDown(event) ?? false
  }, [])

  const trayOptions = useMemo(() => buildAttachmentPickerOptions(attachments), [attachments])
  const items = useMemo(
    () => (state ? filterAttachmentPickerOptions(trayOptions, state.query, !!onRequestUpload) : []),
    [state, trayOptions, onRequestUpload]
  )

  const renderAttachmentPicker = useCallback(() => {
    if (!state) return null
    return createPortal(
      <AttachmentPicker
        ref={listRef}
        items={items}
        clientRect={() => posClientRect(editorRef.current, state.anchorPos)}
        command={select}
      />,
      document.body
    )
  }, [state, items, select, editorRef])

  return { openAttachmentPicker, renderAttachmentPicker, handleAttachmentPickerKeyDown }
}
