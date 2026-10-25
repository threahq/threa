import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react"
import { EditorContent, useEditor, type Editor } from "@tiptap/react"
import type * as Y from "yjs"
import type { Awareness } from "y-protocols/awareness"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { createDocumentExtensions } from "@/components/editor/editor-extensions"
import { EDITOR_CONTENT_CLASS } from "@/components/editor/editor-content-class"
import { EditorBehaviors, handleBeforeInput } from "@/components/editor/editor-behaviors"
import { isProseMirrorClipboardEvent } from "@/components/editor/editor-markdown"
import { serializeClipboardSlice } from "@/components/editor/clipboard-copy"
import { insertPlainText, isPlainTextPaste } from "@/components/editor/plain-text-paste"
import { insertFilesIntoEditor, namePastedImages } from "@/components/editor/insert-files"
import { insertPastedText } from "@/components/editor/multiline-blocks"
import { useMentionSuggestion, useChannelSuggestion, useEmojiSuggestion } from "@/components/editor/triggers"
import { EditorToolbar } from "@/components/editor/editor-toolbar"
import { usePreferences } from "@/contexts"
import { useRevealReady } from "@/contexts/coordinated-loading-context"
import { useMentionables, useMarkdownTriggerLookups } from "@/hooks/use-mentionables"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { useAttachments } from "@/hooks/use-attachments"
import { useIsMobile } from "@/hooks/use-mobile"
import { useLatest } from "@/hooks/use-latest"
import { getEffectiveEditorBindings } from "@/lib/keyboard-shortcuts"
import { cn } from "@/lib/utils"
import type { DocSyncView } from "./use-doc-sync"

const COLUMN_CLASS = "mx-auto w-full max-w-3xl px-4 sm:px-6"

const EDITOR_SURFACE_CLASS = cn("w-full outline-none text-sm", EDITOR_CONTENT_CLASS)

/** Text a dragged-off-page file also carries, which the browser drops as a link or text instead of opening the file. */
const DROPPABLE_TEXT_TYPES = ["text/plain", "text/uri-list", "text/html"]

// A doc has nothing to send: Enter is text and Mod+Enter is inert.
const DOC_SEND_MODE = { current: "cmdEnter" as const }
const NO_SUBMIT = { current: () => {} }

interface DocPaneBodyProps {
  workspaceId: string
  /** Null while the viewer's write access is unresolved. */
  canWrite: boolean | null
  view: DocSyncView
}

/** A doc stream's collaborative editor, mounted only once the doc's state and the viewer's write access have loaded. */
export function DocPaneBody({ workspaceId, canWrite, view }: DocPaneBodyProps) {
  useRevealReady(view.phase === "error" || (view.phase === "ready" && canWrite !== null))

  if (view.phase === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-sm text-muted-foreground">This doc couldn't be loaded.</p>
        <Button variant="outline" size="sm" onClick={view.retry}>
          Retry
        </Button>
      </div>
    )
  }

  if (view.phase === "loading" || canWrite === null) {
    return (
      <div className={cn(COLUMN_CLASS, "space-y-3 py-8")} aria-busy="true" aria-label="Loading doc">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    )
  }

  return (
    <DocEditor
      key={view.ydoc.guid}
      workspaceId={workspaceId}
      ydoc={view.ydoc}
      awareness={view.presence.awareness}
      canWrite={canWrite}
    />
  )
}

interface DocEditorProps {
  workspaceId: string
  ydoc: Y.Doc
  awareness: Awareness
  canWrite: boolean
}

