import { useEffect, useMemo, useRef, useState } from "react"
import { EditorContent, useEditor, type Editor } from "@tiptap/react"
import type * as Y from "yjs"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { createDocumentExtensions } from "@/components/editor/editor-extensions"
import { isSuggestionActive } from "@/components/editor/editor-behaviors"
import { isProseMirrorClipboardEvent } from "@/components/editor/editor-markdown"
import { serializeClipboardSlice } from "@/components/editor/clipboard-copy"
import { insertPlainText, isPlainTextPaste } from "@/components/editor/plain-text-paste"
import { insertFilesIntoEditor } from "@/components/editor/insert-files"
import {
  handleBeforeInputAtomDelete,
  handleBeforeInputGraphemeDelete,
  handleBeforeInputKeyboardPaste,
  handleBeforeInputNewline,
  insertPastedText,
} from "@/components/editor/multiline-blocks"
import { useMentionSuggestion, useChannelSuggestion, useEmojiSuggestion } from "@/components/editor/triggers"
import { EditorToolbar } from "@/components/editor/editor-toolbar"
import { useMentionables, useMarkdownTriggerLookups } from "@/hooks/use-mentionables"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { useAttachments } from "@/hooks/use-attachments"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import { useDocSync } from "./use-doc-sync"

const COLUMN_CLASS = "mx-auto w-full max-w-3xl px-4 sm:px-6"

// The composer's content styling, minus its height cap, so a doc renders blocks the way messages do.
const EDITOR_SURFACE_CLASS = cn(
  "w-full outline-none",
  "prose prose-sm dark:prose-invert max-w-none text-sm",
  "[&_p]:my-0 [&_p]:min-h-[1.5em]",
  "[&_ul]:my-1 [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:pl-5",
  "[&_li]:my-0 [&_li]:pl-0.5",
  "[&_pre]:my-2 [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-muted-foreground/30 [&_blockquote]:pl-4 [&_blockquote]:italic",
  "[&_h1]:text-xl [&_h1]:font-bold [&_h1]:my-2",
  "[&_h2]:text-lg [&_h2]:font-semibold [&_h2]:my-1.5",
  "[&_h3]:text-base [&_h3]:font-semibold [&_h3]:my-1",
  "focus:outline-none"
)

interface DocPaneBodyProps {
  workspaceId: string
  stream: { id: string }
  canWrite: boolean
}

/** A doc stream's collaborative editor, mounted only once the doc's state has loaded. */
export function DocPaneBody({ workspaceId, stream, canWrite }: DocPaneBodyProps) {
  const { ydoc, status, retry } = useDocSync(workspaceId, stream.id)

  if (status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-sm text-muted-foreground">This doc couldn't be loaded.</p>
        <Button variant="outline" size="sm" onClick={retry}>
          Retry
        </Button>
      </div>
    )
  }

  if (!ydoc || status === "loading") {
    return (
      <div className={cn(COLUMN_CLASS, "space-y-3 py-8")} aria-busy="true" aria-label="Loading doc">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    )
  }

  return <DocEditor key={ydoc.guid} workspaceId={workspaceId} ydoc={ydoc} canWrite={canWrite} />
}

interface DocEditorProps {
  workspaceId: string
  ydoc: Y.Doc
  canWrite: boolean
}

