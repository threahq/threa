import { useState, useEffect, useCallback, useRef, useId, useMemo } from "react"
import { Expand } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { RichEditor, EditorToolbar, EditorActionBar, DocumentEditorModal } from "@/components/editor"
import type { RichEditorHandle } from "@/components/editor"
import { useIsMobile } from "@/hooks/use-mobile"
import { usePendingMessages } from "@/contexts"
import { serializeToMarkdown, parseMarkdown } from "@threa/prosemirror"
import type { JSONContent } from "@threa/types"
import type { Editor } from "@tiptap/react"
import { EMPTY_DOC } from "@/lib/prosemirror-utils"

const MOD_KEY_NAME = navigator.platform?.toLowerCase().includes("mac") ? "Command" : "Control"

interface UnsentMessageEditFormProps {
  messageId: string
  /** The stream this message belongs to — scopes the `/memo` picker. */
  streamId: string
  initialContentJson?: JSONContent
  onDone: () => void
  authorName?: string
}

export function UnsentMessageEditForm({
  messageId,
  streamId,
  initialContentJson,
  onDone,
  authorName,
}: UnsentMessageEditFormProps) {
  const { saveEditedMessage, cancelEditing, deleteMessage } = usePendingMessages()
  const isMobile = useIsMobile()
  // The mobile stream composer hides itself via a CSS `:has()` rule whenever a
  // `[data-inline-edit]` element (rendered below) is present in the DOM — see
  // apps/frontend/src/index.css. This keeps composer visibility purely
  // DOM-derived instead of carrying a ref-counted React state that could leak
  // across hydration races or virtualisation cycles.

  const [contentJson, setContentJson] = useState<JSONContent>(initialContentJson ?? EMPTY_DOC)
  const [isSaving, setIsSaving] = useState(false)
  const [docEditorOpen, setDocEditorOpen] = useState(false)
  const [initialMarkdown] = useState(() => serializeToMarkdown(initialContentJson ?? EMPTY_DOC).trim())

  // Mobile drawer state
  const [formatOpen, setFormatOpen] = useState(false)
  const [mobileExpanded, setMobileExpanded] = useState(false)
  const [mobileLinkPopoverOpen, setMobileLinkPopoverOpen] = useState(false)
  const richEditorRef = useRef<RichEditorHandle>(null)
  const mobileActionBarRef = useRef<HTMLDivElement>(null)
  const [mobileToolbarEditor, setMobileToolbarEditor] = useState<Editor | null>(null)
  const instructionsId = useId()

  const handleCancel = useCallback(async () => {
    await cancelEditing(messageId)
    onDone()
  }, [messageId, cancelEditing, onDone])

  useEffect(() => {
    if (isMobile) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        void handleCancel()
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [isMobile, handleCancel])

  const setRichEditorHandle = useCallback((handle: RichEditorHandle | null) => {
    richEditorRef.current = handle
    const nextEditor = handle?.getEditor() ?? null
    setMobileToolbarEditor((currentEditor) => (currentEditor === nextEditor ? currentEditor : nextEditor))
  }, [])

  const handleSave = useCallback(async () => {
    const contentMarkdown = serializeToMarkdown(contentJson).trim()
    if (!contentMarkdown) {
      await cancelEditing(messageId)
      onDone()
      return
    }
    // No change — just cancel
    if (contentMarkdown === initialMarkdown) {
      await cancelEditing(messageId)
      onDone()
      return
    }
    setIsSaving(true)
    try {
      await saveEditedMessage(messageId, contentJson)
      onDone()
    } finally {
      setIsSaving(false)
    }
  }, [contentJson, initialMarkdown, messageId, saveEditedMessage, cancelEditing, onDone])

  const handleDelete = useCallback(async () => {
    await deleteMessage(messageId)
    onDone()
  }, [messageId, deleteMessage, onDone])

  const handleDocEditorSend = useCallback(
    async (markdown: string) => {
      const trimmed = markdown.trim()
      if (!trimmed) return
      if (trimmed === initialMarkdown) {
        setDocEditorOpen(false)
        await cancelEditing(messageId)
        onDone()
        return
      }
      setDocEditorOpen(false)
      setIsSaving(true)
      try {
        await saveEditedMessage(messageId, parseMarkdown(trimmed))
        onDone()
      } finally {
        setIsSaving(false)
      }
    },
    [initialMarkdown, messageId, saveEditedMessage, cancelEditing, onDone]
  )

  const handleDocEditorDismiss = useCallback((markdown: string) => {
    setContentJson(parseMarkdown(markdown))
  }, [])

  const screenReaderInstructions = useMemo(() => {
    if (isMobile) {
      return `Press ${MOD_KEY_NAME}+Enter to save. Tab and Shift+Tab indent content. Press Escape to leave the editor.`
    }
    return "Press Enter to save. Tab and Shift+Tab indent content. Press Escape to cancel editing."
  }, [isMobile])

  const focusMobileActionBar = useCallback(() => {
    mobileActionBarRef.current?.focus()
  }, [])

  if (isMobile) {
    const trailingContent = (
      <>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 px-2.5 text-xs text-destructive shrink-0"
          onPointerDown={(e) => e.preventDefault()}
          onClick={handleDelete}
          disabled={isSaving}
        >
          Delete
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 px-2.5 text-xs shrink-0"
          onPointerDown={(e) => e.preventDefault()}
          onClick={handleCancel}
          disabled={isSaving}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-8 px-3 text-xs shrink-0"
          onPointerDown={(e) => e.preventDefault()}
          onClick={handleSave}
          disabled={isSaving}
        >
          {isSaving ? "Saving..." : "Save"}
        </Button>
      </>
    )

    return (
      <Drawer
        open
        onOpenChange={(open) => {
          if (!open) setTimeout(() => void handleCancel(), 300)
        }}
      >
        <DrawerContent className={mobileExpanded ? "!h-[100dvh] rounded-t-none" : "max-h-[85dvh]"}>
          <DrawerTitle className="sr-only">Edit unsent message</DrawerTitle>
          <p id={instructionsId} className="sr-only">
            {screenReaderInstructions}
          </p>

          <div className="flex flex-col flex-1 min-h-0 px-4 pt-1">
            {authorName && <p className="text-[13px] font-semibold text-muted-foreground mb-1">{authorName}</p>}

            <div
              data-inline-edit
              className="flex-1 min-h-0 overflow-y-auto [&_.tiptap]:!pt-0 [&_.tiptap_p]:!leading-relaxed [&_.tiptap]:max-h-none [&_.tiptap]:min-h-full"
            >
              <RichEditor
                ref={setRichEditorHandle}
                value={contentJson}
                onChange={setContentJson}
                onSubmit={handleSave}
                placeholder="Edit message..."
                ariaLabel="Edit unsent message"
                ariaDescribedBy={instructionsId}
                messageSendMode="cmdEnter"
                autoFocus
                disableSelectionToolbar
                blurOnEscape
                onEscapeBlur={focusMobileActionBar}
                memoAnchorStreamId={streamId}
              />
            </div>
          </div>

          <div
            ref={mobileActionBarRef}
            className="px-4 pb-[max(8px,env(safe-area-inset-bottom))]"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
          >
            <EditorActionBar
              editorHandle={richEditorRef.current}
              disabled={isSaving}
              formatOpen={formatOpen}
              onFormatOpenChange={setFormatOpen}
              mobileExpanded={mobileExpanded}
              onMobileExpandedChange={setMobileExpanded}
              showAttach={false}
              trailingContent={trailingContent}
            />
            {formatOpen && (
              <EditorToolbar
                editor={mobileToolbarEditor}
                isVisible
                inline
                inlinePosition="below"
                linkPopoverOpen={mobileLinkPopoverOpen}
                onLinkPopoverOpenChange={setMobileLinkPopoverOpen}
                showSpecialInputControls
              />
            )}
          </div>
        </DrawerContent>
      </Drawer>
    )
  }

  // Desktop layout
  return (
    <>
      <p id={instructionsId} className="sr-only">
        {screenReaderInstructions}
      </p>
      <div data-inline-edit className="[&_.tiptap]:!pt-0 [&_.tiptap_p]:!leading-relaxed">
        <RichEditor
          value={contentJson}
          onChange={setContentJson}
          onSubmit={handleSave}
          placeholder="Edit message..."
          ariaLabel="Edit unsent message"
          ariaDescribedBy={instructionsId}
          autoFocus
          memoAnchorStreamId={streamId}
        />
      </div>
      <div className="flex items-center gap-1.5 mt-1">
        <span className="text-[11px] text-muted-foreground/70 hidden sm:flex items-center gap-1.5 mr-auto">
          <kbd className="kbd-hint">Esc</kbd> cancel
          <span className="text-muted-foreground/30">·</span>
          <kbd className="kbd-hint">↵</kbd> save
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => setDocEditorOpen(true)}
              disabled={isSaving}
            >
              <Expand className="h-3 w-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Expand editor</TooltipContent>
        </Tooltip>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-destructive"
          onClick={handleDelete}
          disabled={isSaving}
        >
          Delete
        </Button>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={handleCancel} disabled={isSaving}>
          Cancel
        </Button>
        <Button size="sm" className="h-6 px-2.5 text-xs" onClick={handleSave} disabled={isSaving}>
          {isSaving ? "Saving..." : "Save"}
        </Button>
      </div>
      <DocumentEditorModal
        open={docEditorOpen}
        onOpenChange={setDocEditorOpen}
        initialContent={serializeToMarkdown(contentJson)}
        onSend={handleDocEditorSend}
        onDismiss={handleDocEditorDismiss}
        streamName="edit"
      />
    </>
  )
}