function DocEditor({ workspaceId, ydoc, awareness, canWrite }: DocEditorProps) {
  const isMobile = useIsMobile()
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false)

  const { mentionables } = useMentionables()
  const { getMentionType, isKnownChannel } = useMarkdownTriggerLookups(mentionables)
  const { suggestionConfig: mentionConfig, renderMentionList } = useMentionSuggestion()
  const { suggestionConfig: channelConfig, renderChannelList } = useChannelSuggestion()
  const { emojis, emojiWeights, toEmoji } = useWorkspaceEmoji(workspaceId)
  const { suggestionConfig: emojiConfig, renderEmojiGrid } = useEmojiSuggestion({ emojis, emojiWeights })
  const { uploadFile, imageCount } = useAttachments(workspaceId, { e2eEnabled: false })

  const markdownParseOptions = useMemo(() => ({ emojiAsText: true, isKnownChannel }), [isKnownChannel])
  const latestLookups = useLatest({ getMentionType, toEmoji, parseOptions: markdownParseOptions })
  const latestUpload = useLatest({ uploadFile, imageCount })
  const editorRef = useRef<Editor | null>(null)
  const placeholderIdsRef = useRef(new Set<string>())
  const { preferences } = usePreferences()
  const customBindings = preferences?.keyboardShortcuts
  const keyBindingsRef = useRef<Record<string, string>>({})
  keyBindingsRef.current = useMemo(() => getEffectiveEditorBindings(customBindings ?? {}), [customBindings])

  const insertFiles = (files: File[]) => {
    const editor = editorRef.current
    if (!editor?.isEditable) return false
    return insertFilesIntoEditor(editor, files, (file) => latestUpload().uploadFile(file), {
      onPlaceholdersInserted: (tempIds) => tempIds.forEach((id) => placeholderIdsRef.current.add(id)),
      // An error chip would persist the uploader's failure into every reader's copy of the doc,
      // and undo must not bring the dead placeholder back.
      onUploadFailed: (tempId, error) => {
        editor
          .chain()
          .command(({ tr }) => {
            tr.setMeta("addToHistory", false)
            return true
          })
          .removeAttachmentReferences(tempId)
          .run()
        toast.error("Couldn't upload the file", { description: error instanceof Error ? error.message : undefined })
      },
    })
  }

  // Layout cleanup runs before the parent's passive cleanup stops the sync, so
  // removing never-settling placeholders still ships in the final flush.
  useLayoutEffect(() => {
    const placeholderIds = placeholderIdsRef.current
    return () => {
      const editor = editorRef.current
      if (!editor || editor.isDestroyed) return
      const stranded = new Set<string>()
      editor.state.doc.descendants((node) => {
        if (
          node.type.name === "attachmentReference" &&
          node.attrs.status === "uploading" &&
          placeholderIds.has(node.attrs.id)
        ) {
          stranded.add(node.attrs.id)
        }
      })
      stranded.forEach((id) => editor.commands.removeAttachmentReferences(id))
    }
  }, [])

  const extensions = useMemo(
    () => [
      ...createDocumentExtensions({
        ydoc,
        awareness,
        placeholder: "Start writing…",
        mentionSuggestion: mentionConfig,
        channelSuggestion: channelConfig,
        emojiSuggestion: emojiConfig,
        toEmoji,
      }),
      EditorBehaviors.configure({ sendModeRef: DOC_SEND_MODE, onSubmitRef: NO_SUBMIT, keyBindingsRef }),
    ],
    [ydoc, awareness, mentionConfig, channelConfig, emojiConfig, toEmoji]
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
          const handled = insertFiles(namePastedImages(Array.from(files), latestUpload().imageCount))
          if (handled) event.preventDefault()
          return handled
        }

        const text = event.clipboardData?.getData("text/plain")
        if (!text || !editorRef.current) return false
        const insert = pasteAsPlainText ? insertPlainText : insertPastedText
        const { getMentionType, toEmoji, parseOptions } = latestLookups()
        const handled = insert(editorRef.current, text, getMentionType, toEmoji, parseOptions)
        if (handled) event.preventDefault()
        return handled
      },
      handleDrop: (_view, event, _slice, moved) => {
        if (moved) return false
        const files = event.dataTransfer?.files
        if (!files || files.length === 0) return false
        const handled = insertFiles(Array.from(files))
        if (handled) event.preventDefault()
        return handled
      },
      handleDOMEvents: {
        beforeinput: (_view, event) => {
          const current = editorRef.current
          if (!current) return false
          return handleBeforeInput(current, event as InputEvent, latestLookups())
        },
      },
    },
  })
  editorRef.current = editor

  useEffect(() => {
    if (editor && editor.isEditable !== canWrite) editor.setEditable(canWrite)
  }, [editor, canWrite])

  // Files dropped beside the editor (the spacer, a read-only doc) would otherwise open in place of the app.
  const onDragOver = (event: DragEvent) => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault()
  }
  const onDrop = (event: DragEvent) => {
    if (event.defaultPrevented || event.dataTransfer.files.length === 0) return
    if (canWrite && editor) {
      editor.commands.focus("end")
      if (insertFiles(Array.from(event.dataTransfer.files))) {
        event.preventDefault()
        return
      }
    }
    if (!DROPPABLE_TEXT_TYPES.some((type) => event.dataTransfer.getData(type))) event.preventDefault()
  }

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
      <div className="min-h-0 flex-1 overflow-y-auto" onDragOver={onDragOver} onDrop={onDrop}>
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
