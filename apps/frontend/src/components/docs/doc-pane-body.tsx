import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react"
import { EditorContent, useEditor, type Editor } from "@tiptap/react"
import type * as Y from "yjs"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import type { Awareness } from "y-protocols/awareness"
import { toast } from "sonner"
import { Paperclip } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Skeleton } from "@/components/ui/skeleton"
import { createDocumentExtensions } from "@/components/editor/editor-extensions"
import { EDITOR_CONTENT_CLASS } from "@/components/editor/editor-content-class"
import { EditorBehaviors, handleBeforeInput } from "@/components/editor/editor-behaviors"
import { isProseMirrorClipboardEvent } from "@/components/editor/editor-markdown"
import { serializeClipboardSlice } from "@/components/editor/clipboard-copy"
import { insertPlainText, isPlainTextPaste } from "@/components/editor/plain-text-paste"
import { insertFilesIntoEditor, namePastedImages } from "@/components/editor/insert-files"
import { insertPastedText } from "@/components/editor/multiline-blocks"
import {
  useMentionSuggestion,
  useChannelSuggestion,
  useEmojiSuggestion,
  useDocSuggestion,
  useDocCreateSuggestion,
} from "@/components/editor/triggers"
import { tryInsertDocChip } from "@/components/editor/in-app-link-chip"
import { EditorToolbar } from "@/components/editor/editor-toolbar"
import { ComposerPillDndProvider } from "@/components/editor/composer-pill-dnd"
import { ComposerPillActions } from "@/components/editor/composer-pill-actions"
import type { AttachmentReferenceAttrs } from "@/components/editor/attachment-reference-extension"
import { uploadGalleryType, type UploadGalleryType } from "@/components/gallery/upload-preview"
import { useGalleryAttachmentUrls, type GalleryUrlKind } from "@/components/gallery/use-gallery-attachment-urls"
import { MediaViewerContext, type MediaViewer } from "@/components/editor/media-viewer-context"
import { HistoryBackClose } from "@/components/ui/history-back-close"
import { MediaGallery, type GalleryItem } from "@/components/image-gallery"
import { attachmentContentUrl } from "@/api"
import { useMediaGallery } from "@/contexts/media-gallery-context"
import { usePreferences } from "@/contexts"
import { useRevealReady } from "@/contexts/coordinated-loading-context"
import { useMentionables, useMarkdownTriggerLookups } from "@/hooks/use-mentionables"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { useAttachments } from "@/hooks/use-attachments"
import { useIsMobile } from "@/hooks/use-mobile"
import { useInputMode } from "@/hooks/use-input-mode"
import { useLatest } from "@/hooks/use-latest"
import { getEffectiveEditorBindings } from "@/lib/keyboard-shortcuts"
import { cn } from "@/lib/utils"
import { useWorkspaceStream, type CachedStream } from "@/stores/workspace-store"
import type { DocSyncView } from "./use-doc-sync"
import { useDocBlockThreads } from "./use-doc-block-threads"
import { DocBlockGutter } from "./doc-block-gutter"
import { DocTitle } from "./doc-title"
import { DocBacklinks } from "./doc-backlinks"
import { useDocBlockLanding } from "./use-doc-block-landing"

const COLUMN_CLASS = "mx-auto w-full max-w-3xl px-4 sm:px-6"

const EDITOR_SURFACE_CLASS = cn("w-full outline-none text-sm", EDITOR_CONTENT_CLASS)

/** Text a dragged-off-page file also carries, which the browser drops as a link or text instead of opening the file. */
const DROPPABLE_TEXT_TYPES = ["text/plain", "text/uri-list", "text/html"]

// A doc has nothing to send: Enter is text and Mod+Enter is inert.
const DOC_SEND_MODE = { current: "cmdEnter" as const }
const NO_SUBMIT = { current: () => {} }

const pickDocHost = (row: CachedStream) => ({
  id: row.id,
  displayName: row.displayName,
  parentStreamId: row.parentStreamId,
})

interface DocPaneBodyProps {
  workspaceId: string
  docId: string
  /** Null while the viewer's write access is unresolved. */
  canWrite: boolean | null
  view: DocSyncView
}

/** A doc stream's collaborative editor, mounted only once the doc's state and the viewer's write access have loaded. */
export function DocPaneBody({ workspaceId, docId, canWrite, view }: DocPaneBodyProps) {
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
      docId={docId}
      joinCount={view.joinCount}
      ydoc={view.ydoc}
      awareness={view.presence.awareness}
      canWrite={canWrite}
      onBlur={view.flush}
    />
  )
}