function DocEditor({ workspaceId, ydoc, canWrite }: DocEditorProps) {
  const isMobile = useIsMobile()
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false)

  const { mentionables } = useMentionables()
  const { getMentionType, isKnownChannel } = useMarkdownTriggerLookups(mentionables)
  const { suggestionConfig: mentionConfig, renderMentionList } = useMentionSuggestion()
  const { suggestionConfig: channelConfig, renderChannelList } = useChannelSuggestion()
  const { emojis, emojiWeights, toEmoji } = useWorkspaceEmoji(workspaceId)
  const { suggestionConfig: emojiConfig, renderEmojiGrid } = useEmojiSuggestion({ emojis, emojiWeights })
  const { uploadFile, imageCount } = useAttachments(workspaceId, { e2eEnabled: false })

  const getMentionTypeRef = useRef(getMentionType)
  const toEmojiRef = useRef(toEmoji)
  const uploadFileRef = useRef(uploadFile)
  const imageCountRef = useRef(imageCount)
  getMentionTypeRef.current = getMentionType
  toEmojiRef.current = toEmoji
  uploadFileRef.current = uploadFile
  imageCountRef.current = imageCount
  const markdownParseOptions = useMemo(() => ({ emojiAsText: true, isKnownChannel }), [isKnownChannel])
  const markdownParseOptionsRef = useRef(markdownParseOptions)
  markdownParseOptionsRef.current = markdownParseOptions
  const editorRef = useRef<Editor | null>(null)

  const insertFiles = (files: File[]) => {
    const editor = editorRef.current
    if (!editor?.isEditable) return false
    return insertFilesIntoEditor(editor, files, (file) => uploadFileRef.current(file))
  }

  const extensions = useMemo(
    () =>
      createDocumentExtensions({
        ydoc,
        placeholder: "Start writing…",
        mentionSuggestion: mentionConfig,
        channelSuggestion: channelConfig,
        emojiSuggestion: emojiConfig,
        toEmoji,
      }),
    [ydoc, mentionConfig, channelConfig, emojiConfig, toEmoji]
  )

  const editor = useEditor({
    extensions,
    editable: canWrite,
    editorProps: {
      attributes: { class: EDITOR_SURFACE_CLASS, "aria-label": "Doc" },
      clipboardTextSerializer: serializeClipboardSlice,
      handlePaste: (view, event) => {
        const pasteAsPlainText = isPlainTextPaste(view)
        if (!pasteAsPlainText && isProseMirrorClipboardEvent(event)) return false

        const files = event.clipboardData?.files
        if (files && files.length > 0) {
          event.preventDefault()
          let pastedImages = 0
          const named = Array.from(files).map((file) => {
            if (!file.type.startsWith("image/")) return file
            pastedImages++
            const ext = file.name.split(".").pop() || "png"
            return new File([file], `pasted-image-${imageCountRef.current + pastedImages}.${ext}`, { type: file.type })
          })
          return insertFiles(named)
        }

        const text = event.clipboardData?.getData("text/plain")
        if (!text || !editorRef.current) return false
        const insert = pasteAsPlainText ? insertPlainText : insertPastedText
        const handled = insert(
          editorRef.current,
          text,
          getMentionTypeRef.current,
          toEmojiRef.current,
          markdownParseOptionsRef.current
        )
        if (handled) event.preventDefault()
        return handled
      },
      handleDrop: (_view, event, _slice, moved) => {
        if (moved) return false
        const files = event.dataTransfer?.files
        if (!files || files.length === 0) return false
        event.preventDefault()
        return insertFiles(Array.from(files))
      },
      handleDOMEvents: {
        beforeinput: (_view, event) => {
          const current = editorRef.current
          if (!current) return false
          const inputEvent = event as InputEvent

          const suggestionActive = isSuggestionActive(current)
          if (handleBeforeInputNewline(current, inputEvent, { allowDuringComposition: suggestionActive })) return true
          if (suggestionActive) return false

          // Android atom deletion: keymap doesn't fire for Backspace, so delete
          // adjacent inline atoms here before the browser's two-step selection.
          if (handleBeforeInputAtomDelete(current, inputEvent)) return true

          // Firefox Android can delete emoji text by code unit, leaving a
          // broken half-grapheme. Delete the whole grapheme before native input.
          if (handleBeforeInputGraphemeDelete(current, inputEvent)) return true

          // Gboard / SwiftKey clipboard-bar paste arrives as insertText, not paste.
          return handleBeforeInputKeyboardPaste(
            current,
            inputEvent,
            getMentionTypeRef.current,
            toEmojiRef.current,
            markdownParseOptionsRef.current
          )
        },
      },
    },
  })
  editorRef.current = editor

  useEffect(() => {
    if (editor && editor.isEditable !== canWrite) editor.setEditable(canWrite)
  }, [editor, canWrite])

  return (
    <div className="flex h-full flex-col">
      {canWrite && (
        <div className={cn(COLUMN_CLASS, "shrink-0")}>
          <EditorToolbar
            editor={editor}
            isVisible
            inline
            inlinePosition="above"
            linkPopoverOpen={linkPopoverOpen}
            onLinkPopoverOpenChange={setLinkPopoverOpen}
            showSpecialInputControls={isMobile}
          />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn(COLUMN_CLASS, "flex min-h-full flex-col py-8")}>
          <EditorContent editor={editor} />
          {renderMentionList()}
          {renderChannelList()}
          {renderEmojiGrid()}
          {canWrite && (
            <div
              className="min-h-24 flex-1 cursor-text"
              aria-hidden="true"
              onMouseDown={(event) => {
                event.preventDefault()
                editor?.commands.focus("end")
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