interface DocEditorProps {
  workspaceId: string
  docId: string
  joinCount: number
  ydoc: Y.Doc
  awareness: Awareness
  canWrite: boolean
  onBlur: () => void
}

function DocEditor({ workspaceId, docId, joinCount, ydoc, awareness, canWrite, onBlur }: DocEditorProps) {
  const isMobile = useIsMobile()
  const isTouch = useInputMode() === "touch"
  const { openMedia } = useMediaGallery()
  const mediaViewer = useMemo<MediaViewer>(() => ({ open: openMedia, readOnly: !canWrite }), [openMedia, canWrite])
  const threads = useDocBlockThreads(workspaceId, docId, joinCount)
  const [column, setColumn] = useState<HTMLDivElement | null>(null)
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false)

  const { mentionables } = useMentionables()
  const { getMentionType, isKnownChannel } = useMarkdownTriggerLookups(mentionables)
  const { suggestionConfig: mentionConfig, renderMentionList } = useMentionSuggestion()
  const { suggestionConfig: channelConfig, renderChannelList } = useChannelSuggestion()
  const { emojis, emojiWeights, toEmoji } = useWorkspaceEmoji(workspaceId)
  const { suggestionConfig: emojiConfig, renderEmojiGrid } = useEmojiSuggestion({ emojis, emojiWeights })
  const docHost = useWorkspaceStream(workspaceId, docId, pickDocHost)?.parentStreamId ?? undefined
  const { suggestionConfig: docConfig, renderDocList } = useDocSuggestion(docHost, docId)
  const { docCreateOptions, renderDocCreateList } = useDocCreateSuggestion(docId, docId)
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
      mediaDisplay: "inline",
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
        docSearchSuggestion: docConfig,
        docCreate: docCreateOptions,
        toEmoji,
      }),
      EditorBehaviors.configure({ sendModeRef: DOC_SEND_MODE, onSubmitRef: NO_SUBMIT, keyBindingsRef }),
    ],
    [ydoc, awareness, mentionConfig, channelConfig, emojiConfig, docConfig, docCreateOptions, toEmoji]
  )

  const editor = useEditor({
    extensions,
    editable: canWrite,
    onBlur,
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
        if (!pasteAsPlainText && tryInsertDocChip(editorRef.current, text, { workspaceId, selfDocId: docId })) {
          event.preventDefault()
          return true
        }
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
          const inputEvent = event as InputEvent
          // Gboard / SwiftKey clipboard-bar pastes arrive as insertText, not paste.
          if (
            inputEvent.inputType === "insertText" &&
            !current.view.composing &&
            typeof inputEvent.data === "string" &&
            tryInsertDocChip(current, inputEvent.data, { workspaceId, selfDocId: docId })
          ) {
            event.preventDefault()
            return true
          }
          return handleBeforeInput(current, inputEvent, latestLookups())
        },
      },
    },
  })
  editorRef.current = editor
  useDocBlockLanding(editor, docId)

  useEffect(() => {
    if (editor && editor.isEditable !== canWrite) editor.setEditable(canWrite)
  }, [editor, canWrite])

  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!editor) return
    const onFocus = () => setFocused(true)
    const onBlur = () => setFocused(false)
    editor.on("focus", onFocus)
    editor.on("blur", onBlur)
    return () => {
      editor.off("focus", onFocus)
      editor.off("blur", onBlur)
    }
  }, [editor])

  // Files dropped beside the editor (the spacer, a read-only doc) would otherwise open in place of the app.
  const onDragOver = (event: DragEvent) => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault()
  }
  const fileInputRef = useRef<HTMLInputElement>(null)
  const onFilesPicked = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ""
    if (files.length === 0 || !editor) return
    editor.commands.focus()
    insertFiles(files)
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
    <MediaViewerContext.Provider value={mediaViewer}>
      <ComposerPillDndProvider editor={editor}>
        <div className="flex h-full flex-col" data-suppress-pull-refresh="true">
          {/* Back drops the caret before it leaves the doc; while the keyboard is up, Android spends that Back closing it. */}
          {isMobile && <HistoryBackClose open={focused} onClose={() => editor?.commands.blur()} />}
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
                touch={isTouch}
                trailingContent={<AttachButton touch={isTouch} onAttach={() => fileInputRef.current?.click()} />}
              />
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onFilesPicked} />
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain" onDragOver={onDragOver} onDrop={onDrop}>
            <div ref={setColumn} className={cn(COLUMN_CLASS, "relative flex min-h-full flex-col py-8 pr-10")}>
              <DocTitle
                workspaceId={workspaceId}
                docId={docId}
                canWrite={canWrite}
                onSubmit={() => editor?.commands.focus("start")}
                className="mb-4"
              />
              <EditorContent editor={editor} />
              <DocBlockGutter
                editor={editor}
                container={column}
                docId={docId}
                threads={threads}
                canComment={canWrite}
              />
              <DocBacklinks workspaceId={workspaceId} docId={docId} />
              {renderMentionList()}
              {renderChannelList()}
              {renderEmojiGrid()}
              {renderDocList()}
              {renderDocCreateList()}
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
        {canWrite && <ComposerPillActions editor={editor} />}
        <DocGallery editor={editor} workspaceId={workspaceId} />
      </ComposerPillDndProvider>
    </MediaViewerContext.Provider>
  )
}

/** Every attachment the gallery previews, in document order, whether it shows as media or as a chip. */
function docGalleryItems(doc: ProseMirrorNode, workspaceId: string, urls: Map<string, string>): GalleryItem[] {
  const items: GalleryItem[] = []
  const seen = new Set<string>()
  doc.descendants((node) => {
    if (node.type.name !== "attachmentReference") return
    const attrs = node.attrs as AttachmentReferenceAttrs
    const type = uploadGalleryType(attrs)
    if (!type || attrs.status !== "uploaded" || seen.has(attrs.id)) return
    seen.add(attrs.id)
    const base = { filename: attrs.filename, attachmentId: attrs.id }
    if (type === "image") {
      const thumbnailUrl = attachmentContentUrl(workspaceId, attrs.id, { variant: "thumbnail" })
      items.push({ ...base, type, url: attachmentContentUrl(workspaceId, attrs.id), thumbnailUrl })
    }
    // A reference does not carry the video's processing status, and until a thumbnail exists its variant URL serves
    // the video bytes, which an <img> cannot draw. The gallery shows its own play placeholder instead.
    else if (type === "video") items.push({ ...base, type, url: urls.get(attrs.id) ?? "", thumbnailUrl: "" })
    else items.push({ ...base, type, url: urls.get(attrs.id) ?? "" })
  })
  return items
}

/** Images load from content URLs; a video or a document needs a presigned URL for its bytes. */
function galleryUrlKind(type: UploadGalleryType | null): GalleryUrlKind {
  if (!type || type === "image") return null
  return type === "video" ? "video" : "document"
}

/** The doc's attachments, opened through the shared `?media=` param so Back closes them. */
function DocGallery({ editor, workspaceId }: { editor: Editor | null; workspaceId: string }) {
  const { mediaAttachmentId, openMedia, closeMedia } = useMediaGallery()
  const [doc, setDoc] = useState<ProseMirrorNode | null>(null)
  const open = mediaAttachmentId !== null

  useEffect(() => {
    if (!editor || !open) return
    const sync = () => setDoc(editor.state.doc)
    sync()
    editor.on("update", sync)
    return () => {
      editor.off("update", sync)
    }
  }, [editor, open])

  const selected = useMemo(() => {
    if (!doc || !mediaAttachmentId) return null
    let found: AttachmentReferenceAttrs | null = null
    doc.descendants((node) => {
      if (!found && node.type.name === "attachmentReference" && node.attrs.id === mediaAttachmentId) {
        found = node.attrs as AttachmentReferenceAttrs
      }
      return !found
    })
    return found
  }, [doc, mediaAttachmentId])
  const urls = useGalleryAttachmentUrls(
    workspaceId,
    mediaAttachmentId,
    galleryUrlKind(selected && uploadGalleryType(selected))
  )

  const items = useMemo(() => (doc ? docGalleryItems(doc, workspaceId, urls) : []), [doc, workspaceId, urls])
  const index = items.findIndex((item) => item.attachmentId === mediaAttachmentId)
  return (
    <MediaGallery
      isOpen={index !== -1}
      onClose={closeMedia}
      items={items}
      initialIndex={Math.max(0, index)}
      workspaceId={workspaceId}
      onItemChange={openMedia}
    />
  )
}

/** The doc's file picker, pinned after the formatting buttons so it never scrolls out of reach. */
function AttachButton({ touch, onAttach }: { touch: boolean; onAttach: () => void }) {
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Attach files"
      className={cn("shrink-0 p-0", touch ? "h-9 w-9" : "h-8 w-8")}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onAttach}
    >
      <Paperclip className="h-4 w-4" />
    </Button>
  )
  if (touch) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        Attach files
      </TooltipContent>
    </Tooltip>
  )
}
